import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';

import { ownerAuth } from '../middleware/owner-auth';
import { DEFAULT_CHANGES_LIMIT, listChanges } from '../services/change-log';
import type { JwtSecret } from '../services/token';

export type ChangesRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  now: () => number;
};

const NON_NEGATIVE_INT = /^\d{1,15}$/;

/**
 * `GET /api/v1/changes?since=<seq>&limit=<n>` (spec §6): the one feed every
 * Mac polls. `since` defaults to 0 (the whole log) and `limit` to 500, clamped
 * at 1000. Anything that is not a plain non-negative integer (or, for `limit`,
 * zero) is a 400 rather than silently read as 0, so a client bug cannot make a
 * Mac re-sync the whole library.
 */
export function createChangesRouter({ prisma, jwtSecret, now }: ChangesRouterDeps): Router {
  const router = Router();
  const auth = ownerAuth({ prisma, jwtSecret, now });

  router.get('/changes', auth, async (req, res, next) => {
    try {
      const { since, limit } = req.query;
      const valid = (v: unknown) =>
        v === undefined || (typeof v === 'string' && NON_NEGATIVE_INT.test(v));
      if (!valid(since) || !valid(limit) || (limit !== undefined && Number(limit) < 1)) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      res.json(
        await listChanges(prisma, {
          since: since === undefined ? 0 : Number(since),
          limit: limit === undefined ? DEFAULT_CHANGES_LIMIT : Number(limit),
        })
      );
    } catch (err) {
      next(err);
    }
  });

  return router;
}
