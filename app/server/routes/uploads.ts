import { Readable } from 'stream';

import type { PrismaClient, Upload } from '@prisma/client';
import express, { Router, type Request, type Response } from 'express';
import { z } from 'zod';

import { deviceAuth } from '../middleware/device-auth';
import {
  isCanonicalUuid,
  isMeetingKind,
  libraryKindName,
  parseLibraryKind,
} from '../services/blob-kinds';
import { LIBRARY_SCOPE } from '../services/blobs';
import { InvalidUploadError, type UploadSessions } from '../services/upload-session';
import { parseRawBody, sendPutResult } from './blob-handlers';

export type UploadsRouterDeps = {
  prisma: PrismaClient;
  uploads: UploadSessions;
  now: () => number;
};

const beginBody = z.object({
  meetingId: z.string().nullable(),
  kind: z.string(),
  size: z.number().int(),
  sha256: z.string(),
  partSize: z.number().int().optional(),
  // A revision is an `Int` column too.
  ifMatch: z
    .number()
    .int()
    .min(0)
    .max(2 ** 31 - 1)
    .nullable(),
});

const PART_RE = /^\d{1,9}$/;

/** `{ scope, kind }` for a begin body, or `null` when the kind does not belong to the scope. */
function target(meetingId: string | null, kind: string): { scope: string; kind: string } | null {
  if (meetingId === null) {
    const parsed = parseLibraryKind(kind);
    return parsed === null ? null : { scope: LIBRARY_SCOPE, kind: libraryKindName(parsed) };
  }
  return isCanonicalUuid(meetingId) && isMeetingKind(kind) ? { scope: meetingId, kind } : null;
}

/**
 * Resumable chunked uploads (spec §7), for audio too big for one request:
 * the tunnel in front of the vault caps a body at 100 MB, an hour
 * of FLAC is more. The Mac begins a session with the blob's size and hash,
 * PUTs 16 MiB parts in any order, asks which parts arrived when it resumes,
 * and completes; the answer carries the hash the vault computed, and only on
 * a match does the Mac delete its WAVs.
 *
 * Device tokens only (`deviceAuth`): a browser never uploads, so a session
 * JWT is a 401 like any other unknown credential. A session belongs to the
 * device that began it; for any other device it does not exist (404), and so
 * does a completed or expired one. Completion answers exactly like a direct
 * blob PUT (blob-handlers.ts), plus 409 Incomplete with the missing parts.
 *
 * Nothing here logs; the service logs upload ids, part numbers, sizes and
 * outcomes, never a body.
 */
export function createUploadsRouter({ prisma, uploads, now }: UploadsRouterDeps): Router {
  const router = Router();
  const auth = deviceAuth({ prisma, now });

  /** The caller's live session, or `null` after answering 404. */
  async function owned(req: Request, res: Response): Promise<Upload | null> {
    const session = await uploads.get(String(req.params.id));
    if (session === null || session.deviceId !== req.device?.id) {
      res.status(404).json({ error: 'Not found' });
      return null;
    }
    return session;
  }

  router.post('/uploads', auth, async (req, res, next) => {
    try {
      const parsed = beginBody.safeParse(req.body);
      const dest = parsed.success ? target(parsed.data.meetingId, parsed.data.kind) : null;
      if (!parsed.success || dest === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const begun = await uploads.begin({
        deviceId: req.device!.id,
        ...dest,
        sha256: parsed.data.sha256,
        size: parsed.data.size,
        partSize: parsed.data.partSize,
        ifMatch: parsed.data.ifMatch,
        epoch: req.vaultEpoch!,
      });
      res.status(201).json(begun);
    } catch (err) {
      if (err instanceof InvalidUploadError) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      next(err);
    }
  });

  // The body limit is the session's own part size, so the session is looked
  // up (and its owner checked) before a byte of the body is read.
  router.put('/uploads/:id/parts/:n', auth, async (req, res, next) => {
    try {
      const raw = String(req.params.n);
      if (!PART_RE.test(raw)) {
        res.status(400).json({ error: 'Invalid part' });
        return;
      }
      const session = await owned(req, res);
      if (session === null) return;
      const parser = express.raw({ type: 'application/octet-stream', limit: session.partSize });
      parseRawBody(parser, req, res, (err?: unknown) => {
        if (err !== undefined && err !== null) {
          next(err);
          return;
        }
        if (!Buffer.isBuffer(req.body)) {
          res.status(400).json({ error: 'Invalid request' });
          return;
        }
        uploads
          .writePart(session.id, Number(raw), Readable.from([req.body]))
          .then((outcome) => {
            if (outcome === 'ok') res.status(204).end();
            else if (outcome === 'not_found') res.status(404).json({ error: 'Not found' });
            else res.status(400).json({ error: 'Invalid part' });
          })
          .catch(next);
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/uploads/:id', auth, async (req, res, next) => {
    try {
      const session = await owned(req, res);
      if (session === null) return;
      const inspection = await uploads.inspect(session.id);
      if (inspection === null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.json(inspection);
    } catch (err) {
      next(err);
    }
  });

  router.post('/uploads/:id/complete', auth, async (req, res, next) => {
    try {
      const session = await owned(req, res);
      if (session === null) return;
      const result = await uploads.complete(session.id);
      if (result.ok) {
        sendPutResult(res, result);
        return;
      }
      switch (result.reason) {
        case 'not_found':
          res.status(404).json({ error: 'Not found' });
          return;
        case 'incomplete':
          res.status(409).json({ error: 'Incomplete', missing: result.missing });
          return;
        case 'hash_mismatch':
          res.status(400).json({ error: 'Hash mismatch' });
          return;
        case 'not_sealed':
          res.status(400).json({ error: 'Not a sealed blob' });
          return;
        default:
          sendPutResult(res, result);
      }
    } catch (err) {
      next(err);
    }
  });

  router.delete('/uploads/:id', auth, async (req, res, next) => {
    try {
      const session = await owned(req, res);
      if (session === null) return;
      if (!(await uploads.abort(session.id))) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
