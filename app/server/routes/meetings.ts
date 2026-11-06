import type { PrismaClient } from '@prisma/client';
import { Router, type Request } from 'express';

import { ownerAuth } from '../middleware/owner-auth';
import { isMeetingKind, normalizeUuid } from '../services/blob-kinds';
import type { BlobStore } from '../services/blob-store';
import { tombstoneMeeting } from '../services/blobs';
import type { JwtSecret } from '../services/token';
import { handleBlobGet, handleBlobPut, readRawBody } from './blob-handlers';

export type MeetingsRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  blobStore: BlobStore;
  now: () => number;
};

const DEFAULT_MEETINGS_LIMIT = 100;
const MAX_MEETINGS_LIMIT = 500;

/** The meeting id from the path, lowercased (any case is accepted), or `null` when it is not a UUID. */
const meetingId = (req: Request): string | null => normalizeUuid(String(req.params.id));

/** A positive integer query parameter, `fallback` when absent, `null` when malformed. */
function parseLimit(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n < 1 ? null : Math.min(n, max);
}

/**
 * Meeting blobs, deletion and the meeting list (spec §6), all owner-only. The
 * blob `PUT`/`GET` themselves live in `blob-handlers.ts`, shared with library
 * blobs; this router validates the meeting id and kind and answers for
 * tombstones. Nothing here logs a body or a blob.
 */
export function createMeetingsRouter({
  prisma,
  jwtSecret,
  blobStore,
  now,
}: MeetingsRouterDeps): Router {
  const router = Router();
  const auth = ownerAuth({ prisma, jwtSecret, now });
  const deps = { prisma, blobStore, now };

  router.put('/meetings/:id/blobs/:kind', auth, readRawBody, async (req, res, next) => {
    try {
      const id = meetingId(req);
      const kind = String(req.params.kind);
      if (id === null || !isMeetingKind(kind)) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      await handleBlobPut(deps, req, res, { scope: id, kind });
    } catch (err) {
      next(err);
    }
  });

  router.get('/meetings/:id/blobs/:kind', auth, async (req, res, next) => {
    try {
      const id = meetingId(req);
      const kind = String(req.params.kind);
      if (id === null || !isMeetingKind(kind)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      // A tombstoned meeting's blobs may still be on disk during the grace
      // (spec §6), but they are no longer the library's: same 410 as a PUT.
      const meeting = await prisma.meeting.findUnique({ where: { id } });
      if (meeting !== null && meeting.deletedAt !== null) {
        res.status(410).json({ error: 'Meeting deleted' });
        return;
      }
      await handleBlobGet(deps, req, res, { scope: id, kind });
    } catch (err) {
      next(err);
    }
  });

  // Spec §6: deletion is a tombstone in the log, and the blobs follow after
  // the seven-day grace (services/gc.ts). Idempotent: deleting twice is 204
  // both times and the second appends nothing.
  router.delete('/meetings/:id', auth, async (req, res, next) => {
    try {
      const id = meetingId(req);
      if (id === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const deviceId = req.owner?.via === 'device' ? req.owner.deviceId : null;
      const outcome = await tombstoneMeeting(deps, id, deviceId);
      if (outcome === 'not_found') {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  /** One `GET /meetings` entry per meeting row, with its current blobs in kind order. */
  async function withBlobs(meetings: Array<{ id: string; createdAt: number }>) {
    const blobs = await prisma.blob.findMany({
      where: { scope: { in: meetings.map((m) => m.id) } },
      orderBy: [{ scope: 'asc' }, { kind: 'asc' }],
    });
    return meetings.map((m) => ({
      id: m.id,
      createdAt: m.createdAt,
      blobs: blobs
        .filter((b) => b.scope === m.id)
        .map((b) => ({ kind: b.kind, revision: b.revision, sha256: b.sha256, size: b.size })),
    }));
  }

  router.get('/meetings', auth, async (req, res, next) => {
    try {
      const rawAfter = req.query.after;
      const after =
        rawAfter === undefined
          ? undefined
          : typeof rawAfter === 'string'
            ? normalizeUuid(rawAfter)
            : null;
      const limit = parseLimit(req.query.limit, DEFAULT_MEETINGS_LIMIT, MAX_MEETINGS_LIMIT);
      if (limit === null || after === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const rows = await prisma.meeting.findMany({
        where: { deletedAt: null, ...(after !== undefined ? { id: { gt: after } } : {}) },
        orderBy: { id: 'asc' },
        take: limit + 1,
      });
      const page = rows.slice(0, limit);
      res.json({
        meetings: await withBlobs(page),
        nextAfter: rows.length > limit ? page[page.length - 1]!.id : null,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/meetings/:id', auth, async (req, res, next) => {
    try {
      const id = meetingId(req);
      const meeting = id === null ? null : await prisma.meeting.findUnique({ where: { id } });
      if (meeting === null || meeting.deletedAt !== null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const [entry] = await withBlobs([meeting]);
      res.json(entry);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
