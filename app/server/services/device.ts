import * as crypto from 'crypto';

import type { PrismaClient } from '@prisma/client';

import { logger } from '../logger';
import { generateId } from '../utils/id';

const log = logger('Device');

/** `lastSeenAt` is a courtesy for the device list, so it is written at most this often. */
const LAST_SEEN_INTERVAL_MS = 60_000;

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Mints a device token (spec §5): 32 random bytes, base64url. Only its SHA-256
 * is stored, so a database leak yields nothing a client could present. The
 * token itself is returned once and never recoverable afterwards.
 */
export async function issueDeviceToken(
  prisma: PrismaClient,
  input: { libraryId: string; name: string; now: number }
): Promise<{ deviceId: string; token: string }> {
  const token = crypto.randomBytes(32).toString('base64url');
  const deviceId = generateId();
  await prisma.device.create({
    data: {
      id: deviceId,
      libraryId: input.libraryId,
      name: input.name,
      tokenHash: hashToken(token),
      createdAt: input.now,
    },
  });
  log.info(`Device issued: ${deviceId}`);
  return { deviceId, token };
}

/**
 * Resolves a presented device token to its device, or `null` when unknown or
 * revoked. Bumps `lastSeenAt` at most once per minute so a chatty client does
 * not turn every request into a write.
 */
export async function authenticateDevice(
  prisma: PrismaClient,
  token: string,
  now: number
): Promise<{ deviceId: string } | null> {
  const device = await prisma.device.findUnique({ where: { tokenHash: hashToken(token) } });
  if (device === null || device.revokedAt !== null) return null;

  if (device.lastSeenAt === null || now - device.lastSeenAt >= LAST_SEEN_INTERVAL_MS) {
    await prisma.device.update({ where: { id: device.id }, data: { lastSeenAt: now } });
  }
  return { deviceId: device.id };
}
