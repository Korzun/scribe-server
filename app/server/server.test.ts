import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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
});
