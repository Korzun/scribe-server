import type { PrismaClient } from '@prisma/client';

import { logger } from '../logger';
import type { BlobStore } from './blob-store';
import { DELETE_GRACE_MS, releaseBlobFile } from './blobs';
import { withKeyLock } from './keyed-lock';
import { withVaultWriter } from './vault-gate';

const log = logger('GC');

/** What one sweep did. */
export type SweepResult = { purgedMeetings: number; removedFiles: number; expiredUploads: number };

/** The hook chunked uploads (Task 10) plug in: drops sessions idle past their deadline, returns how many. */
export type UploadExpirer = { expire(now: number): Promise<number> };

export type GarbageCollectorDeps = {
  prisma: PrismaClient;
  blobStore: BlobStore;
  now: () => number;
  /** How long a deleted meeting's blobs are kept (spec §6: seven days). */
  graceMs?: number;
  uploads?: UploadExpirer;
};

export type GarbageCollector = {
  /** One pass; `graceMs` overrides the collector's own (the owner's "empty the bin now" passes 0). */
  sweep(options?: { graceMs?: number }): Promise<SweepResult>;
};

/**
 * The vault's garbage collector (spec §6, "Deletion").
 *
 * Deleting a meeting only writes a tombstone; its blobs stay on disk for a
 * grace period of seven days before they are collected. A meeting is due
 * once its `purgeAfter` (set at deletion) or `deletedAt + graceMs` has
 * passed; the latter is what lets the owner empty the bin sooner with
 * `graceMs = 0`. For each due meeting that still has
 * blobs, the sweep deletes its `blobs` rows and releases each file through
 * `releaseBlobFile`, so a file whose bytes a live blob shares survives.
 *
 * What a sweep never touches: the `meetings` row (the tombstone, which keeps
 * a late `PUT` a 410) and the change log (a Mac that has been offline for a
 * month still pages past the deletion). No `putBlob` can add a row to a
 * tombstoned meeting (see `tombstoneMeeting`), so deleting its rows here
 * needs no kind lock. Sweeps run one at a time (the hourly timer and an
 * owner's purge cannot interleave), and log counts only.
 */
export function createGarbageCollector({
  prisma,
  blobStore,
  now,
  graceMs = DELETE_GRACE_MS,
  uploads,
}: GarbageCollectorDeps): GarbageCollector {
  async function purgeDeletedMeetings(grace: number) {
    const at = now();
    const due = await prisma.meeting.findMany({
      where: {
        deletedAt: { not: null },
        OR: [{ purgeAfter: { lte: at } }, { deletedAt: { lte: at - grace } }],
      },
      select: { id: true },
    });
    let purgedMeetings = 0;
    let removedFiles = 0;
    for (const { id } of due) {
      const rows = await prisma.blob.findMany({ where: { scope: id }, select: { sha256: true } });
      if (rows.length === 0) continue; // already purged: a bare tombstone
      await prisma.blob.deleteMany({ where: { scope: id } });
      for (const sha256 of new Set(rows.map((r) => r.sha256))) {
        if (await releaseBlobFile({ prisma, blobStore }, sha256)) removedFiles += 1;
      }
      purgedMeetings += 1;
    }
    return { purgedMeetings, removedFiles };
  }

  return {
    sweep(options = {}) {
      // Shared vault gate (no epoch: no request behind it), so a sweep never
      // interleaves with a keys-lost reset.
      return withVaultWriter(undefined, () =>
        withKeyLock('gc', async () => {
          const purged = await purgeDeletedMeetings(options.graceMs ?? graceMs);
          const expiredUploads = uploads === undefined ? 0 : await uploads.expire(now());
          if (purged.purgedMeetings > 0 || expiredUploads > 0) {
            log.info(
              `Swept: ${purged.purgedMeetings} meetings purged, ${purged.removedFiles} files removed, ${expiredUploads} uploads expired`
            );
          }
          return { ...purged, expiredUploads };
        })
      );
    },
  };
}
