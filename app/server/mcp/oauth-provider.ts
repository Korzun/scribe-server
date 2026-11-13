/**
 * The `OAuthServerProvider` the SDK's authorize/token/register/revoke
 * handlers drive, backed by the `mcp_*` tables through `tokens.ts`.
 *
 * Responsibilities split as the SDK expects: the handlers validate request
 * shape, client identity, redirect URIs and PKCE; this provider owns state.
 * `authorize` renders nothing — it hands the browser to the admin page's
 * `/connect` route, and the consent decision comes back through
 * `POST /api/v1/mcp/authorize` (routes/mcp-admin.ts), which writes the grant
 * and the browser-minted code this provider later exchanges.
 *
 * The exchange is where the key chain of spec §10 turns: the presented code
 * (or refresh token) opens the Library Key the browser (or the previous
 * exchange) sealed under it, the new pair is sealed under its own keys, and
 * the opened key is zeroed before the response leaves this function.
 */
import type { OAuthRegisteredClientsStore } from '@modelcontextprotocol/sdk/server/auth/clients.js';
import {
  InvalidGrantError,
  InvalidScopeError,
  InvalidTokenError,
} from '@modelcontextprotocol/sdk/server/auth/errors.js';
import type {
  AuthorizationParams,
  OAuthServerProvider,
} from '@modelcontextprotocol/sdk/server/auth/provider.js';
import type { AuthInfo } from '@modelcontextprotocol/sdk/server/auth/types.js';
import type {
  OAuthClientInformationFull,
  OAuthTokenRevocationRequest,
  OAuthTokens,
} from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PrismaClient } from '@prisma/client';
import type { Response } from 'express';

import type { TokenWrapKind } from '../crypto/seal';
import { consentUrl } from './base-url';
import {
  consumeAuthorizationCode,
  consumeRefreshToken,
  issueTokens,
  lookupAccessToken,
  openWrap,
  peekAuthorizationCode,
  revokeToken,
  sweepExpired,
  type McpScope,
} from './tokens';

export type OAuthProviderDeps = {
  prisma: PrismaClient;
  /** From `resolveMcpBaseUrl`: the admin page origin the consent page lives on. */
  baseUrl: URL;
  now?: () => number;
};

/**
 * Compares the token request's `resource` to the one the code was bound to.
 * RFC 8707: a code bound to a resource must be exchanged for the same one; a
 * code bound to none accepts any (or no) resource. Fragments and one trailing
 * slash are ignored, as the SDK's bearer middleware does.
 */
const sameResource = (bound: string | null, requested: URL | undefined): boolean => {
  if (bound === null) return true;
  if (requested === undefined) return false;
  const strip = (value: string) => value.split('#')[0].replace(/\/$/, '');
  return strip(bound) === strip(requested.href);
};

/**
 * Opens a row's wrap with the secret the client presented and reseals the key
 * under a fresh token pair. The key lives on the stack of this one call.
 */
async function reissueUnder(
  prisma: PrismaClient,
  secret: string,
  kind: TokenWrapKind,
  row: { grantId: string; libraryId: string; wrap: Uint8Array },
  scopes: readonly McpScope[],
  now: number
): Promise<OAuthTokens> {
  let key: Buffer;
  try {
    key = openWrap(secret, row.libraryId, kind, row.wrap);
  } catch {
    // The wrap was sealed for a different secret, or the row was tampered
    // with: either way this secret does not open the library.
    throw new InvalidGrantError('The presented credential does not open the library');
  }
  try {
    return await issueTokens(
      prisma,
      { grantId: row.grantId, libraryId: row.libraryId, libraryKey: key, scopes },
      now
    );
  } finally {
    key.fill(0);
  }
}

export function createOAuthProvider(deps: OAuthProviderDeps): OAuthServerProvider {
  const { prisma, baseUrl } = deps;
  const now = deps.now ?? Date.now;

  const clientsStore: OAuthRegisteredClientsStore = {
    async getClient(clientId) {
      const row = await prisma.mcpClient.findUnique({ where: { clientId } });
      if (row === null) return undefined;
      return JSON.parse(row.metadata) as OAuthClientInformationFull;
    },
    async registerClient(client) {
      // The SDK has already minted `client_id`/`client_id_issued_at` (and the
      // secret, when the auth method needs one) by the time this runs; its
      // parameter type omits them only to say "you may override". Stored
      // whole as JSON so `getClient` returns exactly what was registered.
      const full = client as OAuthClientInformationFull;
      await prisma.mcpClient.create({
        data: {
          clientId: full.client_id,
          clientSecret: full.client_secret ?? null,
          clientIdIssuedAt: full.client_id_issued_at ?? Math.floor(now() / 1000),
          clientSecretExpiresAt: full.client_secret_expires_at ?? null,
          metadata: JSON.stringify(full),
          createdAt: now(),
        },
      });
      return full;
    },
  };

  return {
    clientsStore,

    async authorize(
      client: OAuthClientInformationFull,
      params: AuthorizationParams,
      res: Response
    ): Promise<void> {
      const target = consentUrl(baseUrl);
      target.searchParams.set('client_id', client.client_id);
      target.searchParams.set('redirect_uri', params.redirectUri);
      target.searchParams.set('code_challenge', params.codeChallenge);
      if (params.state !== undefined) target.searchParams.set('state', params.state);
      if (params.scopes !== undefined && params.scopes.length > 0) {
        target.searchParams.set('scope', params.scopes.join(' '));
      }
      if (params.resource !== undefined) target.searchParams.set('resource', params.resource.href);
      res.redirect(302, target.href);
    },

    async challengeForAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string
    ): Promise<string> {
      const peeked = await peekAuthorizationCode(prisma, authorizationCode, now());
      if (peeked === null || peeked.clientId !== client.client_id) {
        throw new InvalidGrantError('Unknown or expired authorization code');
      }
      return peeked.codeChallenge;
    },

    async exchangeAuthorizationCode(
      client: OAuthClientInformationFull,
      authorizationCode: string,
      _codeVerifier?: string,
      redirectUri?: string,
      resource?: URL
    ): Promise<OAuthTokens> {
      await sweepExpired(prisma, now());
      const consumed = await consumeAuthorizationCode(prisma, authorizationCode, now());
      if (consumed === null || consumed.clientId !== client.client_id) {
        throw new InvalidGrantError('Unknown or expired authorization code');
      }
      if (redirectUri !== undefined && redirectUri !== consumed.redirectUri) {
        throw new InvalidGrantError('redirect_uri does not match the authorization request');
      }
      if (!sameResource(consumed.resource, resource)) {
        throw new InvalidGrantError('resource does not match the authorization request');
      }
      return reissueUnder(prisma, authorizationCode, 'code', consumed, consumed.scopes, now());
    },

    async exchangeRefreshToken(
      client: OAuthClientInformationFull,
      refreshToken: string,
      scopes?: string[]
    ): Promise<OAuthTokens> {
      await sweepExpired(prisma, now());
      const consumed = await consumeRefreshToken(prisma, refreshToken, now());
      if (consumed === null || consumed.clientId !== client.client_id) {
        throw new InvalidGrantError('Unknown or expired refresh token');
      }
      let granted: McpScope[] = consumed.scopes;
      if (scopes !== undefined && scopes.length > 0) {
        const outside = scopes.filter((s) => !(consumed.scopes as string[]).includes(s));
        if (outside.length > 0) {
          throw new InvalidScopeError(`Scope not granted: ${outside.join(' ')}`);
        }
        granted = consumed.scopes.filter((s) => scopes.includes(s));
      }
      return reissueUnder(prisma, refreshToken, 'refresh', consumed, granted, now());
    },

    async verifyAccessToken(token: string): Promise<AuthInfo> {
      const info = await lookupAccessToken(prisma, token, now());
      if (info === null) throw new InvalidTokenError('Unknown, expired or revoked token');
      return {
        token,
        clientId: info.clientId,
        scopes: info.scopes,
        expiresAt: Math.floor(info.expiresAt / 1000),
        extra: { grantId: info.grantId, libraryId: info.libraryId },
      };
    },

    async revokeToken(
      _client: OAuthClientInformationFull,
      request: OAuthTokenRevocationRequest
    ): Promise<void> {
      await revokeToken(prisma, request.token);
    },
  };
}
