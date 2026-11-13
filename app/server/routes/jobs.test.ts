import { randomUUID } from 'crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { blobAad, seal } from '../crypto/seal';
import { JOB_LEASE_MS, MAX_JOB_ATTEMPTS } from '../services/jobs';
import { createHarness, type Harness } from '../test-support/harness';
import {
  JOB_LEASE_MS as CLIENT_LEASE_MS,
  JOB_HEARTBEAT_INTERVAL_MS,
} from '../test-support/http-vault-client';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

let h: Harness;
let client: VaultClient;
let owner: Owner;
let session: string;
let secondMac: { token: string; id: string };
let meeting: string;
let deleted: string;

beforeAll(async () => {
  h = await createHarness();
  client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code', name: 'Mac A' });
  expect(
    (await client.login({ password: owner.password, secretKey: owner.secretKey })).status
  ).toBe(200);
  session = client.asSession();
  const enrolled = await client.enrol({
    password: owner.password,
    secretKey: owner.secretKey,
    name: 'Mac B',
  });
  secondMac = { token: enrolled.body.deviceToken!, id: enrolled.body.deviceId! };

  const put = async (id: string) => {
    const bytes = seal(
      owner.libraryKey,
      Buffer.from('{}'),
      blobAad(owner.libraryId, id, 'manifest', 1)
    );
    expect(
      (
        await client.putMeetingBlob({
          token: owner.deviceToken,
          meetingId: id,
          kind: 'manifest',
          bytes,
          ifMatch: null,
        })
      ).status
    ).toBe(201);
  };
  meeting = randomUUID();
  await put(meeting);
  deleted = randomUUID();
  await put(deleted);
  expect((await client.deleteMeeting(owner.deviceToken, deleted)).status).toBe(204);
}, 60_000);
afterAll(async () => {
  await h.close();
});
beforeEach(async () => {
  await h.prisma.job.deleteMany();
});

const enqueue = (id = meeting, reason = 'new pipeline', token = owner.deviceToken) =>
  client.enqueueJob(token, { meetingId: id, reason });

describe('the lease constants the client documents', () => {
  it('match the service, and a heartbeat comes well inside a lease', () => {
    expect(CLIENT_LEASE_MS).toBe(JOB_LEASE_MS);
    expect(JOB_HEARTBEAT_INTERVAL_MS * 2).toBeLessThanOrEqual(JOB_LEASE_MS);
  });
});

describe('POST /api/v1/jobs', () => {
  it('enqueues for a live meeting, returns the same job while it waits, and records who asked', async () => {
    const first = await enqueue(meeting, 'new pipeline', session);
    expect(first.status).toBe(201);
    expect(first.body.job).toMatchObject({
      meetingId: meeting,
      reason: 'new pipeline',
      requestedBy: 'session',
      status: 'queued',
      attempts: 0,
      leaseDeviceId: null,
      createdAt: h.now.value,
    });
    const again = await enqueue(meeting, 'again');
    expect(again.status).toBe(200);
    expect(again.body.job!.id).toBe(first.body.job!.id);
    expect(again.body.job!.reason).toBe('new pipeline');

    const byDevice = await enqueue(randomUUID(), 'x', owner.deviceToken);
    expect(byDevice.status).toBe(404);
  });

  it('a Mac may enqueue too, and is named as the requester', async () => {
    const res = await enqueue(meeting, 'reprocess', owner.deviceToken);
    expect(res.status).toBe(201);
    expect(res.body.job!.requestedBy).toBe(`device:${owner.deviceId}`);
  });

  it('refuses an unknown or deleted meeting, a malformed body, and no credential', async () => {
    expect((await enqueue(randomUUID())).status).toBe(404);
    expect((await enqueue(deleted)).status).toBe(404);
    for (const body of [
      {},
      { meetingId: meeting },
      { meetingId: 'nope', reason: 'x' },
      { meetingId: meeting, reason: '' },
    ]) {
      expect((await client.enqueueJob(owner.deviceToken, body)).status, JSON.stringify(body)).toBe(
        400
      );
    }
    expect((await client.enqueueJob('', { meetingId: meeting, reason: 'x' })).status).toBe(401);
  });
});

describe('claim, heartbeat, complete', () => {
  it('claims the oldest job with a lease, 204 when the queue is empty, and only a device may claim', async () => {
    expect((await client.claimJob(owner.deviceToken)).status).toBe(204);
    const other = randomUUID();
    const bytes = seal(
      owner.libraryKey,
      Buffer.from('{}'),
      blobAad(owner.libraryId, other, 'manifest', 1)
    );
    await client.putMeetingBlob({
      token: owner.deviceToken,
      meetingId: other,
      kind: 'manifest',
      bytes,
      ifMatch: null,
    });
    const first = (await enqueue()).body.job!;
    h.now.value += 1000;
    await enqueue(other);

    expect((await client.claimJob(session)).status).toBe(401);
    const claimed = await client.claimJob(owner.deviceToken);
    expect(claimed.status).toBe(200);
    expect(claimed.body.job).toMatchObject({
      id: first.id,
      status: 'leased',
      attempts: 1,
      leaseDeviceId: owner.deviceId,
      leaseExpiresAt: h.now.value + JOB_LEASE_MS,
      startedAt: h.now.value,
    });
    const second = await client.claimJob(secondMac.token);
    expect(second.body.job!.meetingId).toBe(other);
    expect((await client.claimJob(owner.deviceToken)).status).toBe(204);
  });

  it('two devices claiming at once get one job each, never the same one', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 2; i++) {
      const id = randomUUID();
      const bytes = seal(
        owner.libraryKey,
        Buffer.from('{}'),
        blobAad(owner.libraryId, id, 'manifest', 1)
      );
      await client.putMeetingBlob({
        token: owner.deviceToken,
        meetingId: id,
        kind: 'manifest',
        bytes,
        ifMatch: null,
      });
      await enqueue(id);
      ids.push(id);
    }
    const [a, b] = await Promise.all([
      client.claimJob(owner.deviceToken),
      client.claimJob(secondMac.token),
    ]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(new Set([a.body.job!.meetingId, b.body.job!.meetingId])).toEqual(new Set(ids));
  });

  it('heartbeat extends the lease; complete records the outcome and the summary shows it', async () => {
    await enqueue();
    const job = (await client.claimJob(owner.deviceToken)).body.job!;
    h.now.value += 60_000;
    const beat = await client.heartbeatJob(owner.deviceToken, job.id);
    expect(beat.status).toBe(200);
    expect(beat.body.leaseExpiresAt).toBe(h.now.value + JOB_LEASE_MS);

    h.now.value += 60_000;
    const done = await client.completeJob(owner.deviceToken, job.id, {
      outcome: 'ok',
      note: 'reprocessed',
    });
    expect(done.status).toBe(200);
    expect(done.body.job).toMatchObject({
      status: 'done',
      outcome: 'ok',
      note: 'reprocessed',
      finishedAt: h.now.value,
      leaseDeviceId: null,
      leaseExpiresAt: null,
    });
    // Finished is finished: no second completion, no heartbeat.
    expect(
      (await client.completeJob(owner.deviceToken, job.id, { outcome: 'failed' })).status
    ).toBe(409);
    expect((await client.heartbeatJob(owner.deviceToken, job.id)).status).toBe(409);

    const summary = await client.listJobs(owner.deviceToken);
    expect(summary.status).toBe(200);
    expect(summary.body).toMatchObject({ depth: 0, leased: 0 });
    expect(summary.body.recent!.map((j) => j.id)).toEqual([job.id]);
  });

  it('the other device, an unknown id and a bad body are refused', async () => {
    await enqueue();
    const job = (await client.claimJob(owner.deviceToken)).body.job!;
    expect((await client.heartbeatJob(secondMac.token, job.id)).status).toBe(409);
    expect((await client.completeJob(secondMac.token, job.id, { outcome: 'ok' })).status).toBe(409);
    expect((await client.heartbeatJob(owner.deviceToken, 'nope')).status).toBe(404);
    expect((await client.completeJob(owner.deviceToken, job.id, { outcome: 'meh' })).status).toBe(
      400
    );
    expect((await client.heartbeatJob(session, job.id)).status).toBe(401);
  });

  it('a lapsed lease returns the job to the queue, and the first device has lost it', async () => {
    await enqueue();
    const job = (await client.claimJob(owner.deviceToken)).body.job!;
    h.now.value += JOB_LEASE_MS;
    expect((await client.listJobs(owner.deviceToken)).body).toMatchObject({ depth: 1, leased: 0 });

    const reclaimed = await client.claimJob(secondMac.token);
    expect(reclaimed.body.job).toMatchObject({
      id: job.id,
      attempts: 2,
      leaseDeviceId: secondMac.id,
    });
    expect((await client.heartbeatJob(owner.deviceToken, job.id)).status).toBe(409);
    expect((await client.completeJob(owner.deviceToken, job.id, { outcome: 'ok' })).status).toBe(
      409
    );
    expect(
      (await client.completeJob(secondMac.token, job.id, { outcome: 'failed', note: 'no audio' }))
        .status
    ).toBe(200);
    expect((await client.listJobs(owner.deviceToken)).body.recent![0]).toMatchObject({
      outcome: 'failed',
      note: 'no audio',
    });
  });

  it(`the ${MAX_JOB_ATTEMPTS}rd lapse fails the job instead of handing it out again`, async () => {
    await enqueue();
    for (let attempt = 1; attempt <= MAX_JOB_ATTEMPTS; attempt++) {
      const claimed = await client.claimJob(owner.deviceToken);
      expect(claimed.status).toBe(200);
      expect(claimed.body.job!.attempts).toBe(attempt);
      h.now.value += JOB_LEASE_MS;
    }
    expect((await client.claimJob(owner.deviceToken)).status).toBe(204);
    const summary = await client.listJobs(owner.deviceToken);
    expect(summary.body.depth).toBe(0);
    expect(summary.body.recent![0]).toMatchObject({
      status: 'failed',
      outcome: 'lapsed',
      attempts: MAX_JOB_ATTEMPTS,
    });
  });
});
