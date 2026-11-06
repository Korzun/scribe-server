import { createHash } from 'crypto';
import { pipeline, type Readable } from 'stream';

import type { PrismaClient } from '@prisma/client';
import express, { Router, type NextFunction, type Request, type Response } from 'express';

import { isSealed } from '../crypto/seal';
import { logger } from '../logger';
import { ownerAuth } from '../middleware/owner-auth';
import { isMeetingKind, isUuid } from '../services/blob-kinds';
import type { BlobStore } from '../services/blob-store';
import { getBlob, putBlob } from '../services/blobs';

const log = logger('MeetingsRoute');

export type MeetingsRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: Buffer;
  blobStore: BlobStore;
  now: () => number;
};

const SHA256_RE = /^[0-9a-f]{64}$/;
const DEFAULT_MEETINGS_LIMIT = 100;
const MAX_MEETINGS_LIMIT = 500;

/**
 * The precondition of a blob write (spec §6): exactly one of `If-Match: <n>`
 * (the revision the Mac last saw; the quoted ETag form `"<n>"` is accepted
 * too) or `If-None-Match: *` (a first write). `null` = a first write;
 * `undefined` = no usable precondition, which is a 412.
 */
function parsePrecondition(req: Request): number | null | undefined {
  const ifMatch = req.get('If-Match');
  const ifNoneMatch = req.get('If-None-Match');
  if (ifMatch !== undefined && ifNoneMatch !== undefined) return undefined;
  if (ifNoneMatch !== undefined) return ifNoneMatch.trim() === '*' ? null : undefined;
  if (ifMatch === undefined) return undefined;
  const m = /^"?(\d{1,9})"?$/.exec(ifMatch.trim());
  return m ? Number(m[1]) : undefined;
}

/** A positive integer query parameter, `fallback` when absent, `null` when malformed. */
function parseLimit(raw: unknown, fallback: number, max: number): number | null {
  if (raw === undefined) return fallback;
  if (typeof raw !== 'string' || !/^\d{1,9}$/.test(raw)) return null;
  const n = Number(raw);
  return n < 1 ? null : Math.min(n, max);
}

// Only this route reads a raw body: 32 MiB covers every artifact and a short
// recording; longer audio goes through chunked uploads (Task 10). An oversized
// body is a clean 413 rather than the generic 500.
const rawBody = express.raw({ type: 'application/octet-stream', limit: '32mb' });
function readRawBody(req: Request, res: Response, next: NextFunction): void {
  rawBody(req, res, (err?: unknown) => {
    if (err !== undefined && err !== null) {
      const status = (err as { status?: number }).status;
      if (status === 413) {
        res.status(413).json({ error: 'Payload too large' });
        return;
      }
      if (status !== undefined && status >= 400 && status < 500) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      next(err);
      return;
    }
    next();
  });
}

/**
 * Meeting blobs and the meeting list (spec §6), all owner-only.
 *
 * Every byte that arrives here was sealed on a Mac; the vault cannot read it
 * and never tries. It checks only what it can without a key: the body hashes
 * to the `X-Scribe-Sha256` the Mac declared (so a body damaged in transit is
 * refused before anything touches disk), and it starts with the `SCRB\x01`
 * header (so a client bug that forgets to seal is refused rather than stored
 * as plaintext at rest, the one thing spec §1 forbids outright).
 *
 * Nothing here logs a body or a blob: only `scope/kind`, revision, size and
 * status (the service logs the outcome of each write).
 */
export function createMeetingsRouter({
  prisma,
  jwtSecret,
  blobStore,
  now,
}: MeetingsRouterDeps): Router {
  const router = Router();
  const auth = ownerAuth({ prisma, jwtSecret, now });

  router.put('/meetings/:id/blobs/:kind', auth, readRawBody, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const kind = String(req.params.kind);
      const declared = req.get('X-Scribe-Sha256');
      if (
        !isUuid(id) ||
        !isMeetingKind(kind) ||
        declared === undefined ||
        !SHA256_RE.test(declared) ||
        !Buffer.isBuffer(req.body)
      ) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const ifMatch = parsePrecondition(req);
      if (ifMatch === undefined) {
        res.status(412).json({ error: 'Precondition required' });
        return;
      }
      const bytes = req.body;
      if (createHash('sha256').update(bytes).digest('hex') !== declared) {
        log.warn(`Blob refused: ${id}/${kind} body does not match its declared hash`);
        res.status(400).json({ error: 'Hash mismatch' });
        return;
      }
      if (!isSealed(bytes)) {
        log.warn(`Blob refused: ${id}/${kind} is not a sealed blob`);
        res.status(400).json({ error: 'Not a sealed blob' });
        return;
      }

      const result = await putBlob(
        { prisma, blobStore, now },
        {
          scope: id,
          kind,
          bytes,
          sha256: declared,
          size: bytes.length,
          ifMatch,
          deviceId: req.owner?.via === 'device' ? req.owner.deviceId : null,
        }
      );
      if (!result.ok) {
        if (result.reason === 'gone') {
          res.status(410).json({ error: 'Meeting deleted' });
        } else {
          res
            .status(409)
            .json({ error: 'Revision conflict', currentRevision: result.currentRevision });
        }
        return;
      }
      res.status(result.revision === 1 ? 201 : 200).json({
        revision: result.revision,
        seq: result.seq,
        sha256: result.sha256,
        size: result.size,
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/meetings/:id/blobs/:kind', auth, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const kind = String(req.params.kind);
      if (!isUuid(id) || !isMeetingKind(kind)) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const blob = await getBlob({ prisma, blobStore }, id, kind);
      if (blob === null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      const etag = `"${blob.revision}"`;
      res.set('ETag', etag);
      res.set('X-Scribe-Sha256', blob.sha256);
      if (req.get('If-None-Match') === etag) {
        // Answered from the row alone: the file is never opened.
        res.status(304).end();
        return;
      }

      // Open before any status goes out, so a row whose file is missing (an
      // orphan, or an overwrite that unlinked it after the row was read) is a
      // clean 404 instead of a connection reset after the headers.
      let stream: Readable;
      try {
        stream = await blob.openStream();
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code ?? 'error';
        log.error(`Blob file missing: ${id}/${kind} revision ${blob.revision}: ${code}`);
        res.removeHeader('ETag');
        res.removeHeader('X-Scribe-Sha256');
        res.status(404).json({ error: 'Not found' });
        return;
      }

      res.status(200);
      res.set('Content-Type', 'application/octet-stream');
      res.set('Content-Length', String(blob.size));
      // `pipeline`, not `pipe`: when the Mac goes away mid-download (sleep, a
      // network change) it destroys the file stream too, so its descriptor is
      // closed rather than left open for good. A read error after the headers
      // can no longer become a status; pipeline cuts the connection, and the
      // Mac sees a short read that fails its hash check.
      pipeline(stream, res, (err) => {
        if (err === undefined || err === null) return;
        if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
          log.debug(`Blob download aborted by the client: ${id}/${kind}`);
        } else {
          log.error(`Blob read failed: ${id}/${kind}: ${err.message}`);
        }
      });
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
      const after = req.query.after;
      const limit = parseLimit(req.query.limit, DEFAULT_MEETINGS_LIMIT, MAX_MEETINGS_LIMIT);
      if (
        limit === null ||
        (after !== undefined && (typeof after !== 'string' || !isUuid(after)))
      ) {
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
      const id = String(req.params.id);
      const meeting = isUuid(id) ? await prisma.meeting.findUnique({ where: { id } }) : null;
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
