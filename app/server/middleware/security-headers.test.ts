import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createServer } from '../server';
import { createHarness, type Harness } from '../test-support/harness';

vi.mock('../logger');

const CSP =
  "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'";

let h: Harness;
afterEach(async () => {
  await h.close();
});

function expectHeaders(res: request.Response): void {
  expect(res.headers['content-security-policy']).toBe(CSP);
  expect(res.headers['x-content-type-options']).toBe('nosniff');
  expect(res.headers['referrer-policy']).toBe('same-origin');
  expect(res.headers['x-frame-options']).toBe('DENY');
  expect(res.headers['x-powered-by']).toBeUndefined();
}

describe('securityHeaders', () => {
  it('API responses carry the headers and no-store', async () => {
    h = await createHarness();
    const res = await request(h.app).get('/api/v1/status');

    expect(res.status).toBe(200);
    expectHeaders(res);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('the SPA shell carries the headers and keeps its own caching', async () => {
    h = await createHarness();
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-headers-dist-'));
    try {
      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
      fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1);');
      const app = createServer({
        config: h.config,
        prisma: h.prisma,
        jwtSecret: h.jwtSecret,
        blobStore: h.blobStore,
        gc: h.gc,
        uploads: h.uploads,
        now: () => h.now.value,
        clientDist: dist,
      });

      const shell = await request(app).get('/');
      expect(shell.status).toBe(200);
      expectHeaders(shell);
      expect(shell.headers['cache-control']).not.toBe('no-store');

      const asset = await request(app).get('/app.js');
      expect(asset.status).toBe(200);
      expectHeaders(asset);
      expect(asset.headers['cache-control']).not.toBe('no-store');
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });

  it('MCP paths carry the headers', async () => {
    h = await createHarness({ publicUrl: 'https://vault.example' });
    const meta = await request(h.app).get('/.well-known/oauth-authorization-server');
    expect(meta.status).toBe(200);
    expectHeaders(meta);
    expect(meta.headers['cache-control']).toBe('no-store');
    await h.close();

    h = await createHarness();
    const off = await request(h.app).get('/mcp');
    expect(off.status).toBe(404);
    expectHeaders(off);
  });
});
