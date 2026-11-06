import { createHash } from 'crypto';
import type { Readable } from 'stream';

import type { PrismaClient } from '@prisma/client';

import { logger } from '../logger';
import { HashMismatchError, type BlobStore } from './blob-store';
import { appendChange } from './change-log';
import { withKeyLock } from './keyed-lock';

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
} & ({ bytes: Buffer; stream?: undefined } | { stream: Readable; bytes?: undefined });

export type PutResult =
  | { ok: true; revision: number; seq: number; sha256: string; size: number }
  | { ok: false; reason: 'conflict'; currentRevision: number }
  | { ok: false; reason: 'gone' };

/** Serialises everything that adds or drops a reference to one file. */
const fileKey = (sha256: string) => `file:${sha256}`;

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
  const { prisma, blobStore, now } = deps;
  const { scope, kind, sha256, ifMatch, deviceId } = input;

  return withKeyLock(`${scope}/${kind}`, async (): Promise<PutResult> => {
    const isMeeting = scope !== LIBRARY_SCOPE;
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

    const revision = currentRevision + 1;
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
    return { ok: true, revision, seq, sha256, size };
  });
}

/**
 * Removes the file for `sha256` unless some `blobs` row still references it.
 * Files are shared by content, so this is the only safe way to drop one; the
 * garbage collector (Task 9) uses it too.
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

/** The current revision of one blob and a stream of its bytes, or `null` when there is none. */
export async function getBlob(
  deps: Pick<BlobsDeps, 'prisma' | 'blobStore'>,
  scope: string,
  kind: string
): Promise<{ revision: number; sha256: string; size: number; stream: Readable } | null> {
  const row = await deps.prisma.blob.findUnique({ where: { scope_kind: { scope, kind } } });
  if (row === null) return null;
  return {
    revision: row.revision,
    sha256: row.sha256,
    size: row.size,
    stream: deps.blobStore.createReadStream(row.sha256),
  };
}
