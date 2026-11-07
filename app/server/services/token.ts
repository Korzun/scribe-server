/**
 * Persistence for the owner's browser session: rotating refresh tokens (only
 * the SHA-256 hash is stored) and the HS256 signing secret (generated on first
 * boot, kept in the settings table so tokens survive restarts).
 */
import * as crypto from 'crypto';

import type { PrismaClient } from '@prisma/client';

export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const JWT_SECRET_KEY = 'jwt_secret';

/** SHA-256 hash of a refresh token — the only form ever persisted. */
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export async function getOrCreateJwtSecret(prisma: PrismaClient): Promise<Buffer> {
  const existing = await prisma.setting.findUnique({ where: { key: JWT_SECRET_KEY } });
  if (existing) return Buffer.from(existing.value, 'hex');
  // On conflict the empty update is a no-op and upsert returns the first
  // writer's row, so concurrent first boots converge on one secret.
  const row = await prisma.setting.upsert({
    where: { key: JWT_SECRET_KEY },
    create: { key: JWT_SECRET_KEY, value: crypto.randomBytes(32).toString('hex') },
    update: {},
  });
  return Buffer.from(row.value, 'hex');
}

/**
 * The live HS256 signing secret. Every sign and verify reads `current()`, so
 * `rotate()` invalidates every access token issued before it at once, `exp`
 * or not. The keys-lost reset (spec §9) rotates: a browser that was signed in
 * to the deleted library must not be signed in to the one created after it.
 */
export type JwtSecret = {
  current(): Buffer;
  /** Writes 32 fresh random bytes to `settings.jwt_secret`, then swaps the in-memory value. */
  rotate(): Promise<Buffer>;
};

/** Loads (or, on first boot, creates) the stored secret and wraps it in a `JwtSecret`. */
export async function createJwtSecret(prisma: PrismaClient): Promise<JwtSecret> {
  let secret = await getOrCreateJwtSecret(prisma);
  return {
    current: () => secret,
    async rotate() {
      const next = crypto.randomBytes(32);
      await prisma.setting.upsert({
        where: { key: JWT_SECRET_KEY },
        create: { key: JWT_SECRET_KEY, value: next.toString('hex') },
        update: { value: next.toString('hex') },
      });
      secret = next;
      return next;
    },
  };
}

/** Issues a refresh token (32 random bytes, base64url) valid for 30 days from `now`. */
export async function createRefreshToken(prisma: PrismaClient, now: number): Promise<string> {
  const token = crypto.randomBytes(32).toString('base64url');
  await prisma.refreshToken.create({
    data: { tokenHash: hashToken(token), expiresAt: now + REFRESH_TOKEN_TTL_MS },
  });
  return token;
}

/**
 * Validates and deletes (rotates out) the presented token in one step.
 * Returns true only when the token existed and was unexpired. A single
 * DELETE...RETURNING keeps consumption atomic: of two concurrent
 * presentations of the same token, exactly one wins. An expired row is
 * deleted too, so it cannot linger.
 */
export async function consumeRefreshToken(
  prisma: PrismaClient,
  token: string,
  now: number
): Promise<boolean> {
  const tokenHash = hashToken(token);
  const rows = await prisma.$queryRaw<
    Array<{ expires_at: number }>
  >`DELETE FROM refresh_tokens WHERE token_hash = ${tokenHash} RETURNING expires_at`;
  const row = rows[0];
  if (!row) return false;
  return Number(row.expires_at) > now;
}

export async function revokeRefreshToken(prisma: PrismaClient, token: string): Promise<void> {
  await prisma.refreshToken.deleteMany({
    where: { tokenHash: hashToken(token) },
  });
}

/** Drops every expired refresh token. Runs on each successful sign-in, which is frequent enough. */
export async function deleteExpired(prisma: PrismaClient, now: number): Promise<void> {
  await prisma.refreshToken.deleteMany({ where: { expiresAt: { lte: now } } });
}
