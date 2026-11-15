import { createHash, randomBytes } from 'crypto';

import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { mintBrowserCode, mintTokens, TEST_REDIRECT } from '../mcp/test-support';
import { openWrap, withLibraryKey } from '../mcp/tokens';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';
import { MCP_NOT_ENABLED } from './mcp-admin';

vi.mock('../logger');

let h: Harness;
let client: VaultClient;
let owner: Owner;
let session: string;

beforeAll(async () => {
  h = await createHarness({ publicUrl: 'https://vault.example' });
  client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code' });
  expect(
    (await client.login({ password: owner.password, secretKey: owner.secretKey })).status
  ).toBe(200);
  session = client.asSession();
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.prisma.mcpGrant.deleteMany();
  await h.prisma.mcpClient.deleteMany();
});

/** Registers a client as an assistant would, through the real endpoint. */
const register = async (): Promise<string> => {
  const res = await request(h.app)
    .post('/mcp/oauth/register')
    .send({
      redirect_uris: [TEST_REDIRECT],
      client_name: 'Claude',
      client_uri: 'https://claude.ai',
      token_endpoint_auth_method: 'none',
    });
  expect(res.status).toBe(201);
  return (res.body as { client_id: string }).client_id;
};

const pkce = () => {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
};

/** What the consent page sends on Approve, with the browser-minted code kept aside. */
const approval = (clientId: string, challenge: string, extra: Record<string, unknown> = {}) => {
  const minted = mintBrowserCode(owner.libraryKey, owner.libraryId);
  return {
    code: minted.code,
    body: {
      clientId,
      redirectUri: TEST_REDIRECT,
      codeChallenge: challenge,
      state: 'xyz',
      scope: 'library:read',
      resource: 'https://vault.example/mcp',
      approve: true,
      codeHash: minted.codeHash,
      wrap: minted.wrap.toString('base64'),
      ...extra,
    },
  };
};

describe('GET /api/v1/mcp/clients/:clientId', () => {
  it('names a registered client for the consent page, and is 404 for an unknown one', async () => {
    const clientId = await register();
    const res = await client.mcpClient(session, clientId);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ clientId, clientName: 'Claude', clientUri: 'https://claude.ai' });
    expect((await client.mcpClient(session, 'nope')).status).toBe(404);
    expect((await request(h.app).get(`/api/v1/mcp/clients/${clientId}`)).status).toBe(401);
  });
});

describe('POST /api/v1/mcp/authorize', () => {
  it('approve records the grant and the browser-minted code, and the code then buys tokens that open the library', async () => {
    const clientId = await register();
    const { verifier, challenge } = pkce();
    const { code, body } = approval(clientId, challenge);

    const res = await client.mcpAuthorize(session, body);
    expect(res.status).toBe(200);
    const redirect = new URL(res.body.redirectUrl!);
    expect(redirect.origin + redirect.pathname).toBe(TEST_REDIRECT);
    expect(Object.fromEntries(redirect.searchParams)).toEqual({ state: 'xyz' });

    const grant = await h.prisma.mcpGrant.findUniqueOrThrow({
      where: { libraryId_clientId: { libraryId: owner.libraryId, clientId } },
    });
    expect(grant.scopes).toBe('library:read');
    const row = await h.prisma.mcpAuthorizationCode.findUniqueOrThrow({
      where: { codeHash: code.hash },
    });
    expect(row).toMatchObject({
      grantId: grant.id,
      redirectUri: TEST_REDIRECT,
      codeChallenge: challenge,
      resource: 'https://vault.example/mcp',
    });
    expect(openWrap(code.wire, owner.libraryId, 'code', row.wrap).equals(owner.libraryKey)).toBe(
      true
    );

    // The assistant appends the code and exchanges it.
    redirect.searchParams.set('code', code.wire);
    const exchanged = await request(h.app)
      .post('/mcp/oauth/token')
      .type('form')
      .send({
        grant_type: 'authorization_code',
        client_id: clientId,
        code: redirect.searchParams.get('code'),
        code_verifier: verifier,
        redirect_uri: TEST_REDIRECT,
        resource: 'https://vault.example/mcp',
      });
    expect(exchanged.status).toBe(200);
    const opens = await withLibraryKey(
      h.prisma,
      { rawAccessToken: exchanged.body.access_token, now: h.now.value },
      async (key) => key.equals(owner.libraryKey)
    );
    expect(opens).toBe(true);
  });

  it('deny answers the registered URI with access_denied and writes nothing', async () => {
    const clientId = await register();
    const res = await client.mcpAuthorize(session, {
      clientId,
      redirectUri: TEST_REDIRECT,
      codeChallenge: 'c',
      state: 'xyz',
      approve: false,
    });
    expect(res.status).toBe(200);
    const redirect = new URL(res.body.redirectUrl!);
    expect(Object.fromEntries(redirect.searchParams)).toEqual({
      state: 'xyz',
      error: 'access_denied',
      error_description: 'The user denied the request',
    });
    expect(await h.prisma.mcpGrant.count()).toBe(0);
  });

  it('never bounces the browser to an unregistered redirect URI, approving or denying', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const evil = 'https://evil.example/cb';
    const approve = await client.mcpAuthorize(
      session,
      approval(clientId, challenge, { redirectUri: evil }).body
    );
    expect(approve.status).toBe(400);
    expect(approve.body).toEqual({ error: 'Unregistered redirect URI' });
    const deny = await client.mcpAuthorize(session, {
      clientId,
      redirectUri: evil,
      codeChallenge: 'c',
      approve: false,
    });
    expect(deny.status).toBe(400);
    expect(await h.prisma.mcpGrant.count()).toBe(0);
  });

  it('refuses an unknown client, an approval without the key material, a malformed wrap, and an unsupported scope', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    const unknown = await client.mcpAuthorize(session, approval('ghost', challenge).body);
    expect(unknown.status).toBe(400);
    expect(unknown.body).toEqual({ error: 'Unknown client' });

    const { codeHash: _h, wrap: _w, ...bare } = approval(clientId, challenge).body;
    expect((await client.mcpAuthorize(session, bare)).status).toBe(400);
    expect(
      (
        await client.mcpAuthorize(
          session,
          approval(clientId, challenge, { wrap: randomBytes(77).toString('base64') }).body
        )
      ).status
    ).toBe(400);
    const scope = await client.mcpAuthorize(
      session,
      approval(clientId, challenge, { scope: 'library:write' }).body
    );
    expect(scope.status).toBe(400);
    expect(scope.body).toEqual({ error: 'No supported scope was requested' });
    expect(await h.prisma.mcpGrant.count()).toBe(0);
  });

  it('re-approving a client drops the tokens the first approval led to', async () => {
    const clientId = await register();
    const tokens = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      clientId,
    });
    expect(await h.prisma.mcpToken.count()).toBe(2);
    const { challenge } = pkce();
    expect((await client.mcpAuthorize(session, approval(clientId, challenge).body)).status).toBe(
      200
    );
    expect(await h.prisma.mcpToken.count()).toBe(0);
    await expect(
      withLibraryKey(
        h.prisma,
        { rawAccessToken: tokens.access_token, now: h.now.value },
        async () => 1
      )
    ).rejects.toThrow();
  });

  it('a device token is an owner too, and no token is 401', async () => {
    const clientId = await register();
    const { challenge } = pkce();
    expect(
      (await client.mcpAuthorize(owner.deviceToken, approval(clientId, challenge).body)).status
    ).toBe(200);
    expect((await request(h.app).post('/api/v1/mcp/authorize').send({})).status).toBe(401);
  });
});

describe('grants', () => {
  it('lists connected assistants and disconnects one, killing its tokens at once', async () => {
    const tokens = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: h.now.value,
    });
    const list = await client.mcpGrants(session);
    expect(list.status).toBe(200);
    expect(list.body.grants).toEqual([
      {
        id: tokens.grantId,
        clientId: 'test-client',
        clientName: 'Test Assistant',
        clientUri: 'https://assistant.example',
        createdAt: h.now.value,
        lastUsedAt: null,
      },
    ]);

    expect((await client.disconnectMcpGrant(session, tokens.grantId)).status).toBe(204);
    expect((await client.disconnectMcpGrant(session, tokens.grantId)).status).toBe(204);
    expect((await client.mcpGrants(session)).body.grants).toEqual([]);
    expect(await h.prisma.mcpToken.count()).toBe(0);
    const mcp = await request(h.app)
      .post('/mcp')
      .set('Authorization', `Bearer ${tokens.access_token}`)
      .set('Accept', 'application/json, text/event-stream')
      .send({ jsonrpc: '2.0', id: 1, method: 'ping' });
    expect(mcp.status).toBe(401);
  });
});

describe('with MCP off', () => {
  it('consent is refused with the reason, and the grant list is empty but served', async () => {
    const off = await createHarness();
    try {
      const offClient = new VaultClient(off.app);
      writeSetupCode(off.dataDir, 'test-setup-code');
      const offOwner = await createOwner(offClient, { setupCode: 'test-setup-code' });
      const lookup = await offClient.mcpClient(offOwner.deviceToken, 'x');
      expect(lookup.status).toBe(404);
      expect(lookup.body).toEqual({ error: MCP_NOT_ENABLED });
      const consent = await offClient.mcpAuthorize(offOwner.deviceToken, {
        clientId: 'x',
        redirectUri: TEST_REDIRECT,
        codeChallenge: 'c',
        approve: false,
      });
      expect(consent.status).toBe(404);
      expect((await offClient.mcpGrants(offOwner.deviceToken)).body.grants).toEqual([]);
    } finally {
      await off.close();
    }
  }, 60_000);
});
