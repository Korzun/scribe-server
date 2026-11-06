import { createHash } from 'crypto';
import type { Readable } from 'stream';

import type { PrismaClient } from '@prisma/client';

import { logger } from '../logger';
import { MEETING_KINDS } from './blob-kinds';
import { HashMismatchError, type BlobStore } from './blob-store';
import { appendChange } from './change-log';
import { withKeyLock, withKeyLocks } from './keyed-lock';
import { withVaultWriter } from './vault-gate';

const log = logger('Blobs');

/** The scope of library-wide blobs (`tag-list`, `voice/<uuid>`); every other scope is a meeting id. */
export const LIBRARY_SCOPE = 'library';

export type BlobsDeps = {
  prisma: PrismaClient;
  blobStore: BlobStore;
  now: () => number;
};

export type PutBlobInput = {
  scope: string;
  kind: string;
  /** The SHA-256 the caller declared (lowercase hex); the stored bytes must hash to it. */
  sha256: string;
  size: number;
  /** The revision the caller last saw (`If-Match`), or `null` for a first write (`If-None-Match: *`). */
  ifMatch: number | null;
  /** The writing device, or `null` for a browser session. */
  deviceId: string | null;
  /** The request's reset epoch (`req.vaultEpoch`); a stale one is refused. Omitted by internal callers. */
  epoch?: number;
} & ({ bytes: Buffer; stream?: undefined } | { stream: Readable; bytes?: undefined });

export type PutResult =
  | {
      ok: true;
      /** True when no blob existed (a first write, or a library blob re-created after deletion). */
      created: boolean;
      revision: number;
      seq: number;
      sha256: string;
      size: number;
    }
  | { ok: false; reason: 'conflict'; currentRevision: number }
  | { ok: false; reason: 'gone' };

/** Serialises everything that adds or drops a reference to one file. */
const fileKey = (sha256: string) => `file:${sha256}`;

/** Serialises the read-check-write of one blob (and anything that must not interleave with it). */
const kindKey = (scope: string, kind: string) => `${scope}/${kind}`;

/** How long a deleted meeting's blobs stay on disk before the collector may drop them (spec §6). */
export const DELETE_GRACE_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Writes one blob revision (spec §6, "Writes and conflicts").
 *
 * Everything happens under the `scope/kind` lock (see keyed-lock.ts for why an
 * in-process lock suffices): read the current row, check the caller's
 * precondition, store the file, then commit the new `blobs` row, its change
 * row and (first time only) the `meetings` row in one transaction, so the log
 * and the table can never disagree. A first write must find no row; any other
 * write must name the current revision exactly, or it is a conflict and the
 * Mac fetches, re-applies and retries. `currentRevision` is 0 when no blob
 * exists yet. A tombstoned meeting is `gone` and nothing is stored.
 *
 * The file is stored before the rows are committed, so a crash in between
 * leaves an unreferenced file (harmless, and collectable) rather than a row
 * pointing at nothing. After the commit, the previous revision's file is
 * removed unless another row still shares its bytes.
 *
 * `bytes` is checked against `sha256` and `size` before anything is written; a
 * `stream` is hashed while it is written and the temp file dropped on a
 * mismatch. Either way a mismatch throws `HashMismatchError` and changes
 * nothing. For a stream the recorded size is what was actually received.
 */
export function putBlob(deps: BlobsDeps, input: PutBlobInput): Promise<PutResult> {
  // The vault gate first (a keys-lost reset waits for this whole write, or
  // this write is refused after it), then the kind lock. See vault-gate.ts.
  return withVaultWriter(input.epoch, () =>
    withKeyLock(kindKey(input.scope, input.kind), () => putUnderLock(deps, input))
  );
}

/**
 * The revision a re-created blob continues from. A library blob (a voice) can
 * be deleted and later written again under the same kind; restarting at 1
 * would reuse a `(kind, revision)` the Mac's AAD has already bound to other
 * ciphertext, so an old blob could authenticate as the new one. Its next
 * revision is therefore one past the highest the change log ever recorded
 * for that kind. A meeting blob never comes back (its meeting is tombstoned
 * for good), so it starts from 0 as always.
 */
async function revisionFloor(prisma: PrismaClient, scope: string, kind: string): Promise<number> {
  if (scope !== LIBRARY_SCOPE) return 0;
  const max = await prisma.change.aggregate({
    where: { meetingId: null, kind },
    _max: { revision: true },
  });
  return max._max.revision ?? 0;
}

async function putUnderLock(deps: BlobsDeps, input: PutBlobInput): Promise<PutResult> {
  const { prisma, blobStore, now } = deps;
  const { scope, kind, sha256, ifMatch, deviceId } = input;
  const isMeeting = scope !== LIBRARY_SCOPE;
  // Checked once, here, under the kind lock: `tombstoneMeeting` takes this
  // same lock (for every kind) to write the tombstone, so the answer cannot
  // change between this read and the commit below.
  if (isMeeting) {
    const meeting = await prisma.meeting.findUnique({ where: { id: scope } });
    if (meeting !== null && meeting.deletedAt !== null) {
      log.info(`Blob refused: ${scope}/${kind} belongs to a deleted meeting`);
      return { ok: false, reason: 'gone' };
    }
  }

  const current = await prisma.blob.findUnique({ where: { scope_kind: { scope, kind } } });
  const currentRevision = current?.revision ?? 0;
  const satisfied = ifMatch === null ? current === null : current?.revision === ifMatch;
  if (!satisfied) {
    log.info(
      `Blob conflict: ${scope}/${kind} expected ${ifMatch ?? 'none'}, current ${currentRevision}`
    );
    return { ok: false, reason: 'conflict', currentRevision };
  }

  if (input.bytes !== undefined) {
    const actual = createHash('sha256').update(input.bytes).digest('hex');
    if (actual !== sha256 || input.bytes.length !== input.size) {
      throw new HashMismatchError(sha256, actual);
    }
  }

  const revision =
    (current === null ? await revisionFloor(prisma, scope, kind) : currentRevision) + 1;
  const at = now();

  // Storing the file and committing the row that references it happen under
  // the file's own lock, so a concurrent overwrite of a *different* kind
  // that shares these bytes cannot unlink the file in between.
  const { seq, size } = await withKeyLock(fileKey(sha256), async () => {
    const stored =
      input.bytes !== undefined
        ? await blobStore.put(input.bytes)
        : await blobStore.putStream(input.stream, sha256);
    const blobRow = { revision, sha256, size: stored.size, deviceId, updatedAt: at };
    const [, change] = await prisma.$transaction([
      prisma.blob.upsert({
        where: { scope_kind: { scope, kind } },
        create: { scope, kind, ...blobRow },
        update: blobRow,
      }),
      appendChange(prisma, {
        meetingId: isMeeting ? scope : null,
        kind,
        revision,
        sha256,
        size: stored.size,
        deleted: false,
        deviceId,
        at,
      }),
      ...(isMeeting
        ? [
            prisma.meeting.upsert({
              where: { id: scope },
              create: { id: scope, createdAt: at },
              update: {},
            }),
          ]
        : []),
    ]);
    return { seq: change.seq, size: stored.size };
  });

  if (current !== null && current.sha256 !== sha256) {
    await releaseBlobFile(deps, current.sha256);
  }

  log.info(`Blob stored: ${scope}/${kind} revision ${revision} (${size} bytes)`);
  return { ok: true, created: current === null, revision, seq, sha256, size };
}

export type TombstoneOutcome = 'deleted' | 'already' | 'not_found';

/**
 * Deletes a meeting (spec §6): sets `deletedAt = now` and `purgeAfter = now +
 * 7 days`, and appends exactly one change `{ kind: 'meeting', revision: 0,
 * deleted: true }` in the same transaction. Every Mac that pages past that
 * row drops its cache and local audio. The blobs stay until the collector
 * purges them after the grace (or sooner, when the owner empties the bin);
 * the `meetings` row and the log are never removed, so a late write from a
 * Mac that missed the deletion is a 410, never a resurrection.
 *
 * Idempotent: an already-deleted meeting is `'already'` and nothing moves. A
 * meeting the vault never saw is `'not_found'` (nothing to tombstone).
 *
 * Racing `putBlob`: the tombstone is written while holding the kind lock of
 * EVERY meeting kind of this meeting (in sorted order, see `withKeyLocks`).
 * The alternative, re-checking `deletedAt` in `putBlob` just before its
 * transaction, still leaves a window between that read and the commit. With
 * the locks, a PUT either finishes first (its blob and change row come before
 * the tombstone, and the sweep purges the blob) or starts after and sees the
 * tombstone (410). It can never commit a blob after the tombstone that the log
 * does not describe. Task 10's upload completion goes through `putBlob`, so it
 * inherits this.
 */
export function tombstoneMeeting(
  deps: BlobsDeps,
  meetingId: string,
  deviceId: string | null,
  epoch?: number
): Promise<TombstoneOutcome> {
  const { prisma, now } = deps;
  const keys = MEETING_KINDS.map((kind) => kindKey(meetingId, kind));
  return withVaultWriter(epoch, () =>
    withKeyLocks(keys, async (): Promise<TombstoneOutcome> => {
      const meeting = await prisma.meeting.findUnique({ where: { id: meetingId } });
      if (meeting === null) return 'not_found';
      if (meeting.deletedAt !== null) return 'already';
      const at = now();
      await prisma.$transaction([
        prisma.meeting.update({
          where: { id: meetingId },
          data: { deletedAt: at, purgeAfter: at + DELETE_GRACE_MS },
        }),
        appendChange(prisma, {
          meetingId,
          kind: 'meeting',
          revision: 0,
          sha256: null,
          size: null,
          deleted: true,
          deviceId,
          at,
        }),
      ]);
      log.info(`Meeting deleted: ${meetingId}`);
      return 'deleted';
    })
  );
}

/**
 * Deletes one blob outright (a voiceprint the owner removed): drops its row
 * and appends `{ revision: <current>, deleted: true }` in one transaction,
 * then releases its file. Under the kind lock, like a write, so it cannot
 * interleave with a `putBlob` of the same blob. Returns the revision deleted,
 * or `null` when there was no such blob.
 */
export function deleteBlob(
  deps: BlobsDeps,
  scope: string,
  kind: string,
  deviceId: string | null,
  epoch?: number
): Promise<number | null> {
  const { prisma, now } = deps;
  return withVaultWriter(epoch, () =>
    withKeyLock(kindKey(scope, kind), async () => {
      const current = await prisma.blob.findUnique({ where: { scope_kind: { scope, kind } } });
      if (current === null) return null;
      await prisma.$transaction([
        prisma.blob.delete({ where: { scope_kind: { scope, kind } } }),
        appendChange(prisma, {
          meetingId: scope === LIBRARY_SCOPE ? null : scope,
          kind,
          revision: current.revision,
          sha256: null,
          size: null,
          deleted: true,
          deviceId,
          at: now(),
        }),
      ]);
      await releaseBlobFile(deps, current.sha256);
      log.info(`Blob deleted: ${scope}/${kind} at revision ${current.revision}`);
      return current.revision;
    })
  );
}

/**
 * Removes the file for `sha256` unless some `blobs` row still references it.
 * Files are shared by content, so this is the only safe way to drop one; the
 * garbage collector uses it too.
 */
export function releaseBlobFile(
  deps: Pick<BlobsDeps, 'prisma' | 'blobStore'>,
  sha256: string
): Promise<boolean> {
  return withKeyLock(fileKey(sha256), async () => {
    if ((await deps.prisma.blob.count({ where: { sha256 } })) > 0) return false;
    await deps.blobStore.remove(sha256);
    return true;
  });
}

/** A stored blob's current revision, with a way to read its bytes. */
export type StoredBlob = {
  revision: number;
  sha256: string;
  size: number;
  /**
   * Opens the file and resolves once it is open, so a missing file rejects
   * (ENOENT) *before* the caller has sent any header and can still answer a
   * clean 404. Nothing is opened until this is called: a 304 never touches
   * the file, so it cannot leak a descriptor or raise an unhandled error.
   * The caller owns the stream and must destroy it if it stops reading.
   */
  openStream(): Promise<Readable>;
};

/** The current revision of one blob, or `null` when there is none. */
export async function getBlob(
  deps: Pick<BlobsDeps, 'prisma' | 'blobStore'>,
  scope: string,
  kind: string
): Promise<StoredBlob | null> {
  const row = await deps.prisma.blob.findUnique({ where: { scope_kind: { scope, kind } } });
  if (row === null) return null;
  return {
    revision: row.revision,
    sha256: row.sha256,
    size: row.size,
    openStream: () =>
      new Promise<Readable>((resolve, reject) => {
        const stream = deps.blobStore.createReadStream(row.sha256);
        stream.once('error', reject);
        stream.once('open', () => {
          stream.off('error', reject);
          resolve(stream);
        });
      }),
  };
}
