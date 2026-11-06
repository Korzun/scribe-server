import * as crypto from 'crypto';

import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { issueDeviceToken } from '../services/device';
import { signAccessToken } from '../services/jwt';
import { createHarness, HARNESS_JWT_SECRET, type Harness } from '../test-support/harness';
import { deviceAuth } from './device-auth';
import { ownerAuth } from './owner-auth';

vi.mock('../logger');

let h: Harness;
let token: string;
let deviceId: string;
let app: express.Express;
beforeEach(async () => {
  h = await createHarness();
  const libraryId = crypto.randomUUID();
  await h.prisma.library.create({
    data: {
      id: libraryId,
      createdAt: h.now.value,
      passwordSalt: Buffer.alloc(16),
      recoverySalt: Buffer.alloc(16),
      authVerifier: 'x',
      passwordWrap: Buffer.alloc(8),
    },
  });
  ({ token, deviceId } = await issueDeviceToken(h.prisma, {
    libraryId,
    name: 'Mac',
    now: h.now.value,
  }).then((r) => ({ token: r.token, deviceId: r.deviceId })));

  const deps = { prisma: h.prisma, now: () => h.now.value, jwtSecret: h.jwtSecret };
  app = express();
  app.get('/device', deviceAuth(deps), (req, res) => {
    res.json({ device: req.device });
  });
  app.get('/owner', ownerAuth(deps), (req, res) => {
    res.json({ owner: req.owner });
  });
});
afterEach(async () => {
  await h.close();
});

describe.each(['/device', '/owner'])('%s', (route) => {
  it('a missing Authorization header is 401', async () => {
    const res = await request(app).get(route);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('a non-Bearer scheme is 401', async () => {
    const res = await request(app).get(route).set('Authorization', `Basic ${token}`);
    expect(res.status).toBe(401);
  });

  it('a revoked token is 401', async () => {
    await h.prisma.device.update({ where: { id: deviceId }, data: { revokedAt: h.now.value } });
    const res = await request(app).get(route).set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(401);
  });
});

describe('deviceAuth', () => {
  it('a good token sets req.device', async () => {
    const res = await request(app).get('/device').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ device: { id: deviceId } });
  });
});

describe('ownerAuth', () => {
  it('a good device token sets req.owner', async () => {
    const res = await request(app).get('/owner').set('Authorization', `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ owner: { via: 'device', deviceId } });
  });

  it('a valid access token sets req.owner to a session', async () => {
    const jwt = signAccessToken(HARNESS_JWT_SECRET, { owner: true }, h.now.value / 1000);
    const res = await request(app).get('/owner').set('Authorization', `Bearer ${jwt}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ owner: { via: 'session' } });
  });

  it('a JWT-shaped bearer that does not verify is 401', async () => {
    const res = await request(app).get('/owner').set('Authorization', 'Bearer aaa.bbb.ccc');
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });
});
