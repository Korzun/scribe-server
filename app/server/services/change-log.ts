import type { Prisma, PrismaClient } from '@prisma/client';

/**
 * The library-wide change log (spec §6): every write to the vault appends one
 * row, and a Mac syncs by paging `GET /changes?since=<seq>` and remembering the
 * last `seq` it saw. That is the whole sync protocol: pull-based, polled, no
 * push. `seq` is SQLite's AUTOINCREMENT, so it only ever grows, even across
 * deleted rows, and a Mac's `last_seq` is never reissued to a different write.
 */

/** One row as the API returns it; `at` is ISO 8601 so the Mac need not know the vault stores ms. */
export type ChangeRow = {
  seq: number;
  meetingId: string | null;
  kind: string;
  revision: number;
  sha256: string | null;
  size: number | null;
  deleted: boolean;
  deviceId: string | null;
  at: string;
};

export type NewChange = {
  meetingId: string | null;
  kind: string;
  revision: number;
  sha256: string | null;
  size: number | null;
  deleted: boolean;
  deviceId: string | null;
  at: number;
};

export const DEFAULT_CHANGES_LIMIT = 500;
export const MAX_CHANGES_LIMIT = 1000;

/**
 * The insert for one change, unexecuted: callers put it in the same
 * `$transaction([...])` batch as the write it records, so the log can never
 * disagree with the `blobs` table. (A Prisma promise does nothing until the
 * batch or an `await` runs it.)
 */
export function appendChange(
  db: PrismaClient | Prisma.TransactionClient,
  row: NewChange
): Prisma.PrismaPromise<{ seq: number }> {
  return db.change.create({ data: row, select: { seq: true } });
}

/**
 * One page of the log after `since`, in `seq` order. `limit` is clamped to
 * 1..1000. `hasMore` comes from fetching one row beyond the page, so it is
 * exact without a count. `nextSince` is the last `seq` returned, or `since`
 * itself on an empty page, so a caught-up Mac keeps its place.
 */
export async function listChanges(
  prisma: PrismaClient,
  { since, limit = DEFAULT_CHANGES_LIMIT }: { since: number; limit?: number }
): Promise<{ changes: ChangeRow[]; nextSince: number; hasMore: boolean }> {
  const take = Math.min(Math.max(1, limit), MAX_CHANGES_LIMIT);
  const rows = await prisma.change.findMany({
    where: { seq: { gt: since } },
    orderBy: { seq: 'asc' },
    take: take + 1,
  });
  const hasMore = rows.length > take;
  const page = rows.slice(0, take);
  return {
    changes: page.map((r) => ({
      seq: r.seq,
      meetingId: r.meetingId,
      kind: r.kind,
      revision: r.revision,
      sha256: r.sha256,
      size: r.size,
      deleted: r.deleted,
      deviceId: r.deviceId,
      at: new Date(r.at).toISOString(),
    })),
    nextSince: page.length > 0 ? page[page.length - 1]!.seq : since,
    hasMore,
  };
}
