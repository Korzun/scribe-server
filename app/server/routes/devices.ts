import type { PrismaClient } from '@prisma/client';
import { Router } from 'express';
import { z } from 'zod';

import { logger } from '../logger';
import { ownerAuth } from '../middleware/owner-auth';
import { createIpRateLimit } from '../middleware/rate-limit';
import { issueDeviceToken } from '../services/device';
import { getLibrary, verifyOwner } from '../services/library';
import type { AppConfig } from '../types';
import { base64Bytes } from '../utils/base64-schema';

const log = logger('DevicesRoute');

export type DevicesRouterDeps = {
  prisma: PrismaClient;
  config: AppConfig;
  now: () => number;
};

const nameSchema = z.string().trim().min(1).max(64);
const enrolBody = z.object({ authKey: base64Bytes(32, 32), name: nameSchema });
const renameBody = z.object({ name: nameSchema });

/**
 * Enrolling and managing devices (spec §5).
 *
 * Enrolment is the only way a further Mac gets a device token: it proves it
 * knows the owner's password AND Secret Key by presenting the auth key derived
 * from both, and receives the password-wrapped Library Key to unwrap locally.
 * It is unauthenticated by nature (the Mac has no credential yet), so it is
 * rate limited per IP and every attempt costs an argon2 verify.
 *
 * Revoking a device does NOT rotate the Library Key. A revoked Mac that
 * already held the key keeps what it had; revocation only stops further access
 * to the vault. (Rotating would mean re-encrypting the whole library.)
 *
 * Nothing here logs a request body, token, key, salt or verifier: outcomes
 * are logged with device ids only.
 */
export function createDevicesRouter({ prisma, config, now }: DevicesRouterDeps): Router {
  const router = Router();
  const enrolLimit = createIpRateLimit({
    max: 10,
    windowMs: 60_000,
    trustProxyHops: config.trustProxyHops,
    now,
  });
  const auth = ownerAuth({ prisma, now });

  router.post('/devices', enrolLimit, async (req, res, next) => {
    try {
      const parsed = enrolBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const library = await getLibrary(prisma);
      if (library === null) {
        res.status(404).json({ error: 'No library' });
        return;
      }
      if (!(await verifyOwner(prisma, parsed.data.authKey))) {
        log.warn('Enrolment refused: invalid credentials');
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      const issued = await issueDeviceToken(prisma, {
        libraryId: library.id,
        name: parsed.data.name,
        now: now(),
      });
      res.status(201).json({
        deviceId: issued.deviceId,
        deviceToken: issued.token,
        libraryId: library.id,
        passwordSalt: Buffer.from(library.passwordSalt).toString('base64'),
        passwordWrap: Buffer.from(library.passwordWrap).toString('base64'),
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/devices', auth, async (req, res, next) => {
    try {
      const rows = await prisma.device.findMany({ orderBy: { createdAt: 'asc' } });
      // A session caller (Task 6) has no device id, so no row is "current".
      const currentId = req.owner?.via === 'device' ? req.owner.deviceId : null;
      res.json({
        devices: rows.map((d) => ({
          id: d.id,
          name: d.name,
          createdAt: d.createdAt,
          lastSeenAt: d.lastSeenAt,
          revokedAt: d.revokedAt,
          isCurrent: d.id === currentId,
        })),
      });
    } catch (err) {
      next(err);
    }
  });

  router.patch('/devices/:id', auth, async (req, res, next) => {
    try {
      const parsed = renameBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const id = String(req.params.id);
      const device = await prisma.device.findUnique({ where: { id } });
      if (device === null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      if (device.revokedAt !== null) {
        res.status(409).json({ error: 'Device revoked' });
        return;
      }
      await prisma.device.update({ where: { id }, data: { name: parsed.data.name } });
      res.json({ id, name: parsed.data.name });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/devices/:id', auth, async (req, res, next) => {
    try {
      const id = String(req.params.id);
      const device = await prisma.device.findUnique({ where: { id } });
      if (device === null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      // Only the first revocation stamps the time; the guard in the WHERE keeps
      // a repeat (or a concurrent one) from moving it.
      const { count } = await prisma.device.updateMany({
        where: { id, revokedAt: null },
        data: { revokedAt: now() },
      });
      if (count > 0) log.info(`Device revoked: ${id}`);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
