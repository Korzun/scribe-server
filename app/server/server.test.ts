import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServer } from './server';
import { createHarness, type Harness } from './test-support/harness';

vi.mock('./logger');

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('createServer', () => {
  it('an HTML body on a JSON route is a 400, not a 500', async () => {
    const res = await request(h.app)
      .post('/api/v1/status')
      .set('Content-Type', 'application/json')
      .send('<html>error</html>');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request body' });
  });

  it('an unknown /api path is a JSON 404', async () => {
    const res = await request(h.app).get('/api/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('GET / serves the SPA shell when client/dist exists and a 503 message when it does not', async () => {
    const dist = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-client-dist-'));
    try {
      const appFor = (clientDist: string) =>
        createServer({
          config: h.config,
          prisma: h.prisma,
          jwtSecret: h.jwtSecret,
          blobStore: h.blobStore,
          gc: h.gc,
          uploads: h.uploads,
          now: () => h.now.value,
          clientDist,
        });

      const missing = await request(appFor(path.join(dist, 'nope'))).get('/');
      expect(missing.status).toBe(503);
      expect(missing.type).toBe('text/plain');
      expect(missing.text).toContain('Client not built.');

      fs.writeFileSync(path.join(dist, 'index.html'), '<!doctype html><div id="root"></div>');
      fs.writeFileSync(path.join(dist, 'app.js'), 'console.log(1);');
      const app = appFor(dist);

      for (const url of ['/', '/login', '/recover']) {
        const res = await request(app).get(url);
        expect(res.status, url).toBe(200);
        expect(res.type, url).toBe('text/html');
        expect(res.text, url).toContain('<div id="root"></div>');
      }
      const asset = await request(app).get('/app.js');
      expect(asset.status).toBe(200);
      expect(asset.text).toBe('console.log(1);');

      // API paths never fall through to the SPA.
      const api = await request(app).get('/api/v1/nope');
      expect(api.status).toBe(404);
      expect(api.body).toEqual({ error: 'Not found' });
    } finally {
      fs.rmSync(dist, { recursive: true, force: true });
    }
  });
});
