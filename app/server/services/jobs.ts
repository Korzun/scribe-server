/**
 * The reprocessing job queue (spec §8). The vault holds a queue; Macs do the
 * work. A Mac that is not recording, not processing and on mains power asks
 * for a job, receives at most one with a lease, heartbeats while it works,
 * and completes it. A lease that lapses returns the job to the queue; the
 * third lapse fails it instead, so a job no Mac can finish does not circle
 * for ever. The vault decides nothing about eligibility and runs nothing.
 *
 * A job's completion shows in the change log through the ordinary blob PUTs
 * the Mac makes, so the queue itself writes nothing there. Nothing here logs
 * a reason or a note: ids, statuses and counts only.
 */
import type { Job, PrismaClient } from '@prisma/client';

import { logger } from '../logger';
import { generateId } from '../utils/id';
import { withKeyLock } from './keyed-lock';
import { withVaultWriter } from './vault-gate';

const log = logger('Jobs');

export const JOB_LEASE_MS = 15 * 60 * 1000;
/** A job lapses this many times and is failed with outcome `lapsed`. */
export const MAX_JOB_ATTEMPTS = 3;
/** How many finished jobs the admin summary shows. */
export const RECENT_JOBS = 10;

export type JobStatus = 'queued' | 'leased' | 'done' | 'failed';
export type JobOutcome = 'ok' | 'failed' | 'lapsed';

export type JobsDeps = { prisma: PrismaClient; now: () => number };

/** Serialises every claim, so two Macs asking at once get two different jobs. */
const CLAIM_LOCK = 'jobs:claim';

/** A row as the API answers it. */
export type JobView = {
  id: string;
  meetingId: string;
  reason: string;
  requestedBy: string;
  status: JobStatus;
  attempts: number;
  leaseDeviceId: string | null;
  leaseExpiresAt: number | null;
  createdAt: number;
  startedAt: number | null;
  finishedAt: number | null;
  outcome: string | null;
  note: string | null;
};

export const viewJob = (row: Job): JobView => ({
  id: row.id,
  meetingId: row.meetingId,
  reason: row.reason,
  requestedBy: row.requestedBy,
  status: row.status as JobStatus,
  attempts: row.attempts,
  leaseDeviceId: row.leaseDeviceId,
  leaseExpiresAt: row.leaseExpiresAt,
  createdAt: row.createdAt,
  startedAt: row.startedAt,
  finishedAt: row.finishedAt,
  outcome: row.outcome,
  note: row.note,
});

/**
 * Enqueues a job for a live meeting. At most one queued job per meeting: a
 * second request while the first still waits returns the first (`created:
 * false`). A job already leased is work in flight, so a new request behind
 * it queues a fresh run. Null when the meeting is unknown or deleted.
 */
export async function enqueueJob(
  { prisma, now }: JobsDeps,
  input: { meetingId: string; reason: string; requestedBy: string; epoch?: number }
): Promise<{ job: JobView; created: boolean } | null> {
  return withVaultWriter(input.epoch, () =>
    withKeyLock(CLAIM_LOCK, async () => {
      const meeting = await prisma.meeting.findUnique({ where: { id: input.meetingId } });
      if (meeting === null || meeting.deletedAt !== null) return null;
      const queued = await prisma.job.findFirst({
        where: { meetingId: input.meetingId, status: 'queued' },
      });
      if (queued !== null) return { job: viewJob(queued), created: false };
      const row = await prisma.job.create({
        data: {
          id: generateId(),
          meetingId: input.meetingId,
          reason: input.reason,
          requestedBy: input.requestedBy,
          status: 'queued',
          createdAt: now(),
        },
      });
      log.info(`Job enqueued: ${row.id} for meeting ${row.meetingId}`);
      return { job: viewJob(row), created: true };
    })
  );
}

/** The queued jobs and the lapsed leases, oldest first: everything a claim may hand out. */
const claimable = (prisma: PrismaClient, at: number) =>
  prisma.job.findMany({
    where: {
      OR: [{ status: 'queued' }, { status: 'leased', leaseExpiresAt: { lte: at } }],
    },
    orderBy: { createdAt: 'asc' },
  });

/**
 * Hands `deviceId` the oldest claimable job under a fresh lease, or null when
 * there is none. A lapsed lease counts as claimable, and reclaiming it is
 * another attempt; a job that has lapsed `MAX_JOB_ATTEMPTS` times is failed
 * here, with outcome `lapsed`, and never handed out again.
 */
export async function claimJob(
  { prisma, now }: JobsDeps,
  input: { deviceId: string; epoch?: number }
): Promise<JobView | null> {
  return withVaultWriter(input.epoch, () =>
    withKeyLock(CLAIM_LOCK, async () => {
      const at = now();
      for (const candidate of await claimable(prisma, at)) {
        if (candidate.status === 'leased' && candidate.attempts >= MAX_JOB_ATTEMPTS) {
          await prisma.job.update({
            where: { id: candidate.id },
            data: {
              status: 'failed',
              outcome: 'lapsed',
              finishedAt: at,
              leaseDeviceId: null,
              leaseExpiresAt: null,
            },
          });
          log.warn(`Job failed after ${candidate.attempts} lapsed leases: ${candidate.id}`);
          continue;
        }
        const row = await prisma.job.update({
          where: { id: candidate.id },
          data: {
            status: 'leased',
            attempts: candidate.attempts + 1,
            leaseDeviceId: input.deviceId,
            leaseExpiresAt: at + JOB_LEASE_MS,
            startedAt: candidate.startedAt ?? at,
          },
        });
        log.info(`Job claimed: ${row.id} by device ${input.deviceId} (attempt ${row.attempts})`);
        return viewJob(row);
      }
      return null;
    })
  );
}

export type LeaseOutcome<T> =
  | { ok: true; value: T }
  | { ok: false; reason: 'not_found' | 'not_yours' };

/** The row, if `deviceId` holds its live lease right now. */
async function heldLease(
  prisma: PrismaClient,
  id: string,
  deviceId: string,
  at: number
): Promise<LeaseOutcome<Job>> {
  const row = await prisma.job.findUnique({ where: { id } });
  if (row === null) return { ok: false, reason: 'not_found' };
  const held =
    row.status === 'leased' &&
    row.leaseDeviceId === deviceId &&
    row.leaseExpiresAt !== null &&
    row.leaseExpiresAt > at;
  return held ? { ok: true, value: row } : { ok: false, reason: 'not_yours' };
}

/** Extends the lease by `JOB_LEASE_MS` from now. A lapsed or reassigned lease is `not_yours`. */
export async function heartbeatJob(
  { prisma, now }: JobsDeps,
  input: { id: string; deviceId: string; epoch?: number }
): Promise<LeaseOutcome<{ leaseExpiresAt: number }>> {
  return withVaultWriter(input.epoch, () =>
    withKeyLock(CLAIM_LOCK, async () => {
      const at = now();
      const held = await heldLease(prisma, input.id, input.deviceId, at);
      if (!held.ok) return held;
      const leaseExpiresAt = at + JOB_LEASE_MS;
      await prisma.job.update({ where: { id: input.id }, data: { leaseExpiresAt } });
      return { ok: true, value: { leaseExpiresAt } };
    })
  );
}

/** Closes the job with the outcome the Mac reports. The lease must still be this device's. */
export async function completeJob(
  { prisma, now }: JobsDeps,
  input: { id: string; deviceId: string; outcome: 'ok' | 'failed'; note?: string; epoch?: number }
): Promise<LeaseOutcome<JobView>> {
  return withVaultWriter(input.epoch, () =>
    withKeyLock(CLAIM_LOCK, async () => {
      const at = now();
      const held = await heldLease(prisma, input.id, input.deviceId, at);
      if (!held.ok) return held;
      const row = await prisma.job.update({
        where: { id: input.id },
        data: {
          status: input.outcome === 'ok' ? 'done' : 'failed',
          outcome: input.outcome,
          note: input.note ?? null,
          finishedAt: at,
          leaseDeviceId: null,
          leaseExpiresAt: null,
        },
      });
      log.info(`Job ${row.status}: ${row.id} (${row.outcome})`);
      return { ok: true, value: viewJob(row) };
    })
  );
}

export type JobsSummary = {
  /** Jobs waiting for a Mac: queued, plus leases that have lapsed. */
  depth: number;
  /** Leases that are live right now. */
  leased: number;
  /** The last few finished jobs, most recent first. */
  recent: JobView[];
};

/** What the admin page shows: queue depth and the last few outcomes, nothing more (spec §8). */
export async function jobsSummary({ prisma, now }: JobsDeps): Promise<JobsSummary> {
  const at = now();
  const [depth, leased, recent] = await Promise.all([
    prisma.job.count({
      where: { OR: [{ status: 'queued' }, { status: 'leased', leaseExpiresAt: { lte: at } }] },
    }),
    prisma.job.count({ where: { status: 'leased', leaseExpiresAt: { gt: at } } }),
    prisma.job.findMany({
      where: { status: { in: ['done', 'failed'] } },
      orderBy: { finishedAt: 'desc' },
      take: RECENT_JOBS,
    }),
  ]);
  return { depth, leased, recent: recent.map(viewJob) };
}
