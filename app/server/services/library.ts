import type { Library, Prisma, PrismaClient } from '@prisma/client';
import * as argon2 from 'argon2';

import { logger } from '../logger';
import { generateId } from '../utils/id';
import type { BlobStore } from './blob-store';
import { newDeviceToken } from './device';
import type { JwtSecret } from './token';
import { withVaultReset, withVaultWriter } from './vault-gate';

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
  /**
   * The first device, created in the same transaction so a half-made vault
   * cannot exist. Scribe sends one; the browser's setup page sends none, and
   * then no device row is created and no token is minted.
   */
  device?: { name: string };
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
): Promise<{ libraryId: string; deviceId?: string; token?: string }> {
  if (input.recoveryCodes.length !== RECOVERY_CODE_COUNT) {
    throw new Error(
      `A library needs exactly ten recovery codes, got ${input.recoveryCodes.length}`
    );
  }

  // Sequential on purpose: node-argon2's 64 MiB default times eleven in
  // parallel is a real memory peak on a small ARM board. One-time cost per vault.
  const authVerifier = await hashAuthKey(input.authKey);
  const codeVerifiers: string[] = [];
  for (const code of input.recoveryCodes) codeVerifiers.push(await hashAuthKey(code.authKey));

  const device =
    input.device === undefined
      ? null
      : { name: input.device.name, id: generateId(), ...newDeviceToken() };

  // Shared vault gate: a creation never lands between a reset's wipe and its
  // file removal.
  await withVaultWriter(undefined, () =>
    prisma.$transaction(async (tx) => {
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
      if (device !== null) {
        await tx.device.create({
          data: {
            id: device.id,
            libraryId: input.libraryId,
            name: device.name,
            tokenHash: device.tokenHash,
            createdAt: now,
          },
        });
      }
    })
  );

  if (device === null) {
    log.info(`Library created: ${input.libraryId}, no device yet`);
    return { libraryId: input.libraryId };
  }
  log.info(`Library created: ${input.libraryId}, first device ${device.id}`);
  return { libraryId: input.libraryId, deviceId: device.id, token: device.token };
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

/**
 * The storage figures `GET /library` reports (spec §4), from the database
 * alone. `blobBytes` sums `Blob.size` (so two rows sharing one file count it
 * twice: it is what the library holds, not what the disk holds).
 * `deletedMeetingCount` is the bin: meetings tombstoned but not yet purged,
 * where "purged" means the collector has dropped every blob row of the
 * tombstone (services/gc.ts). A purged tombstone is in neither count.
 */
export async function libraryStorage(prisma: PrismaClient): Promise<{
  blobBytes: number;
  blobCount: number;
  meetingCount: number;
  deletedMeetingCount: number;
}> {
  const [sum, blobCount, meetingCount, bin] = await Promise.all([
    prisma.blob.aggregate({ _sum: { size: true } }),
    prisma.blob.count(),
    prisma.meeting.count({ where: { deletedAt: null } }),
    prisma.$queryRaw<Array<{ n: bigint | number }>>`
      SELECT COUNT(*) AS n FROM meetings m
      WHERE m.deleted_at IS NOT NULL
        AND EXISTS (SELECT 1 FROM blobs b WHERE b.scope = m.id)`,
  ]);
  return {
    blobBytes: sum._sum.size ?? 0,
    blobCount,
    meetingCount,
    deletedMeetingCount: Number(bin[0]?.n ?? 0),
  };
}

/**
 * Every table the keys-lost reset empties, children first. `settings` is the
 * one table left alone (the signing secret and other instance state are not
 * the library's). A new table that holds library data is one more line here.
 * The wiped uploads' part directories are left for the next sweep
 * (services/upload-session.ts removes any directory with no row behind it).
 */
const RESET_TABLES: ReadonlyArray<(db: PrismaClient) => Prisma.PrismaPromise<unknown>> = [
  (db) => db.job.deleteMany(),
  (db) => db.mcpToken.deleteMany(),
  (db) => db.mcpAuthorizationCode.deleteMany(),
  (db) => db.mcpGrant.deleteMany(),
  (db) => db.mcpClient.deleteMany(),
  (db) => db.upload.deleteMany(),
  (db) => db.change.deleteMany(),
  (db) => db.blob.deleteMany(),
  (db) => db.meeting.deleteMany(),
  (db) => db.refreshToken.deleteMany(),
  (db) => db.device.deleteMany(),
  (db) => db.recoveryCode.deleteMany(),
  (db) => db.library.deleteMany(),
];

/** The `settings` key holding the reset epoch (services/vault-gate.ts); `settings` survives the reset. */
export const RESET_EPOCH_KEY = 'reset_epoch';

/**
 * The persisted reset epoch, `0` when no reset has ever happened. Read at
 * boot and handed to `initEpoch`. Anything but a non-negative integer is a
 * corrupt row, and the vault refuses to start rather than guess.
 */
export async function loadResetEpoch(prisma: PrismaClient): Promise<number> {
  const row = await prisma.setting.findUnique({ where: { key: RESET_EPOCH_KEY } });
  if (row === null) return 0;
  if (!/^\d{1,15}$/.test(row.value)) throw new Error('settings.reset_epoch is not an integer');
  return Number(row.value);
}

/** Writes the reset epoch to `settings`; the reset does this before moving the in-memory value. */
function persistResetEpoch(prisma: PrismaClient, next: number): Promise<void> {
  return prisma.setting
    .upsert({
      where: { key: RESET_EPOCH_KEY },
      create: { key: RESET_EPOCH_KEY, value: String(next) },
      update: { value: String(next) },
    })
    .then(() => undefined);
}

/**
 * Deletes the library and everything in it (spec §9, "Lost the Secret Key").
 * Nothing the vault's cryptography knows can authorise this, since the owner
 * has lost it; the route authorises it with the live setup code instead.
 *
 * All of it runs holding the vault gate exclusive (services/vault-gate.ts):
 * writes already in flight finish first (and are wiped with the rest), and
 * any request that authenticated before the reset is refused afterwards, so
 * nothing of the old library can land in the next one.
 *
 * In order: every row goes in one transaction, so a failure there leaves the
 * library whole. Then, at once, the signing secret is rotated, so no browser
 * access token of the old library is accepted by the next one (refresh
 * tokens went with the tables). Then the files are removed (unreadable
 * ciphertext under a key nobody holds; a crash before this leaves them for
 * the next reset). Last, the epoch moves: persisted to `settings` first,
 * then in memory (see `withVaultReset`). A failed rotation is still followed by the file removal,
 * and reported as `'rotation_failed'`: the library is gone, but the caller
 * must not claim success. Its log line names the error's class and code
 * only: a Prisma error can echo its arguments, and the argument is the new
 * secret.
 */
export function resetLibrary(
  prisma: PrismaClient,
  blobStore: BlobStore,
  jwtSecret: JwtSecret
): Promise<'ok' | 'rotation_failed'> {
  return withVaultReset(
    async () => {
      await prisma.$transaction(RESET_TABLES.map((deleteAll) => deleteAll(prisma)));
      let outcome: 'ok' | 'rotation_failed' = 'ok';
      try {
        await jwtSecret.rotate();
      } catch (err) {
        const name = err instanceof Error ? err.name : typeof err;
        const code = (err as { code?: unknown } | null)?.code;
        log.error(
          `Library deleted, but rotating the signing secret failed: ${name}${typeof code === 'string' ? ` (${code})` : ''}`
        );
        outcome = 'rotation_failed';
      }
      await blobStore.clear();
      log.info('Library deleted (keys-lost reset)');
      return outcome;
    },
    (next) => persistResetEpoch(prisma, next)
  );
}

/** How many recovery codes are still spendable. */
export function countUnusedRecoveryCodes(prisma: PrismaClient): Promise<number> {
  return prisma.recoveryCode.count({ where: { usedAt: null } });
}

export type PasswordMaterial = {
  newPasswordSalt: Buffer;
  newAuthKey: Buffer;
  newPasswordWrap: Buffer;
};

/** The slice of a Prisma transaction client that `swapPassword` needs. */
type PasswordTx = Pick<PrismaClient, 'library' | 'refreshToken'>;

/**
 * Swaps the password salt, verifier and wrap, and revokes every browser
 * refresh token, in the caller's transaction.
 *
 * Spec §3: the password guards the key; a device token guards the door. So a
 * password change or a recovery deliberately leaves every device token alone
 * (a Mac keeps working), but it DOES end every browser session: a stolen
 * refresh token must not outlive a credential change. `devices` is never
 * touched here.
 */
async function swapPassword(
  tx: PasswordTx,
  libraryId: string,
  material: PasswordMaterial,
  newVerifier: string
): Promise<void> {
  await tx.library.update({
    where: { id: libraryId },
    data: {
      passwordSalt: bytes(material.newPasswordSalt),
      authVerifier: newVerifier,
      passwordWrap: bytes(material.newPasswordWrap),
    },
  });
  await tx.refreshToken.deleteMany({});
}

/**
 * Changes the password (spec §3). The client already rewrapped the Library
 * Key under the new password's key; the vault verifies the CURRENT auth key
 * and swaps salt, verifier and wrap atomically. Returns false (and changes
 * nothing) when the current key is wrong or no library exists.
 */
export async function changePassword(
  prisma: PrismaClient,
  authKey: Buffer,
  material: PasswordMaterial
): Promise<boolean> {
  const library = await getLibrary(prisma);
  if (library === null) return false;
  if (!(await argon2.verify(library.authVerifier, authKey.toString('base64')))) return false;
  const newVerifier = await hashAuthKey(material.newAuthKey);
  await prisma.$transaction((tx) => swapPassword(tx, library.id, material, newVerifier));
  log.info('Password changed');
  return true;
}

/**
 * Replaces all recovery codes and the recovery salt (spec §3), after
 * verifying the current password's auth key. Old codes are deleted in the
 * same transaction the new ones are written, so there is never a window with
 * zero or twenty usable codes. Returns the new ids, or null on a wrong key.
 */
export async function replaceRecoveryCodes(
  prisma: PrismaClient,
  input: {
    authKey: Buffer;
    recoverySalt: Buffer;
    codes: Array<{ authKey: Buffer; wrap: Buffer }>;
  }
): Promise<string[] | null> {
  if (input.codes.length !== RECOVERY_CODE_COUNT) {
    throw new Error(`A library needs exactly ten recovery codes, got ${input.codes.length}`);
  }
  const library = await getLibrary(prisma);
  if (library === null) return null;
  if (!(await argon2.verify(library.authVerifier, input.authKey.toString('base64')))) return null;

  // Sequential, as in createLibrary: argon2's memory use times ten in parallel is more than a small board can spare.
  const verifiers: string[] = [];
  for (const code of input.codes) verifiers.push(await hashAuthKey(code.authKey));
  const ids = input.codes.map(() => generateId());

  await prisma.$transaction(async (tx) => {
    await tx.recoveryCode.deleteMany({});
    await tx.recoveryCode.createMany({
      data: input.codes.map((c, i) => ({
        id: ids[i]!,
        libraryId: library.id,
        authVerifier: verifiers[i]!,
        wrap: bytes(c.wrap),
      })),
    });
    await tx.library.update({
      where: { id: library.id },
      data: { recoverySalt: bytes(input.recoverySalt) },
    });
  });
  log.info('Recovery codes regenerated');
  return ids;
}

/**
 * Finds the first unused recovery code whose verifier matches `authKey`
 * (spec §3). Verifies sequentially over at most ten rows and always walks
 * every unused code rather than stopping at the match, so the work done does
 * not reveal which index matched; only the returned id does.
 */
export async function findRecoveryCode(
  prisma: PrismaClient,
  authKey: Buffer
): Promise<{ id: string; libraryId: string; wrap: Buffer } | null> {
  const rows = await prisma.recoveryCode.findMany({
    where: { usedAt: null },
    orderBy: { id: 'asc' },
  });
  const text = authKey.toString('base64');
  let found: (typeof rows)[number] | null = null;
  for (const row of rows) {
    const ok = await argon2.verify(row.authVerifier, text);
    if (ok && found === null) found = row;
  }
  return found === null
    ? null
    : { id: found.id, libraryId: found.libraryId, wrap: Buffer.from(found.wrap) };
}

export type RecoveryOutcome = 'ok' | 'not_found' | 'rejected';

/**
 * Spends recovery code `id` to set a new password (spec §3): checks the code
 * is unused and `authKey` matches its verifier, then, in one transaction,
 * marks it used and swaps the password material (also ending browser
 * sessions; device tokens stay valid). The conditional `usedAt IS NULL` update
 * makes two racing uses of one code succeed at most once.
 */
export async function recoverPassword(
  prisma: PrismaClient,
  id: string,
  authKey: Buffer,
  material: PasswordMaterial,
  now: number
): Promise<RecoveryOutcome> {
  const code = await prisma.recoveryCode.findUnique({ where: { id } });
  if (code === null) return 'not_found';
  if (code.usedAt !== null) return 'rejected';
  if (!(await argon2.verify(code.authVerifier, authKey.toString('base64')))) return 'rejected';
  const newVerifier = await hashAuthKey(material.newAuthKey);

  const spent = await prisma.$transaction(async (tx) => {
    const { count } = await tx.recoveryCode.updateMany({
      where: { id, usedAt: null },
      data: { usedAt: now },
    });
    if (count === 0) return false;
    await swapPassword(tx, code.libraryId, material, newVerifier);
    return true;
  });
  if (!spent) return 'rejected';
  log.info(`Recovery code used: ${id}`);
  return 'ok';
}
