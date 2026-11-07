import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { createIpRateLimit } from '../middleware/rate-limit';
import { findRecoveryCode, recoverPassword } from '../services/library';
import type { AppConfig } from '../types';
import { base64Bytes } from '../utils/base64-schema';
import { newPasswordFields } from './library';

export type RecoveryRouterDeps = {
  prisma: PrismaClient;
  config: AppConfig;
  now: () => number;
};

const findBody = z.object({ authKey: base64Bytes(32, 32) });
const resetBody = z.object({ authKey: base64Bytes(32, 32), ...newPasswordFields });

/**
 * Recovering from a forgotten password with one of the ten recovery codes
 * (spec §3, §9). Both routes are unauthenticated by nature (the owner has no
 * working credential) and every attempt costs up to ten argon2 verifies, so
 * both sit behind a per-IP rate limit of 10 a minute.
 *
 * Step one proves possession of a code and returns the wrap the client
 * unwraps locally with the code's key (the vault never can). It also returns
 * the library id the wrap's AAD is bound to; that id is not a secret. Step two
 * spends the code, setting a new password. A recovery ends browser sessions
 * but leaves every device token valid (the password guards the key, the token
 * guards the door).
 *
 * Nothing here logs a request body, key, salt, verifier or wrap: only
 * "recovery code used: <id>".
 */
export function createRecoveryRouter({ prisma, config, now }: RecoveryRouterDeps): Router {
  const router = Router();
  const limit = createIpRateLimit({
    max: 10,
    windowMs: 60_000,
    trustProxyHops: config.trustProxyHops,
    now,
  });

  router.post('/recovery', limit, async (req, res, next) => {
    try {
      const parsed = findBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const code = await findRecoveryCode(prisma, parsed.data.authKey);
      if (code === null) {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      res.json({
        recoveryId: code.id,
        libraryId: code.libraryId,
        wrap: code.wrap.toString('base64'),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/recovery/:id/password', limit, async (req, res, next) => {
    try {
      const parsed = resetBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const { authKey, ...material } = parsed.data;
      const outcome = await recoverPassword(
        prisma,
        String(req.params.id),
        authKey,
        material,
        now()
      );
      if (outcome === 'not_found') {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (outcome === 'rejected') {
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
