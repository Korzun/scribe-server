import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';
import { MCP_DISABLED_MESSAGE } from './disabled';
import { connectMcpClient, mintTokens } from './test-support';
import { deleteGrant } from './tokens';

vi.mock('../logger');

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test', version: '0' },
  },
};

const postMcp = (app: Harness['app'], token: string | null, body: unknown = INITIALIZE) => {
  let req = request(app)
    .post('/mcp')
    .set('Accept', 'application/json, text/event-stream')
    .set('Content-Type', 'application/json');
  if (token !== null) req = req.set('Authorization', `Bearer ${token}`);
  return req.send(JSON.stringify(body));
};

describe('with PUBLIC_URL an https origin', () => {
  let h: Harness;
  let owner: Owner;
  beforeAll(async () => {
    h = await createHarness({ publicUrl: 'https://vault.example' });
    const client = new VaultClient(h.app);
    writeSetupCode(h.dataDir, 'test-setup-code');
    owner = await createOwner(client, { setupCode: 'test-setup-code' });
  }, 60_000);
  afterAll(async () => {
    await h.close();
  });
  afterEach(async () => {
    await h.prisma.mcpGrant.deleteMany();
  });

  const mint = () =>
    mintTokens(h.prisma, { libraryId: owner.libraryId, libraryKey: owner.libraryKey });

  it('publishes authorization-server metadata with PUBLIC_URL as the issuer', async () => {
    const res = await request(h.app).get('/.well-known/oauth-authorization-server');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      issuer: 'https://vault.example/',
      authorization_endpoint: 'https://vault.example/mcp/oauth/authorize',
      token_endpoint: 'https://vault.example/mcp/oauth/token',
      registration_endpoint: 'https://vault.example/mcp/oauth/register',
      revocation_endpoint: 'https://vault.example/mcp/oauth/revoke',
      scopes_supported: ['library:read'],
    });
  });

  it('publishes protected-resource metadata for /mcp', async () => {
    const res = await request(h.app).get('/.well-known/oauth-protected-resource/mcp');
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      resource: 'https://vault.example/mcp',
      authorization_servers: ['https://vault.example/'],
      scopes_supported: ['library:read'],
    });
  });

  it('serves the registration endpoint under /mcp/oauth', async () => {
    const res = await request(h.app)
      .post('/mcp/oauth/register')
      .send({ redirect_uris: ['https://c.example/cb'], token_endpoint_auth_method: 'none' });
    expect(res.status).toBe(201);
  });

  it('reports mcp: true on the status endpoint', async () => {
    const res = await request(h.app).get('/api/v1/status');
    expect(res.body).toMatchObject({ mcp: true, publicUrl: 'https://vault.example' });
  });

  it('answers 401 with a resource_metadata pointer when there is no token', async () => {
    const res = await postMcp(h.app, null);
    expect(res.status).toBe(401);
    expect(res.headers['www-authenticate']).toContain(
      'resource_metadata="https://vault.example/.well-known/oauth-protected-resource/mcp"'
    );
  });

  it('answers 401 for a token it does not know, and 405 for anything but POST', async () => {
    expect((await postMcp(h.app, 'nope')).status).toBe(401);
    const get = await request(h.app).get('/mcp');
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
  });

  it('completes the handshake and lists tools for a live token', async () => {
    const tokens = await mint();
    const mcp = await connectMcpClient(h.app, tokens.access_token);
    try {
      const listed = await mcp.client.listTools();
      expect(Array.isArray(listed.tools)).toBe(true);
      expect(mcp.client.getServerVersion()).toMatchObject({ name: 'scribe' });
    } finally {
      await mcp.close();
    }
  });

  it('a disconnected grant makes the token 401 at once', async () => {
    const tokens = await mint();
    expect((await postMcp(h.app, tokens.access_token)).status).toBe(200);
    await deleteGrant(h.prisma, tokens.grantId);
    expect((await postMcp(h.app, tokens.access_token)).status).toBe(401);
  });

  it('a token whose wrap no longer opens is 401, not a 500', async () => {
    const tokens = await mint();
    const row = await h.prisma.mcpToken.findFirstOrThrow({ where: { kind: 'access' } });
    const broken = Buffer.from(row.wrap);
    broken[broken.length - 1] ^= 0x01;
    await h.prisma.mcpToken.update({
      where: { tokenHash: row.tokenHash },
      data: { wrap: new Uint8Array(broken) },
    });
    const res = await postMcp(h.app, tokens.access_token);
    expect(res.status).toBe(401);
    expect(res.body).toMatchObject({ error: 'invalid_token' });
  });

  it('records the grant as used', async () => {
    const tokens = await mint();
    await postMcp(h.app, tokens.access_token);
    const grant = await h.prisma.mcpGrant.findUniqueOrThrow({ where: { id: tokens.grantId } });
    expect(grant.lastUsedAt).not.toBeNull();
  });
});

describe('without an https PUBLIC_URL', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await createHarness();
  });
  afterAll(async () => {
    await h.close();
  });

  it('every MCP path is a JSON 404 that says why', async () => {
    for (const path of [
      '/mcp',
      '/mcp/oauth/authorize',
      '/mcp/oauth/token',
      '/.well-known/oauth-authorization-server',
      '/.well-known/oauth-protected-resource/mcp',
    ]) {
      const res = await request(h.app).get(path);
      expect(res.status, path).toBe(404);
      expect(res.body, path).toEqual({ error: MCP_DISABLED_MESSAGE });
    }
    const post = await postMcp(h.app, 'anything');
    expect(post.status).toBe(404);
    expect(post.body).toEqual({ error: MCP_DISABLED_MESSAGE });
  });

  it('reports mcp: false on the status endpoint and still serves the API', async () => {
    const status = await request(h.app).get('/api/v1/status');
    expect(status.status).toBe(200);
    expect(status.body).toMatchObject({ mcp: false, publicUrl: null });
  });

  it('a LAN http PUBLIC_URL is off too', async () => {
    const lan = await createHarness({ publicUrl: 'http://192.168.1.20:3000' });
    try {
      expect((await request(lan.app).get('/mcp')).status).toBe(404);
      expect((await request(lan.app).get('/api/v1/status')).body.mcp).toBe(false);
    } finally {
      await lan.close();
    }
  });
});
