import { createHash, randomBytes } from 'crypto';

import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';
import { buildOAuthMetadata } from './oauth-metadata';
import { createOAuthProvider } from './oauth-provider';
import { mintBrowserCode, TEST_BASE_URL, TEST_REDIRECT } from './test-support';
import { createAuthorizationCode, upsertGrant, withLibraryKey } from './tokens';

let h: Harness;
let owner: Owner;
let app: express.Express;
let provider: ReturnType<typeof createOAuthProvider>;

beforeAll(async () => {
  h = await createHarness();
  const client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code' });
}, 60_000);
afterAll(async () => {
  await h.close();
});

beforeEach(async () => {
  await h.prisma.mcpGrant.deleteMany();
  await h.prisma.mcpClient.deleteMany();
  provider = createOAuthProvider({ prisma: h.prisma, baseUrl: TEST_BASE_URL });
  app = express();
  app.use('/mcp/oauth/authorize', authorizationHandler({ provider, rateLimit: false }));
  app.use('/mcp/oauth/token', tokenHandler({ provider, rateLimit: false }));
  app.use(
    '/mcp/oauth/register',
    clientRegistrationHandler({
      clientsStore: provider.clientsStore,
      clientSecretExpirySeconds: 0,
      rateLimit: false,
    })
  );
  app.use('/mcp/oauth/revoke', revocationHandler({ provider, rateLimit: false }));
});

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

const register = async (): Promise<{ client_id: string }> => {
  const res = await request(app)
    .post('/mcp/oauth/register')
    .send({
      redirect_uris: [TEST_REDIRECT],
      client_name: 'Claude',
      token_endpoint_auth_method: 'none',
    });
  expect(res.status).toBe(201);
  return res.body as { client_id: string };
};

/** What consent does: a grant, and a browser-minted code sealing the Library Key. */
const mintCode = async (
  clientId: string,
  challenge: string,
  opts: { resource?: string | null } = {}
): Promise<string> => {
  const grant = await upsertGrant(h.prisma, {
    libraryId: owner.libraryId,
    clientId,
    scopes: ['library:read'],
  });
  const minted = mintBrowserCode(owner.libraryKey, owner.libraryId);
  await createAuthorizationCode(h.prisma, {
    grantId: grant.id,
    redirectUri: TEST_REDIRECT,
    codeChallenge: challenge,
    resource: opts.resource ?? null,
    codeHash: minted.codeHash,
    wrap: minted.wrap,
  });
  return minted.code.wire;
};

const exchange = (
  clientId: string,
  code: string,
  verifier: string,
  extra: Record<string, string> = {}
) =>
  request(app)
    .post('/mcp/oauth/token')
    .type('form')
    .send({
      grant_type: 'authorization_code',
      client_id: clientId,
      code,
      code_verifier: verifier,
      redirect_uri: TEST_REDIRECT,
      ...extra,
    });

const refresh = (clientId: string, refreshToken: string, extra: Record<string, string> = {}) =>
  request(app)
    .post('/mcp/oauth/token')
    .type('form')
    .send({
      grant_type: 'refresh_token',
      client_id: clientId,
      refresh_token: refreshToken,
      ...extra,
    });

/** True when the access token opens the owner's Library Key. */
const opensLibrary = (accessToken: string) =>
  withLibraryKey(h.prisma, { rawAccessToken: accessToken }, async (key) =>
    key.equals(owner.libraryKey)
  );

describe('metadata', () => {
  it('names PUBLIC_URL as the issuer and the /mcp/oauth endpoints', () => {
    expect(buildOAuthMetadata(TEST_BASE_URL)).toMatchObject({
      issuer: 'https://vault.example/',
      authorization_endpoint: 'https://vault.example/mcp/oauth/authorize',
      token_endpoint: 'https://vault.example/mcp/oauth/token',
      registration_endpoint: 'https://vault.example/mcp/oauth/register',
      revocation_endpoint: 'https://vault.example/mcp/oauth/revoke',
      scopes_supported: ['library:read'],
      code_challenge_methods_supported: ['S256'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
    });
  });
});

describe('registration and authorize', () => {
  it('registers a client and stores it', async () => {
    const client = await register();
    expect(client.client_id).toMatch(/[0-9a-f-]{36}/);
    const stored = await provider.clientsStore.getClient(client.client_id);
    expect(stored?.client_name).toBe('Claude');
    expect(stored?.redirect_uris).toEqual([TEST_REDIRECT]);
  });

  it('redirects a valid authorize request to the consent page with every param', async () => {
    const client = await register();
    const { challenge } = pkce();
    const res = await request(app).get('/mcp/oauth/authorize').query({
      client_id: client.client_id,
      redirect_uri: TEST_REDIRECT,
      response_type: 'code',
      code_challenge: challenge,
      code_challenge_method: 'S256',
      state: 'xyz',
      scope: 'library:read',
      resource: 'https://vault.example/mcp',
    });
    expect(res.status).toBe(302);
    const location = new URL(res.headers.location);
    expect(location.origin + location.pathname).toBe('https://vault.example/connect');
    expect(Object.fromEntries(location.searchParams)).toEqual({
      client_id: client.client_id,
      redirect_uri: TEST_REDIRECT,
      code_challenge: challenge,
      state: 'xyz',
      scope: 'library:read',
      resource: 'https://vault.example/mcp',
    });
  });

  it('refuses an unregistered redirect_uri before redirecting anywhere', async () => {
    const client = await register();
    const res = await request(app).get('/mcp/oauth/authorize').query({
      client_id: client.client_id,
      redirect_uri: 'https://evil.example/cb',
      response_type: 'code',
      code_challenge: 'x',
      code_challenge_method: 'S256',
    });
    expect(res.status).toBe(400);
  });
});

describe('token exchange', () => {
  it('exchanges a code for tokens that open the library, then refuses the reused code', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(client.client_id, challenge);

    const ok = await exchange(client.client_id, code, verifier);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      token_type: 'bearer',
      expires_in: 3600,
      scope: 'library:read',
    });
    expect(await opensLibrary(ok.body.access_token)).toBe(true);
    // The code's wrap is gone; only the two token wraps remain.
    expect(await h.prisma.mcpAuthorizationCode.count()).toBe(0);
    expect(await h.prisma.mcpToken.count()).toBe(2);

    const again = await exchange(client.client_id, code, verifier);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('invalid_grant');
  });

  it('refuses a code whose wrap belongs to a different code, and spends the code', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    // Consent stored code A's hash beside code B's wrap: A cannot open it.
    const grant = await upsertGrant(h.prisma, {
      libraryId: owner.libraryId,
      clientId: client.client_id,
      scopes: ['library:read'],
    });
    const a = mintBrowserCode(owner.libraryKey, owner.libraryId);
    const b = mintBrowserCode(owner.libraryKey, owner.libraryId);
    await createAuthorizationCode(h.prisma, {
      grantId: grant.id,
      redirectUri: TEST_REDIRECT,
      codeChallenge: challenge,
      resource: null,
      codeHash: a.codeHash,
      wrap: b.wrap,
    });

    const res = await exchange(client.client_id, a.code.wire, verifier);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(await h.prisma.mcpToken.count()).toBe(0);
    expect(await h.prisma.mcpAuthorizationCode.count()).toBe(0);
  });

  it('refuses a wrong verifier', async () => {
    const client = await register();
    const { challenge } = pkce();
    const code = await mintCode(client.client_id, challenge);
    const res = await exchange(client.client_id, code, 'wrong-verifier');
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses a redirect_uri other than the one the code was bound to', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(client.client_id, challenge);
    const res = await exchange(client.client_id, code, verifier, {
      redirect_uri: 'https://client.example/other',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('refuses a code minted for another client', async () => {
    const legit = await register();
    const thief = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(legit.client_id, challenge);
    const res = await exchange(thief.client_id, code, verifier);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
  });

  it('holds a code bound to a resource to that resource', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(client.client_id, challenge, {
      resource: 'https://vault.example/mcp',
    });
    const wrong = await exchange(client.client_id, code, verifier, {
      resource: 'https://other.example/mcp',
    });
    expect(wrong.status).toBe(400);
    expect(wrong.body.error).toBe('invalid_grant');
  });
});

describe('refresh', () => {
  it('rotates the pair, the new access token opens the library, and the old refresh token is dead', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(client.client_id, challenge);
    const first = (await exchange(client.client_id, code, verifier)).body as {
      access_token: string;
      refresh_token: string;
    };

    const refreshed = await refresh(client.client_id, first.refresh_token);
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.refresh_token).not.toBe(first.refresh_token);
    expect(await opensLibrary(refreshed.body.access_token)).toBe(true);

    const replay = await refresh(client.client_id, first.refresh_token);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe('invalid_grant');
  });

  it('refuses a scope the grant does not have', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(client.client_id, challenge);
    const first = (await exchange(client.client_id, code, verifier)).body as {
      refresh_token: string;
    };
    const res = await refresh(client.client_id, first.refresh_token, {
      scope: 'library:read library:write',
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_scope');
  });
});

describe('verifyAccessToken and revoke', () => {
  it('resolves a live token to its grant, and rejects a revoked one', async () => {
    const client = await register();
    const { verifier, challenge } = pkce();
    const code = await mintCode(client.client_id, challenge);
    const tokens = (await exchange(client.client_id, code, verifier)).body as {
      access_token: string;
    };
    const grant = await h.prisma.mcpGrant.findFirstOrThrow();

    const info = await provider.verifyAccessToken(tokens.access_token);
    expect(info).toMatchObject({
      clientId: client.client_id,
      scopes: ['library:read'],
      extra: { grantId: grant.id, libraryId: owner.libraryId },
    });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);

    const revoked = await request(app)
      .post('/mcp/oauth/revoke')
      .type('form')
      .send({ client_id: client.client_id, token: tokens.access_token });
    expect(revoked.status).toBe(200);
    await expect(provider.verifyAccessToken(tokens.access_token)).rejects.toMatchObject({
      errorCode: 'invalid_token',
    });
  });
});
