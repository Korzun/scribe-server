import * as crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import { authenticateDevice, issueDeviceToken } from './device';

vi.mock('../logger');

let h: Harness;
let libraryId: string;
beforeEach(async () => {
  h = await createHarness();
  libraryId = crypto.randomUUID();
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
});
afterEach(async () => {
  await h.close();
});

describe('issueDeviceToken / authenticateDevice', () => {
  it('a freshly issued token authenticates and only its hash is stored', async () => {
    const { deviceId, token } = await issueDeviceToken(h.prisma, {
      libraryId,
      name: 'Mac',
      now: h.now.value,
    });

    expect(await authenticateDevice(h.prisma, token, h.now.value)).toEqual({ deviceId });
    const row = await h.prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(row.tokenHash).toBe(crypto.createHash('sha256').update(token).digest('hex'));
    expect(Buffer.from(token, 'base64url')).toHaveLength(32);
  });

  it('an unknown token does not authenticate', async () => {
    expect(await authenticateDevice(h.prisma, 'nope', h.now.value)).toBeNull();
  });

  it('a revoked device token no longer authenticates', async () => {
    const { deviceId, token } = await issueDeviceToken(h.prisma, {
      libraryId,
      name: 'Mac',
      now: h.now.value,
    });
    expect(await authenticateDevice(h.prisma, token, h.now.value)).not.toBeNull();

    await h.prisma.device.update({ where: { id: deviceId }, data: { revokedAt: h.now.value } });

    expect(await authenticateDevice(h.prisma, token, h.now.value)).toBeNull();
  });

  it('lastSeenAt is bumped on use but not more than once a minute', async () => {
    const { deviceId, token } = await issueDeviceToken(h.prisma, {
      libraryId,
      name: 'Mac',
      now: h.now.value,
    });
    const lastSeen = async () =>
      (await h.prisma.device.findUniqueOrThrow({ where: { id: deviceId } })).lastSeenAt;
    expect(await lastSeen()).toBeNull();

    const t0 = h.now.value;
    await authenticateDevice(h.prisma, token, t0);
    expect(await lastSeen()).toBe(t0);

    await authenticateDevice(h.prisma, token, t0 + 59_999);
    expect(await lastSeen()).toBe(t0);

    await authenticateDevice(h.prisma, token, t0 + 60_000);
    expect(await lastSeen()).toBe(t0 + 60_000);
  });
});
