import { redirectUriMatches } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import type { OAuthClientInformationFull } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../logger';
import {
  clientDisplay,
  createAuthorizationCode,
  deleteGrant,
  listGrants,
  resolveGrantedScopes,
  upsertGrant,
} from '../mcp/tokens';
import { ownerAuth } from '../middleware/owner-auth';
import { getLibrary } from '../services/library';
import type { JwtSecret } from '../services/token';
import { withVaultWriter } from '../services/vault-gate';
import { sealedWrap } from './library';

const log = logger('McpAdminRoute');

export type McpAdminRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  now: () => number;
  /** Whether `/mcp` is served; consent is refused when it is not. */
  mcpEnabled: boolean;
};

/**
 * The consent decision (spec §10). The SDK's authorize endpoint already
 * validated the client and redirect URI once before sending the browser to
 * `/connect`, but the page hands the parameters back as a request body, and a
 * body is a claim: everything is re-checked here against the client's
 * registration before a code is written, and before a DENY redirect too, so
 * this route can never be used to bounce a browser to an unregistered URL.
 *
 * The browser mints the authorization code itself and sends only its hash
 * and the Library Key sealed under it; the vault never sees the code, so the
 * redirect URL it answers with carries `state` and nothing else, and the page
 * appends `code` before following it.
 */
const authorizeBody = z.object({
  clientId: z.string().min(1).max(200),
  redirectUri: z.url().max(2000),
  codeChallenge: z.string().min(1).max(128),
  state: z.string().max(2000).nullish(),
  scope: z.string().max(200).nullish(),
  resource: z.url().max(2000).nullish(),
  approve: z.boolean(),
  codeHash: z
    .string()
    .regex(/^[0-9a-f]{64}$/)
    .optional(),
  wrap: sealedWrap().optional(),
});

export const MCP_NOT_ENABLED = 'MCP is not enabled';

/**
 * The owner's side of the remote MCP (spec §10): what the consent page needs
 * to know about a client, the consent decision, the list of connected
 * assistants, and Disconnect. Owner auth throughout, like the rest of the
 * admin API. Nothing here logs a hash, a wrap or a redirect URI: client and
 * grant ids only.
 */
export function createMcpAdminRouter({
  prisma,
  jwtSecret,
  now,
  mcpEnabled,
}: McpAdminRouterDeps): Router {
  const router = Router();
  const auth = ownerAuth({ prisma, jwtSecret, now });

  const getClient = async (clientId: string) => {
    const row = await prisma.mcpClient.findUnique({ where: { clientId } });
    if (row === null) return null;
    return {
      ...clientDisplay(row.metadata),
      registered: JSON.parse(row.metadata) as OAuthClientInformationFull,
    };
  };

  router.get('/mcp/clients/:clientId', auth, async (req, res, next) => {
    try {
      if (!mcpEnabled) {
        res.status(404).json({ error: MCP_NOT_ENABLED });
        return;
      }
      const clientId = String(req.params.clientId);
      const client = await getClient(clientId);
      if (client === null) {
        res.status(404).json({ error: 'Unknown client' });
        return;
      }
      res.json({ clientId, clientName: client.clientName, clientUri: client.clientUri });
    } catch (err) {
      next(err);
    }
  });

  router.post('/mcp/authorize', auth, async (req, res, next) => {
    try {
      if (!mcpEnabled) {
        res.status(404).json({ error: MCP_NOT_ENABLED });
        return;
      }
      const parsed = authorizeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const data = parsed.data;
      const library = await getLibrary(prisma);
      if (library === null) {
        res.status(404).json({ error: 'No library' });
        return;
      }
      const client = await getClient(data.clientId);
      if (client === null) {
        res.status(400).json({ error: 'Unknown client' });
        return;
      }
      if (
        !client.registered.redirect_uris.some((registered) =>
          redirectUriMatches(data.redirectUri, registered)
        )
      ) {
        res.status(400).json({ error: 'Unregistered redirect URI' });
        return;
      }

      const redirect = new URL(data.redirectUri);
      if (data.state != null) redirect.searchParams.set('state', data.state);

      if (!data.approve) {
        redirect.searchParams.set('error', 'access_denied');
        redirect.searchParams.set('error_description', 'The user denied the request');
        log.info(`MCP connection denied: client ${data.clientId}`);
        res.json({ redirectUrl: redirect.href });
        return;
      }

      if (data.codeHash === undefined || data.wrap === undefined) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      let scopes;
      try {
        scopes = resolveGrantedScopes(
          data.scope == null ? undefined : data.scope.split(' ').filter((s) => s !== '')
        );
      } catch {
        res.status(400).json({ error: 'No supported scope was requested' });
        return;
      }

      const { codeHash, wrap } = data;
      const granted = await withVaultWriter(req.vaultEpoch, async () => {
        const grant = await upsertGrant(
          prisma,
          { libraryId: library.id, clientId: data.clientId, scopes },
          now()
        );
        try {
          await createAuthorizationCode(
            prisma,
            {
              grantId: grant.id,
              redirectUri: data.redirectUri,
              codeChallenge: data.codeChallenge,
              resource: data.resource ?? null,
              codeHash,
              wrap,
            },
            now()
          );
        } catch {
          // A code hash this vault has already seen: the browser must mint
          // afresh, never reuse one.
          return null;
        }
        return grant;
      });
      if (granted === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      log.info(`MCP connection approved: client ${data.clientId}, grant ${granted.id}`);
      res.json({ redirectUrl: redirect.href });
    } catch (err) {
      next(err);
    }
  });

  router.get('/mcp/grants', auth, async (_req, res, next) => {
    try {
      res.json({ grants: await listGrants(prisma) });
    } catch (err) {
      next(err);
    }
  });

  // Disconnect: the grant goes, and every code, token and wrap with it. Idempotent.
  router.delete('/mcp/grants/:id', auth, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      if (await deleteGrant(prisma, id)) log.info(`MCP connection disconnected: grant ${id}`);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
