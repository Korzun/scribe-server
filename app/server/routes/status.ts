import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';

export type StatusRouterDeps = {
  prisma: PrismaClient;
  version: string;
  /** The configured public origin, or `null`; the setup page names the vault by it in the kit. */
  publicUrl: string | null;
  /** Whether the remote MCP endpoint is served (`PUBLIC_URL` is an https origin). */
  mcp: boolean;
};

/**
 * `GET /api/v1/status`, unauthenticated (like library creation, the salts and
 * the keys-lost reset in routes/library.ts). It tells a client
 * whether this vault already holds a library (so the app knows whether to
 * offer setup or sign-in), which version is running, the public URL the
 * operator configured, and whether the MCP endpoint is on. Nothing about the library's contents or owner is
 * revealed.
 */
export function createStatusRouter({ prisma, version, publicUrl, mcp }: StatusRouterDeps): Router {
  const router = Router();

  router.get('/', async (_req, res, next) => {
    try {
      const libraryExists = (await prisma.library.count()) > 0;
      res.json({ libraryExists, version, publicUrl, mcp });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
