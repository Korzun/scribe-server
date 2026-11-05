import * as crypto from 'crypto';

import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { readSetupCode } from '../config';
import { isSealed, SEAL_HEADER_LENGTH, TAG_LENGTH } from '../crypto/seal';
import { logger } from '../logger';
import { createIpRateLimit } from '../middleware/rate-limit';
import { createLibrary, getLibrary, LibraryExistsError } from '../services/library';
import type { AppConfig } from '../types';
import { base64Bytes } from '../utils/base64-schema';

const log = logger('LibraryRoute');

export type LibraryRouterDeps = {
  prisma: PrismaClient;
  config: AppConfig;
  now: () => number;
};

/**
 * A key wrap is a sealed 32-byte Library Key: header + 32 + tag, exactly. A
 * wrong-length or unsealed blob here would be stored and only discovered at
 * the first unlock, when it is too late to re-run setup.
 */
const WRAP_LENGTH = SEAL_HEADER_LENGTH + 32 + TAG_LENGTH;
const sealedWrap = () => base64Bytes(WRAP_LENGTH, WRAP_LENGTH).refine(isSealed, 'not sealed');

const createLibraryBody = z.object({
  setupCode: z.string().max(256),
  libraryId: z.uuid(),
  passwordSalt: base64Bytes(16, 64),
  recoverySalt: base64Bytes(16, 64),
  authKey: base64Bytes(32, 32),
  passwordWrap: sealedWrap(),
  recoveryCodes: z.array(z.object({ authKey: base64Bytes(32, 32), wrap: sealedWrap() })).length(10),
  device: z.object({ name: z.string().trim().min(1).max(100) }),
});

/**
 * Compares the presented setup code to the configured one in constant time
 * (spec §4). `timingSafeEqual` needs equal lengths, and a length mismatch is
 * simply wrong, so that early return leaks only the length of a secret the
 * operator chose to be guessable by length anyway.
 */
function setupCodeMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The library routes (spec §4). Both are unauthenticated by nature — the app
 * has no credential until it has created or joined a library — so both sit
 * behind a per-IP rate limit.
 *
 * Nothing here logs a request body, token, key, salt, verifier or setup code:
 * outcomes are logged with ids only.
 */
export function createLibraryRouter({ prisma, config, now }: LibraryRouterDeps): Router {
  const router = Router();
  const saltsLimit = createIpRateLimit({
    max: 60,
    windowMs: 60_000,
    trustProxyHops: config.trustProxyHops,
    now,
  });
  const createLimit = createIpRateLimit({
    max: 10,
    windowMs: 60_000,
    trustProxyHops: config.trustProxyHops,
    now,
  });

  // The app needs the salts before it can derive anything, so they are served
  // without auth. They are not secret: they only make precomputation useless.
  router.get('/library/salts', saltsLimit, async (_req, res, next) => {
    try {
      const library = await getLibrary(prisma);
      if (library === null) {
        res.status(404).json({ error: 'No library' });
        return;
      }
      res.json({
        passwordSalt: Buffer.from(library.passwordSalt).toString('base64'),
        recoverySalt: Buffer.from(library.recoverySalt).toString('base64'),
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/library', createLimit, async (req, res, next) => {
    try {
      const parsed = createLibraryBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const body = parsed.data;

      // The setup code is checked BEFORE the database is touched, and is read
      // live from options.json so the operator can change it without a restart.
      const expected = readSetupCode(config.dataDir);
      if (expected === null) {
        log.warn('Library creation refused: no setup code configured');
        res.status(403).json({ error: 'Setup code required' });
        return;
      }
      if (!setupCodeMatches(body.setupCode, expected)) {
        log.warn('Library creation refused: setup code rejected');
        res.status(403).json({ error: 'Wrong setup code' });
        return;
      }

      try {
        const created = await createLibrary(
          prisma,
          {
            libraryId: body.libraryId,
            passwordSalt: body.passwordSalt,
            recoverySalt: body.recoverySalt,
            authKey: body.authKey,
            passwordWrap: body.passwordWrap,
            recoveryCodes: body.recoveryCodes,
            device: body.device,
          },
          now()
        );
        res.status(201).json({
          libraryId: created.libraryId,
          deviceId: created.deviceId,
          deviceToken: created.token,
        });
      } catch (err) {
        if (err instanceof LibraryExistsError) {
          res.status(409).json({ error: 'Library exists' });
          return;
        }
        throw err;
      }
    } catch (err) {
      next(err);
    }
  });

  return router;
}
