import type { PrismaClient } from '@prisma/client';
import { Router, type Request } from 'express';

import { ownerAuth } from '../middleware/owner-auth';
import { libraryKindName, parseLibraryKind, type LibraryKind } from '../services/blob-kinds';
import type { BlobStore } from '../services/blob-store';
import { deleteBlob, LIBRARY_SCOPE } from '../services/blobs';
import { handleBlobGet, handleBlobPut, readRawBody } from './blob-handlers';

export type LibraryBlobsRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: Buffer;
  blobStore: BlobStore;
  now: () => number;
};

/**
 * The library kind named by the `{*kind}` splat: Express 5 hands it over as
 * the list of (decoded) path segments, absent for an empty kind. They are
 * joined back with `/` and parsed; only `tag-list` and `voice/<uuid>` survive,
 * so `voice/../x` (literal or `%2F`-encoded), `voice/not-a-uuid` or an empty
 * kind never get further than this. Not that a kind could reach the
 * filesystem anyway (files are named by SHA-256), but nothing that looks like
 * a path is let in as a kind either.
 */
function libraryKind(req: Request): LibraryKind | null {
  const segments: unknown = req.params.kind;
  if (!Array.isArray(segments) || segments.length === 0) return null;
  return parseLibraryKind(segments.join('/'));
}

/**
 * Library-wide blobs (spec §6), owner-only, scope `'library'`: the tag list
 * and one blob per voiceprint. `PUT` and `GET` behave exactly as for meeting
 * blobs (same headers, limits and codes; see blob-handlers.ts). A voiceprint
 * can be deleted outright, which logs a `deleted: true` change at its last
 * revision; the tag list cannot (it is edited, never absent), so `DELETE` on
 * it is 405. Anything that is not a library kind is 400.
 */
export function createLibraryBlobsRouter({
  prisma,
  jwtSecret,
  blobStore,
  now,
}: LibraryBlobsRouterDeps): Router {
  const router = Router();
  const auth = ownerAuth({ prisma, jwtSecret, now });
  const deps = { prisma, blobStore, now };

  router.put('/library/blobs/{*kind}', auth, readRawBody, async (req, res, next) => {
    try {
      const kind = libraryKind(req);
      if (kind === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      await handleBlobPut(deps, req, res, { scope: LIBRARY_SCOPE, kind: libraryKindName(kind) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/library/blobs/{*kind}', auth, async (req, res, next) => {
    try {
      const kind = libraryKind(req);
      if (kind === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      await handleBlobGet(deps, req, res, { scope: LIBRARY_SCOPE, kind: libraryKindName(kind) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/library/blobs/{*kind}', auth, async (req, res, next) => {
    try {
      const kind = libraryKind(req);
      if (kind === null) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      if (kind.kind === 'tag-list') {
        res.status(405).set('Allow', 'GET, PUT').json({ error: 'Method not allowed' });
        return;
      }
      const name = libraryKindName(kind);
      const deviceId = req.owner?.via === 'device' ? req.owner.deviceId : null;
      const revision = await deleteBlob(deps, LIBRARY_SCOPE, name, deviceId);
      if (revision === null) {
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
