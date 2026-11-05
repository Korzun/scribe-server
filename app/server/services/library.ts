import type { Library, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { logger } from '../logger';
import { generateId } from '../utils/id';
import { newDeviceToken } from './device';

const log = logger('Library');

/** How many single-use recovery codes a library is created with (spec §4). */
export const RECOVERY_CODE_COUNT = 10;

export type CreateLibraryInput = {
  libraryId: string;
  passwordSalt: Buffer;
  recoverySalt: Buffer;
  authKey: Buffer;
  passwordWrap: Buffer;
  recoveryCodes: Array<{ authKey: Buffer; wrap: Buffer }>;
  /** The first device, created in the same transaction so a half-made vault cannot exist. */
  device: { name: string };
};

/** A vault holds exactly one library; a second creation is refused. */
export class LibraryExistsError extends Error {
  constructor() {
    super('Library exists');
    this.name = 'LibraryExistsError';
  }
}

/** Prisma's `Bytes` columns want an `ArrayBuffer`-backed view; a Node `Buffer` may sit on a shared one. */
function bytes(b: Buffer): Uint8Array<ArrayBuffer> {
  return new Uint8Array(b);
}

/**
 * The server never stores an auth key, only an argon2id verifier of it. The
 * key is 32 random-looking bytes, so its base64 text is what gets hashed
 * (argon2 defaults): the same string on create and on verify.
 */
function hashAuthKey(authKey: Buffer): Promise<string> {
  return argon2.hash(authKey.toString('base64'), { type: argon2.argon2id });
}

/**
 * Creates the vault's one library with its ten recovery codes and its first
 * device, atomically: a failure at any step leaves nothing behind, so setup can
 * simply be retried. Hashing happens before the transaction opens so the (slow)
 * argon2 work does not hold SQLite's write lock; the existence check lives
 * inside it so two racing creations cannot both succeed. `now` is the caller's
 * injected clock.
 */
export async function createLibrary(
  prisma: PrismaClient,
  input: CreateLibraryInput,
  now: number
): Promise<{ libraryId: string; deviceId: string; token: string }> {
  if (input.recoveryCodes.length !== RECOVERY_CODE_COUNT) {
    throw new Error(
      `A library needs exactly ten recovery codes, got ${input.recoveryCodes.length}`
    );
  }

  // Sequential on purpose: node-argon2's 64 MiB default times eleven in
  // parallel is a real memory peak on a Raspberry Pi. One-time cost per vault.
  const authVerifier = await hashAuthKey(input.authKey);
  const codeVerifiers: string[] = [];
  for (const code of input.recoveryCodes) codeVerifiers.push(await hashAuthKey(code.authKey));

  const { token, tokenHash } = newDeviceToken();
  const deviceId = generateId();

  await prisma.$transaction(async (tx) => {
    if ((await tx.library.count()) > 0) throw new LibraryExistsError();
    await tx.library.create({
      data: {
        id: input.libraryId,
        createdAt: now,
        passwordSalt: bytes(input.passwordSalt),
        recoverySalt: bytes(input.recoverySalt),
        authVerifier,
        passwordWrap: bytes(input.passwordWrap),
      },
    });
    await tx.recoveryCode.createMany({
      data: input.recoveryCodes.map((c, i) => ({
        id: generateId(),
        libraryId: input.libraryId,
        authVerifier: codeVerifiers[i],
        wrap: bytes(c.wrap),
      })),
    });
    await tx.device.create({
      data: {
        id: deviceId,
        libraryId: input.libraryId,
        name: input.device.name,
        tokenHash,
        createdAt: now,
      },
    });
  });

  log.info(`Library created: ${input.libraryId}, first device ${deviceId}`);
  return { libraryId: input.libraryId, deviceId, token };
}

/** The vault's library, or `null` before setup. */
export function getLibrary(prisma: PrismaClient): Promise<Library | null> {
  return prisma.library.findFirst();
}

/** True when `authKey` matches the owner's stored verifier (false too when no library exists). */
export async function verifyOwner(prisma: PrismaClient, authKey: Buffer): Promise<boolean> {
  const library = await getLibrary(prisma);
  if (library === null) return false;
  return argon2.verify(library.authVerifier, authKey.toString('base64'));
}
