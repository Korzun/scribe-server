import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Transform, type Readable } from 'stream';
import { pipeline } from 'stream/promises';

import type { PrismaClient, Upload } from '@prisma/client';

import { isSealed } from '../crypto/seal';
import { logger } from '../logger';
import { generateId } from '../utils/id';
import type { BlobStore } from './blob-store';
import { putBlob as realPutBlob, type BlobsDeps, type PutBlobInput, type PutResult } from './blobs';
import { withKeyLock } from './keyed-lock';
import { currentEpoch, VaultResetError, withVaultWriter } from './vault-gate';

const log = logger('Uploads');

const MiB = 1024 * 1024;

/** The part size a Mac gets when it names none (spec §7: the starting point, well under Cloudflare's cap). */
export const DEFAULT_PART_SIZE = 16 * MiB;
export const MIN_PART_SIZE = 1 * MiB;
/** The largest part allowed: still comfortably under the tunnel's 100 MB per request. */
export const MAX_PART_SIZE = 64 * MiB;
/** `declaredSize` is an `Int` column (and `blobs.size` too), so a blob is at most 2^31 - 1 bytes. */
export const MAX_UPLOAD_SIZE = 2 ** 31 - 1;
/** Spec §7: incomplete uploads expire on the vault after seven days. */
export const UPLOAD_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const SHA256_RE = /^[0-9a-f]{64}$/;
const PART_NAME_RE = /^\d{1,9}$/;

/** A `begin` the vault refuses: a part size, size or hash outside what it accepts (a 400). */
export class InvalidUploadError extends Error {
  constructor(reason: string) {
    super(`upload: ${reason}`);
    this.name = 'InvalidUploadError';
  }
}

export type UploadSessionsDeps = {
  prisma: PrismaClient;
  /** Parts live at `<dataDir>/uploads/<id>/<n>`. */
  dataDir: string;
  blobStore: BlobStore;
  /** The write a completed upload becomes; injectable for tests, the real `putBlob` by default. */
  putBlob?: (deps: BlobsDeps, input: PutBlobInput) => Promise<PutResult>;
  now: () => number;
  ttlMs?: number;
};

export type BeginInput = {
  deviceId: string;
  /** A lowercase meeting id or `'library'`, already validated by the route. */
  scope: string;
  kind: string;
  sha256: string;
  size: number;
  partSize?: number;
  /** The precondition the completed blob is written with (see `putBlob`). */
  ifMatch: number | null;
  /** The reset epoch the request authenticated in (`req.vaultEpoch`). */
  epoch: number;
};

export type UploadInspection = {
  parts: number[];
  missing: number[];
  partSize: number;
  size: number;
  expiresAt: number;
};

export type PartOutcome = 'ok' | 'not_found' | 'invalid_part';

export type CompleteResult =
  | PutResult
  | { ok: false; reason: 'not_found' }
  | { ok: false; reason: 'incomplete'; missing: number[] }
  | { ok: false; reason: 'hash_mismatch' }
  | { ok: false; reason: 'not_sealed' };

export type UploadSessions = {
  begin(input: BeginInput): Promise<{ uploadId: string; partSize: number; expiresAt: number }>;
  /** The session if it is live (not completed, not past its deadline), else `null`. */
  get(id: string): Promise<Upload | null>;
  writePart(id: string, n: number, source: Readable): Promise<PartOutcome>;
  inspect(id: string): Promise<UploadInspection | null>;
  complete(id: string): Promise<CompleteResult>;
  abort(id: string): Promise<boolean>;
  /** Drops sessions past their deadline and stray part directories; returns how many unfinished sessions went. */
  expire(now: number): Promise<number>;
};

const partCount = (row: Pick<Upload, 'declaredSize' | 'partSize'>) =>
  Math.ceil(row.declaredSize / row.partSize);

/** Every part is `partSize` bytes except the last, which is exactly the remainder. */
function partLength(row: Pick<Upload, 'declaredSize' | 'partSize'>, n: number): number {
  return n === partCount(row) - 1 ? row.declaredSize - n * row.partSize : row.partSize;
}

/** Thrown inside the part pipeline the moment a part runs past its length. */
class PartTooLongError extends Error {}

const isEnoent = (err: unknown) => (err as NodeJS.ErrnoException).code === 'ENOENT';

/**
 * Resumable chunked uploads (spec §7).
 *
 * Why parts: the vault is reached through a Cloudflare Tunnel that caps a
 * request body at 100 MB, and an hour of audio is bigger than that even as
 * FLAC. So a Mac begins a session with the blob's size and SHA-256, PUTs
 * fixed-size parts in any order (after a dropped connection it asks which
 * parts arrived and sends the rest), and completes. Only then does the vault
 * assemble the parts, hash them, and, if and only if the hash is the one the
 * Mac declared and the bytes are sealed, store the blob and append to the
 * change log, through the same `putBlob` every other write uses (so the
 * precondition, the tombstone check and the lock order are all inherited).
 * The completion answer echoes the hash, and only on a match does the Mac
 * delete its WAVs: a wrong "yes" here is a recording lost for good.
 *
 * Parts never enter the vault gate (services/vault-gate.ts): a part is a
 * network body, and holding the gate for one would let a slow uplink stall a
 * keys-lost reset. Parts go straight to disk; `complete` assembles into a
 * temp file first and only then calls `putBlob`, so the gate is held for a
 * local disk-to-disk copy. (`putBlob` hashes the bytes again as it copies
 * them; the double hash is the price of reusing it unchanged.)
 *
 * The keys-lost reset: a session records the epoch its `begin` authenticated
 * in, and `begin` inserts under the gate, so no row of an old library can
 * land after the reset wiped the table. `writePart` and `complete` refuse a
 * session whose epoch has moved, and `complete` hands that epoch to
 * `putBlob`, whose gate re-checks it atomically with the write. The epoch
 * is persisted (`settings.reset_epoch`, see vault-gate.ts), so a session
 * outlives a restart with an epoch that still means the same library.
 *
 * Locks: `complete` and `abort` serialise per session on `upload:<id>`.
 * `complete` takes the gate (inside `putBlob`) while holding it, which is the
 * one place a keyed lock precedes the gate; it cannot deadlock, because
 * nothing that holds the gate (the sweep's `expire` included) ever waits for
 * an `upload:` key.
 *
 * Nothing here logs a body or a blob: upload ids, part numbers, sizes and
 * outcomes only.
 */
export function createUploadSessions({
  prisma,
  dataDir,
  blobStore,
  putBlob = realPutBlob,
  now,
  ttlMs = UPLOAD_TTL_MS,
}: UploadSessionsDeps): UploadSessions {
  const root = path.join(dataDir, 'uploads');
  // Only ever called with an id read from the `uploads` table (nanoid,
  // alphanumeric) or listed from `root` itself, never with request input.
  const dirFor = (id: string) => path.join(root, id);
  const blobsDeps: BlobsDeps = { prisma, blobStore, now };

  async function live(id: string): Promise<Upload | null> {
    const row = await prisma.upload.findUnique({ where: { id } });
    if (row === null || row.completedAt !== null || row.expiresAt <= now()) return null;
    return row;
  }

  /** The parts on disk at their exact length; anything else (a part cut short by a crash) counts as missing. */
  async function listParts(row: Upload): Promise<{ parts: number[]; missing: number[] }> {
    const dir = dirFor(row.id);
    const names = await fs.promises.readdir(dir).catch((err: unknown) => {
      if (isEnoent(err)) return [] as string[];
      throw err;
    });
    const count = partCount(row);
    const present = new Set<number>();
    for (const name of names) {
      if (!PART_NAME_RE.test(name)) continue;
      const n = Number(name);
      if (n >= count) continue;
      const stat = await fs.promises.stat(path.join(dir, name)).catch(() => null);
      if (stat?.isFile() && stat.size === partLength(row, n)) present.add(n);
    }
    const parts: number[] = [];
    const missing: number[] = [];
    for (let n = 0; n < count; n++) (present.has(n) ? parts : missing).push(n);
    return { parts, missing };
  }

  /**
   * Concatenates the parts, in order, into `temp`, hashing as it goes and
   * keeping the first bytes for the seal check.
   */
  async function assemble(row: Upload, temp: string): Promise<{ sha256: string; head: Buffer }> {
    const dir = dirFor(row.id);
    const count = partCount(row);
    async function* parts() {
      for (let n = 0; n < count; n++) {
        for await (const chunk of fs.createReadStream(path.join(dir, String(n)))) {
          yield chunk as Buffer;
        }
      }
    }
    const hash = createHash('sha256');
    let head = Buffer.alloc(0);
    const tap = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        if (head.length < 5) head = Buffer.concat([head, chunk.subarray(0, 5 - head.length)]);
        done(null, chunk);
      },
    });
    await pipeline(parts, tap, fs.createWriteStream(temp));
    return { sha256: hash.digest('hex'), head };
  }

  return {
    async begin(input) {
      const partSize = input.partSize ?? DEFAULT_PART_SIZE;
      if (!Number.isInteger(partSize) || partSize < MIN_PART_SIZE || partSize > MAX_PART_SIZE) {
        throw new InvalidUploadError('part size');
      }
      if (!Number.isInteger(input.size) || input.size < 1 || input.size > MAX_UPLOAD_SIZE) {
        throw new InvalidUploadError('size');
      }
      if (!SHA256_RE.test(input.sha256)) throw new InvalidUploadError('sha256');

      const id = generateId();
      const createdAt = now();
      const expiresAt = createdAt + ttlMs;
      // Under the gate, with the request's epoch: a begin that authenticated
      // before a reset can never insert its row after the reset's wipe.
      await withVaultWriter(input.epoch, () =>
        prisma.upload.create({
          data: {
            id,
            deviceId: input.deviceId,
            scope: input.scope,
            kind: input.kind,
            declaredSha256: input.sha256,
            declaredSize: input.size,
            partSize,
            ifMatch: input.ifMatch,
            epoch: input.epoch,
            createdAt,
            expiresAt,
          },
        })
      );
      log.info(
        `Upload ${id} begun: ${input.scope}/${input.kind}, ${input.size} bytes in ${partCount({ declaredSize: input.size, partSize })} parts of ${partSize}`
      );
      return { uploadId: id, partSize, expiresAt };
    },

    get: live,

    async writePart(id, n, source) {
      const row = await live(id);
      if (row === null) {
        source.destroy();
        return 'not_found';
      }
      if (row.epoch !== currentEpoch()) {
        source.destroy();
        throw new VaultResetError();
      }
      if (!Number.isInteger(n) || n < 0 || n >= partCount(row)) {
        source.destroy();
        log.warn(`Upload ${id}: part ${n} refused (out of range)`);
        return 'invalid_part';
      }
      const expected = partLength(row, n);
      const dir = dirFor(row.id);
      await fs.promises.mkdir(dir, { recursive: true });
      // Written beside its final name and renamed into place, so a part is
      // either whole or absent; a re-sent part simply replaces the old one.
      const temp = path.join(dir, `.part-${n}-${randomBytes(8).toString('hex')}`);
      let received = 0;
      const counter = new Transform({
        transform(chunk: Buffer, _enc, done) {
          received += chunk.length;
          done(received > expected ? new PartTooLongError() : null, chunk);
        },
      });
      try {
        // `flush`: a part listed as received must survive a power cut.
        await pipeline(source, counter, fs.createWriteStream(temp, { flush: true }));
        if (received !== expected) throw new PartTooLongError();
        await fs.promises.rename(temp, path.join(dir, String(n)));
      } catch (err) {
        await fs.promises.rm(temp, { force: true });
        if (err instanceof PartTooLongError) {
          log.warn(`Upload ${id}: part ${n} refused (${received} bytes, expected ${expected})`);
          return 'invalid_part';
        }
        // The session was aborted or expired while its part was in flight,
        // and its directory went with it.
        if (isEnoent(err)) return 'not_found';
        throw err;
      }
      log.debug(`Upload ${id}: part ${n} received (${received} bytes)`);
      return 'ok';
    },

    async inspect(id) {
      const row = await live(id);
      if (row === null) return null;
      const { parts, missing } = await listParts(row);
      return {
        parts,
        missing,
        partSize: row.partSize,
        size: row.declaredSize,
        expiresAt: row.expiresAt,
      };
    },

    async complete(id) {
      return withKeyLock(`upload:${id}`, async (): Promise<CompleteResult> => {
        // Read before the row: if a reset lands after this, either the row is
        // already gone, or `putBlob`'s gate refuses this epoch.
        const epoch = currentEpoch();
        const row = await live(id);
        if (row === null) return { ok: false, reason: 'not_found' };
        if (row.epoch !== epoch) throw new VaultResetError();

        const { missing } = await listParts(row);
        if (missing.length > 0) {
          log.info(`Upload ${id} not complete: ${missing.length} parts missing`);
          return { ok: false, reason: 'incomplete', missing };
        }

        const dir = dirFor(row.id);
        const temp = path.join(dir, `.assembled-${randomBytes(8).toString('hex')}`);
        let source: fs.ReadStream | undefined;
        try {
          const assembled = await assemble(row, temp);
          // Refused here, the parts stay: the Mac can inspect, re-send and
          // complete again, or abort. Same order of checks as a direct PUT.
          if (assembled.sha256 !== row.declaredSha256) {
            log.warn(`Upload ${id} refused: the parts do not match the declared hash`);
            return { ok: false, reason: 'hash_mismatch' };
          }
          if (!isSealed(assembled.head)) {
            log.warn(`Upload ${id} refused: not a sealed blob`);
            return { ok: false, reason: 'not_sealed' };
          }
          source = fs.createReadStream(temp);
          const result = await putBlob(blobsDeps, {
            scope: row.scope,
            kind: row.kind,
            stream: source,
            sha256: row.declaredSha256,
            size: row.declaredSize,
            ifMatch: row.ifMatch,
            deviceId: row.deviceId,
            epoch: row.epoch,
          });
          if (result.ok) {
            await prisma.upload.updateMany({ where: { id: row.id }, data: { completedAt: now() } });
            await fs.promises.rm(dir, { recursive: true, force: true });
            log.info(
              `Upload ${id} completed: ${row.scope}/${row.kind} revision ${result.revision}`
            );
          } else {
            log.info(`Upload ${id} not stored: ${result.reason}`);
          }
          return result;
        } finally {
          // `putBlob` never reads the stream when it refuses (conflict, 410,
          // a reset), so it is closed here rather than left holding its fd.
          source?.destroy();
          await fs.promises.rm(temp, { force: true });
        }
      });
    },

    async abort(id) {
      return withKeyLock(`upload:${id}`, async () => {
        const row = await live(id);
        if (row === null) return false;
        await prisma.upload.delete({ where: { id: row.id } });
        await fs.promises.rm(dirFor(row.id), { recursive: true, force: true });
        log.info(`Upload ${id} aborted`);
        return true;
      });
    },

    // Runs inside the sweep, which holds the vault gate: it must never call
    // `putBlob`, `deleteBlob` or `tombstoneMeeting` (the gate is not
    // re-entrant), nor wait for an `upload:` lock (see above). It only drops
    // rows and directories.
    async expire(at) {
      const due = await prisma.upload.findMany({
        where: { expiresAt: { lte: at } },
        select: { id: true, completedAt: true },
      });
      if (due.length > 0) {
        await prisma.upload.deleteMany({ where: { id: { in: due.map((d) => d.id) } } });
        for (const { id } of due)
          await fs.promises.rm(dirFor(id), { recursive: true, force: true });
      }
      // A directory with no row behind it: a session the keys-lost reset
      // wiped, or a part that landed just after an abort. Its row is always
      // inserted before its directory is made, so a live session is never
      // mistaken for one.
      const names = await fs.promises.readdir(root).catch((err: unknown) => {
        if (isEnoent(err)) return [] as string[];
        throw err;
      });
      if (names.length > 0) {
        const known = await prisma.upload.findMany({
          where: { id: { in: names } },
          select: { id: true },
        });
        const keep = new Set(known.map((k) => k.id));
        for (const name of names) {
          if (!keep.has(name)) await fs.promises.rm(dirFor(name), { recursive: true, force: true });
        }
      }
      return due.filter((d) => d.completedAt === null).length;
    },
  };
}
