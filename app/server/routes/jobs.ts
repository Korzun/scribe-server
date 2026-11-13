import type { PrismaClient } from '@prisma/client';
import { Router, type Response } from 'express';
import { z } from 'zod';

import { deviceAuth } from '../middleware/device-auth';
import { ownerAuth } from '../middleware/owner-auth';
import { isCanonicalUuid } from '../services/blob-kinds';
import { claimJob, completeJob, enqueueJob, heartbeatJob, jobsSummary } from '../services/jobs';
import type { JwtSecret } from '../services/token';

export type JobsRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  now: () => number;
};

const enqueueBody = z.object({
  meetingId: z.string().refine(isCanonicalUuid, 'not a canonical UUID'),
  reason: z.string().trim().min(1).max(200),
});

const completeBody = z.object({
  outcome: z.enum(['ok', 'failed']),
  note: z.string().trim().max(500).optional(),
});

/**
 * The reprocessing job queue (spec §8). Enqueueing and the summary are the
 * owner's (a Mac or the browser); claiming, heartbeating and completing are a
 * device's alone, because only a Mac does the work and the lease is its.
 * Exact paths and lease rules are documented beside the client
 * (`test-support/http-vault-client.ts`).
 */
export function createJobsRouter({ prisma, jwtSecret, now }: JobsRouterDeps): Router {
  const router = Router();
  const owner = ownerAuth({ prisma, jwtSecret, now });
  const device = deviceAuth({ prisma, now });
  const deps = { prisma, now };

  router.post('/jobs', owner, async (req, res, next) => {
    try {
      const parsed = enqueueBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const requestedBy = req.owner?.via === 'device' ? `device:${req.owner.deviceId}` : 'session';
      const result = await enqueueJob(deps, {
        meetingId: parsed.data.meetingId,
        reason: parsed.data.reason,
        requestedBy,
        epoch: req.vaultEpoch,
      });
      if (result === null) {
        res.status(404).json({ error: 'Not found' });
        return;
      }
      res.status(result.created ? 201 : 200).json({ job: result.job });
    } catch (err) {
      next(err);
    }
  });

  router.get('/jobs', owner, async (_req, res, next) => {
    try {
      res.json(await jobsSummary(deps));
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/claim', device, async (req, res, next) => {
    try {
      const job = await claimJob(deps, { deviceId: req.device!.id, epoch: req.vaultEpoch });
      if (job === null) {
        res.status(204).end();
        return;
      }
      res.json({ job });
    } catch (err) {
      next(err);
    }
  });

  const refuse = (res: Response, why: 'not_found' | 'not_yours'): void => {
    if (why === 'not_found') res.status(404).json({ error: 'Not found' });
    else res.status(409).json({ error: 'Not this device’s lease' });
  };

  router.post('/jobs/:id/heartbeat', device, async (req, res, next) => {
    try {
      const result = await heartbeatJob(deps, {
        id: String(req.params.id),
        deviceId: req.device!.id,
        epoch: req.vaultEpoch,
      });
      if (!result.ok) {
        refuse(res, result.reason);
        return;
      }
      res.json(result.value);
    } catch (err) {
      next(err);
    }
  });

  router.post('/jobs/:id/complete', device, async (req, res, next) => {
    try {
      const parsed = completeBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      const result = await completeJob(deps, {
        id: String(req.params.id),
        deviceId: req.device!.id,
        outcome: parsed.data.outcome,
        note: parsed.data.note,
        epoch: req.vaultEpoch,
      });
      if (!result.ok) {
        refuse(res, result.reason);
        return;
      }
      res.json({ job: result.value });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
