import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';

vi.mock('../logger');

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('GET /api/v1/status', () => {
  it('returns libraryExists:false and the app version on a fresh database', async () => {
    const res = await request(h.app).get('/api/v1/status');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ libraryExists: false, version: expect.any(String) });
  });
});
