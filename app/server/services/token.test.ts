import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import {
  consumeRefreshToken,
  createJwtSecret,
  createRefreshToken,
  deleteExpired,
  getOrCreateJwtSecret,
  hashToken,
  REFRESH_TOKEN_TTL_MS,
  revokeRefreshToken,
} from './token';

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

describe('getOrCreateJwtSecret', () => {
  it('returns the same 32-byte secret on a second call', async () => {
    const first = await getOrCreateJwtSecret(h.prisma);
    const second = await getOrCreateJwtSecret(h.prisma);

    expect(first).toHaveLength(32);
    expect(second.equals(first)).toBe(true);
  });
});

describe('createJwtSecret', () => {
  it('starts from the stored secret, and rotate() changes current() and the settings row', async () => {
    const stored = await getOrCreateJwtSecret(h.prisma);
    const secret = await createJwtSecret(h.prisma);
    expect(secret.current().equals(stored)).toBe(true);

    const rotated = await secret.rotate();

    expect(rotated).toHaveLength(32);
    expect(rotated.equals(stored)).toBe(false);
    expect(secret.current().equals(rotated)).toBe(true);
    const row = await h.prisma.setting.findUnique({ where: { key: 'jwt_secret' } });
    expect(row?.value).toBe(rotated.toString('hex'));
    expect((await createJwtSecret(h.prisma)).current().equals(rotated)).toBe(true);
  });
});

describe('refresh tokens', () => {
  it('stores only the SHA-256 hash, with the 30-day expiry', async () => {
    const token = await createRefreshToken(h.prisma, h.now.value);

    const rows = await h.prisma.refreshToken.findMany();
    expect(rows).toEqual([
      { tokenHash: hashToken(token), expiresAt: h.now.value + REFRESH_TOKEN_TTL_MS },
    ]);
    expect(hashToken(token)).toMatch(/^[0-9a-f]{64}$/);
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('is consumed exactly once', async () => {
    const token = await createRefreshToken(h.prisma, h.now.value);

    expect(await consumeRefreshToken(h.prisma, token, h.now.value)).toBe(true);
    expect(await consumeRefreshToken(h.prisma, token, h.now.value)).toBe(false);
  });

  it('of two concurrent presentations, exactly one wins', async () => {
    const token = await createRefreshToken(h.prisma, h.now.value);

    const results = await Promise.all([
      consumeRefreshToken(h.prisma, token, h.now.value),
      consumeRefreshToken(h.prisma, token, h.now.value),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
  });

  it('an expired token is refused (and still removed)', async () => {
    const token = await createRefreshToken(h.prisma, h.now.value);

    const later = h.now.value + REFRESH_TOKEN_TTL_MS;
    expect(await consumeRefreshToken(h.prisma, token, later)).toBe(false);
    expect(await h.prisma.refreshToken.count()).toBe(0);
  });

  it('an unknown token is refused', async () => {
    expect(await consumeRefreshToken(h.prisma, 'nope', h.now.value)).toBe(false);
  });

  it('revoking removes it', async () => {
    const token = await createRefreshToken(h.prisma, h.now.value);

    await revokeRefreshToken(h.prisma, token);

    expect(await consumeRefreshToken(h.prisma, token, h.now.value)).toBe(false);
  });

  it('deleteExpired sweeps only the expired rows', async () => {
    await createRefreshToken(h.prisma, h.now.value);
    const fresh = await createRefreshToken(h.prisma, h.now.value + REFRESH_TOKEN_TTL_MS);

    await deleteExpired(h.prisma, h.now.value + REFRESH_TOKEN_TTL_MS);

    const hashes = (await h.prisma.refreshToken.findMany()).map((r) => r.tokenHash);
    expect(hashes).toEqual([hashToken(fresh)]);
  });
});
