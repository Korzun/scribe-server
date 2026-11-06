import * as crypto from 'crypto';

import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { readSetupCode } from '../config';
import { isSealed, SEAL_HEADER_LENGTH, TAG_LENGTH } from '../crypto/seal';
import { logger } from '../logger';
import { ownerAuth } from '../middleware/owner-auth';
import { createIpRateLimit } from '../middleware/rate-limit';
import type { BlobStore } from '../services/blob-store';
import type { GarbageCollector } from '../services/gc';
import {
  changePassword,
  countUnusedRecoveryCodes,
  createLibrary,
  getLibrary,
  LibraryExistsError,
  libraryStorage,
  replaceRecoveryCodes,
  resetLibrary,
} from '../services/library';
import type { JwtSecret } from '../services/token';
import type { AppConfig } from '../types';
import { base64Bytes } from '../utils/base64-schema';

const log = logger('LibraryRoute');

export type LibraryRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  config: AppConfig;
  blobStore: BlobStore;
  gc: GarbageCollector;
  now: () => number;
};

/**
 * A key wrap is a sealed 32-byte Library Key: header + 32 + tag, exactly. A
 * wrong-length or unsealed blob here would be stored and only discovered at
 * the first unlock, when it is too late to re-run setup.
 */
export const WRAP_LENGTH = SEAL_HEADER_LENGTH + 32 + TAG_LENGTH;
export const sealedWrap = () =>
  base64Bytes(WRAP_LENGTH, WRAP_LENGTH).refine(isSealed, 'not sealed');

/** The new password material the client derived and rewrapped; shared with the recovery route. */
export const newPasswordFields = {
  newPasswordSalt: base64Bytes(16, 16),
  newAuthKey: base64Bytes(32, 32),
  newPasswordWrap: sealedWrap(),
};

const changePasswordBody = z.object({ authKey: base64Bytes(32, 32), ...newPasswordFields });

const replaceCodesBody = z.object({
  authKey: base64Bytes(32, 32),
  recoverySalt: base64Bytes(16, 16),
  codes: z.array(z.object({ authKey: base64Bytes(32, 32), wrap: sealedWrap() })).length(10),
});

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

const deleteLibraryBody = z.object({
  setupCode: z.string().max(256),
  confirm: z.literal('DELETE'),
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
 * The live setup code check shared by library creation and the keys-lost
 * reset (spec §4, §9): read from options.json at the moment of the request,
 * never cached. `null` when it passes; otherwise the 403 body to send.
 */
function checkSetupCode(dataDir: string, presented: string): { error: string } | null {
  const expected = readSetupCode(dataDir);
  if (expected === null) return { error: 'Setup code required' };
  if (!setupCodeMatches(presented, expected)) return { error: 'Wrong setup code' };
  return null;
}

/**
 * The library routes (spec §4, §9). Creation, the salts and the keys-lost
 * reset are unauthenticated by nature (the app has no credential until it has
 * created or joined a library, and the reset is for an owner who has lost
 * theirs), so each sits behind a per-IP rate limit.
 *
 * Nothing here logs a request body, token, key, salt, verifier or setup code:
 * outcomes are logged with ids only.
 */
export function createLibraryRouter({
  prisma,
  jwtSecret,
  config,
  blobStore,
  gc,
  now,
}: LibraryRouterDeps): Router {
  const router = Router();
  const auth = ownerAuth({ prisma, jwtSecret, now });
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
  // Tighter than creation: the reset is destructive, and an owner needs it
  // once in a vault's life.
  const resetLimit = createIpRateLimit({
    max: 5,
    windowMs: 60 * 60_000,
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
      const refused = checkSetupCode(config.dataDir, body.setupCode);
      if (refused !== null) {
        log.warn(`Library creation refused: ${refused.error}`);
        res.status(403).json(refused);
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

  // Spec §9, "Lost the Secret Key": nothing the vault's cryptography knows
  // can authorise this, because the owner has lost it, so it is authorised by
  // the one thing outside it: the live setup code, plus the word DELETE. The
  // body shape (including `confirm`) is checked first, then the code, and
  // only then is anything touched.
  router.delete('/library', resetLimit, async (req, res, next) => {
    try {
      const parsed = deleteLibraryBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const refused = checkSetupCode(config.dataDir, parsed.data.setupCode);
      if (refused !== null) {
        log.warn(`Library deletion refused: ${refused.error}`);
        res.status(403).json(refused);
        return;
      }
      await resetLibrary(prisma, blobStore);
      // After the wipe has committed: end every browser session of the old
      // library, `exp` or not (refresh tokens went with the tables). A
      // rotation that fails is logged, not fatal: the library is already gone.
      try {
        await jwtSecret.rotate();
      } catch (err) {
        log.error(
          `Signing secret rotation failed after the reset: ${err instanceof Error ? err.message : String(err)}`
        );
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  // Spec §6: "the admin page can empty the bin sooner" than the seven-day
  // grace. Live meetings are untouched; only tombstones are purged.
  router.post('/library/purge', auth, async (_req, res, next) => {
    try {
      const { purgedMeetings, removedFiles } = await gc.sweep({ graceMs: 0 });
      res.json({ purgedMeetings, removedFiles });
    } catch (err) {
      next(err);
    }
  });

  // The owner's view of the library: only public material (salts, the sealed
  // wrap) and counts. The wrap is useless without the password and Secret Key.
  router.get('/library', auth, async (_req, res, next) => {
    try {
      const library = await getLibrary(prisma);
      if (library === null) {
        res.status(404).json({ error: 'No library' });
        return;
      }
      res.json({
        id: library.id,
        createdAt: library.createdAt,
        passwordSalt: Buffer.from(library.passwordSalt).toString('base64'),
        recoverySalt: Buffer.from(library.recoverySalt).toString('base64'),
        passwordWrap: Buffer.from(library.passwordWrap).toString('base64'),
        recoveryCodesRemaining: await countUnusedRecoveryCodes(prisma),
        storage: await libraryStorage(prisma),
      });
    } catch (err) {
      next(err);
    }
  });

  // Spec §3: the client rewraps the Library Key under the new password; the
  // vault verifies the current auth key and swaps salt, verifier and wrap in
  // one transaction. Device tokens are untouched; browser sessions end.
  router.put('/library/password', auth, async (req, res, next) => {
    try {
      const parsed = changePasswordBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const { authKey, ...material } = parsed.data;
      if (!(await changePassword(prisma, authKey, material))) {
        log.warn('Password change refused: invalid credentials');
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  router.put('/library/recovery-codes', auth, async (req, res, next) => {
    try {
      const parsed = replaceCodesBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const ids = await replaceRecoveryCodes(prisma, parsed.data);
      if (ids === null) {
        log.warn('Recovery code regeneration refused: invalid credentials');
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      res.json({ ids });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
