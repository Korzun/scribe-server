import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';

export type StatusRouterDeps = {
  prisma: PrismaClient;
  version: string;
};

/**
 * `GET /api/v1/status` — the one unauthenticated route. It tells a client
 * whether this vault already holds a library (so the app knows whether to
 * offer setup or sign-in) and which version is running. Nothing about the
 * library's contents or owner is revealed.
 */
export function createStatusRouter({ prisma, version }: StatusRouterDeps): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      // Task 4 replaces this with `(await prisma.library.count()) > 0` once the
      // `library` table exists; until then the library id lives in `settings`.
      const libraryExists =
        (await prisma.setting.findUnique({ where: { key: 'library_id' } })) !== null;
      res.json({ libraryExists, version });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
