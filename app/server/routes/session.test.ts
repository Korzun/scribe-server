import * as crypto from 'crypto';

import jwt from 'jsonwebtoken';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { parseSecretKey } from '../crypto/codes';
import { deriveAccountKeys } from '../crypto/kdf';
import { seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

const DAY_MS = 24 * 60 * 60 * 1000;

// One owner (about eleven PBKDF2 runs) for the whole file.
let h: Harness;
let owner: Owner;
beforeAll(async () => {
  h = await createHarness();
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(new VaultClient(h.app), {
    setupCode: 'test-setup-code',
    name: 'First Mac',
  });
}, 60_000);
afterAll(async () => {
  await h.close();
});

// Each test moves the shared fake clock into its own rate-limit window, 30 min
// apart so wrong-credential tests never add up toward a lockout (15 min window).
let window = 0;
const freshWindow = () => {
  window += 1;
  h.now.value = 1_700_000_000_000 + window * 30 * 60_000;
};

const signedIn = async () => {
  freshWindow();
  const client = new VaultClient(h.app);
  const res = await client.login({ password: owner.password, secretKey: owner.secretKey });
  expect(res.status).toBe(200);
  return client;
};

describe('POST /api/v1/session', () => {
  it('login with the right authKey returns an access token and sets the refresh cookie', async () => {
    freshWindow();
    const client = new VaultClient(h.app);
    const res = await client.login({ password: owner.password, secretKey: owner.secretKey });

    expect(res.status).toBe(200);
    expect(res.body.accessToken).toMatch(/^[\w-]+\.[\w-]+\.[\w-]+$/);
    expect(client.refreshCookie).toMatch(/^refresh_token=[\w-]{43}$/);
  });

  it('the cookie is httpOnly, SameSite=Strict, scoped to the session path and lives 30 days', async () => {
    freshWindow();
    const salts = await new VaultClient(h.app).salts();
    const { authKey } = deriveAccountKeys({
      secret: Buffer.from(owner.password, 'utf8'),
      secretKey: parseSecretKey(owner.secretKey)!,
      salt: Buffer.from(salts.body.passwordSalt!, 'base64'),
    });

    const res = await request(h.app)
      .post('/api/v1/session')
      .send({ authKey: authKey.toString('base64') });

    const cookie = (res.headers['set-cookie'] as unknown as string[])[0]!;
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Strict');
    expect(cookie).toContain('Path=/api/v1/session');
    expect(cookie).toContain(`Max-Age=${30 * 24 * 60 * 60}`);
    expect(cookie).not.toContain('Secure'); // the harness has no https public URL
  });

  it('a wrong authKey is 401', async () => {
    freshWindow();
    const res = await new VaultClient(h.app).postSession({
      authKey: Buffer.alloc(32, 1).toString('base64'),
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('a malformed body is 400', async () => {
    freshWindow();
    const res = await new VaultClient(h.app).postSession({ authKey: 'short' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
  });

  it('is rate limited to 10 attempts a minute per IP', async () => {
    freshWindow();
    const client = new VaultClient(h.app);
    // Malformed bodies: the window limiter runs before parsing, and these never count toward a lockout.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await client.postSession({})).status);

    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });

  it('sweeps expired refresh tokens on a successful login', async () => {
    await h.prisma.refreshToken.create({
      data: { tokenHash: 'stale', expiresAt: h.now.value - 1 },
    });

    await signedIn();

    expect(await h.prisma.refreshToken.findUnique({ where: { tokenHash: 'stale' } })).toBeNull();
  });
});

describe('POST /api/v1/session/refresh', () => {
  it('refresh rotates: the old refresh token is rejected on reuse', async () => {
    const client = await signedIn();
    const oldCookie = client.refreshCookie!;

    const rotated = await client.refresh();
    expect(rotated.status).toBe(200);
    expect(rotated.body.accessToken).toBeTruthy();
    expect(client.refreshCookie).not.toBe(oldCookie);

    const reuse = await new VaultClient(h.app).refresh(oldCookie);
    expect(reuse.status).toBe(401);
    expect(reuse.body).toEqual({ error: 'Unauthorized' });
    // ...while the new one still works.
    expect((await client.refresh()).status).toBe(200);
  });

  it('an unknown refresh token is 401 and the cookie is cleared', async () => {
    const res = await request(h.app)
      .post('/api/v1/session/refresh')
      .set('Cookie', 'refresh_token=unknown');

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/^refresh_token=;/);
  });

  it('without a cookie is 401', async () => {
    expect((await new VaultClient(h.app).refresh(null)).status).toBe(401);
  });

  it('an expired refresh token is 401', async () => {
    const client = await signedIn();

    h.now.value += 30 * DAY_MS + 1000;

    expect((await client.refresh()).status).toBe(401);
  });
});

describe('POST /api/v1/session/logout', () => {
  it('clears the cookie and the old refresh token is dead', async () => {
    const client = await signedIn();
    const cookie = client.refreshCookie!;

    const out = await client.logout();

    expect(out.status).toBe(204);
    expect(out.setCookie[0]).toMatch(/^refresh_token=;/);
    expect(out.setCookie[0]).toContain('Path=/api/v1/session');
    expect((await new VaultClient(h.app).refresh(cookie)).status).toBe(401);
  });

  it('without a session is still 204', async () => {
    expect((await new VaultClient(h.app).logout(null)).status).toBe(204);
  });
});

describe('a session as the owner credential', () => {
  it('the device list is readable with a session token, and no device is current', async () => {
    const client = await signedIn();

    const res = await client.devices(client.asSession());

    expect(res.status).toBe(200);
    expect(res.body.devices!.length).toBeGreaterThan(0);
    expect(res.body.devices!.every((d) => d.isCurrent === false)).toBe(true);
  });

  it('an expired access token is 401', async () => {
    const client = await signedIn();
    const token = client.asSession();
    expect((await client.devices(token)).status).toBe(200);

    h.now.value += 15 * 60 * 1000 + 1000;

    const res = await client.devices(token);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Unauthorized' });
  });

  it('a token signed with another secret is 401', async () => {
    const forged = jwt.sign({ owner: true }, Buffer.alloc(32, 9), { algorithm: 'HS256' });

    expect((await new VaultClient(h.app).devices(forged)).status).toBe(401);
  });
});

describe('sign-in lockout', () => {
  const WRONG = { authKey: Buffer.alloc(32, 1).toString('base64') };
  const LOCKED = { error: 'Too many attempts. Try again in 15 min.' };

  /** The auth key the owner's password and Secret Key derive. */
  const rightKey = async (): Promise<string> => {
    const salts = await new VaultClient(h.app).salts();
    return deriveAccountKeys({
      secret: Buffer.from(owner.password, 'utf8'),
      secretKey: parseSecretKey(owner.secretKey)!,
      salt: Buffer.from(salts.body.passwordSalt!, 'base64'),
    }).authKey.toString('base64');
  };
  const post = (authKey: string, from?: string) => {
    const req = request(h.app).post('/api/v1/session');
    return (from === undefined ? req : req.set('X-Forwarded-For', from)).send({ authKey });
  };

  it('locks the client after 5 wrong attempts', async () => {
    freshWindow();
    const right = await rightKey();
    for (let i = 0; i < 5; i++) expect((await post(WRONG.authKey)).status).toBe(401);

    const locked = await post(right);
    expect(locked.status).toBe(429);
    expect(locked.headers['retry-after']).toBe('900');
    expect(locked.body).toEqual(LOCKED);

    h.now.value += 15 * 60_000;
    expect((await post(right)).status).toBe(200);
  });

  it('a locked address keeps its tokens', async () => {
    const client = await signedIn();
    const right = await rightKey();
    for (let i = 0; i < 5; i++) expect((await post(WRONG.authKey)).status).toBe(401);
    expect((await post(right)).status).toBe(429);

    expect((await client.devices(client.asSession())).status).toBe(200);
    expect((await client.devices(owner.deviceToken)).status).toBe(200);
  });

  it('is busy when two checks are in flight', async () => {
    freshWindow();
    const right = await rightKey();
    const r1 = h.loginGuard.tryCheck()!;
    const r2 = h.loginGuard.tryCheck()!;
    try {
      const busy = await post(right);
      expect(busy.status).toBe(429);
      expect(busy.headers['retry-after']).toBe('60');
      expect(busy.body).toEqual({ error: 'Too busy. Try again in a minute.' });

      r1();
      expect((await post(right)).status).toBe(200);
    } finally {
      r1();
      r2();
    }
  });

  it('keys the lockout on the forwarded client', async () => {
    const fh = await createHarness({ trustProxyHops: 1 });
    try {
      // A cheap library: random keys the server cannot tell from real ones.
      const authKey = crypto.randomBytes(32).toString('base64');
      const wrap = () =>
        seal(crypto.randomBytes(32), crypto.randomBytes(32), 'aad').toString('base64');
      writeSetupCode(fh.dataDir, 'test-setup-code');
      const created = await new VaultClient(fh.app).createLibrary({
        setupCode: 'test-setup-code',
        libraryId: crypto.randomUUID(),
        passwordSalt: crypto.randomBytes(16).toString('base64'),
        recoverySalt: crypto.randomBytes(16).toString('base64'),
        authKey,
        passwordWrap: wrap(),
        recoveryCodes: Array.from({ length: 10 }, () => ({
          authKey: crypto.randomBytes(32).toString('base64'),
          wrap: wrap(),
        })),
      });
      expect(created.status).toBe(201);

      const from = (ip: string, key: string) =>
        request(fh.app).post('/api/v1/session').set('X-Forwarded-For', ip).send({ authKey: key });
      for (let i = 0; i < 5; i++) expect((await from('10.0.0.1', WRONG.authKey)).status).toBe(401);
      expect((await from('10.0.0.1', authKey)).status).toBe(429);

      expect((await from('10.0.0.2', authKey)).status).toBe(200);
    } finally {
      await fh.close();
    }
  });
});
