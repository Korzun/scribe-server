import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { blobAad, seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

const MiB = 1024 * 1024;
const DAY = 24 * 60 * 60 * 1000;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

let h: Harness;
let client: VaultClient;
let owner: Owner;
/** A second Mac of the same library. */
let other: string;
beforeAll(async () => {
  h = await createHarness();
  client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code' });
  other = (await enrol('Other Mac')).deviceToken;
}, 60_000);
afterAll(async () => {
  await h.close();
});

async function enrol(name: string) {
  const res = await client.enrol({ password: owner.password, secretKey: owner.secretKey, name });
  if (res.status !== 201) throw new Error(`enrol: ${res.status}`);
  return { deviceToken: res.body.deviceToken!, deviceId: res.body.deviceId! };
}

/** A sealed audio blob of `size` bytes (random plaintext under the real Library Key). */
function sealedAudio(meetingId: string, size: number): Buffer {
  const overhead = 5 + 12 + 16;
  return seal(
    owner.libraryKey,
    crypto.randomBytes(size - overhead),
    blobAad(owner.libraryId, meetingId, 'audio-mic', 1)
  );
}

const uploadDir = (id: string) => path.join(h.dataDir, 'uploads', id);
const part = (bytes: Buffer, n: number, partSize: number) =>
  bytes.subarray(n * partSize, Math.min(bytes.length, (n + 1) * partSize));

async function begin(
  bytes: Buffer,
  opts: { meetingId?: string | null; token?: string; sha256?: string; kind?: string } = {}
) {
  const res = await client.beginUpload(opts.token ?? owner.deviceToken, {
    meetingId: opts.meetingId === undefined ? crypto.randomUUID() : opts.meetingId,
    kind: opts.kind ?? 'audio-mic',
    size: bytes.length,
    sha256: opts.sha256 ?? sha(bytes),
    partSize: MiB,
    ifMatch: null,
  });
  expect(res.status).toBe(201);
  return res.body.uploadId!;
}

describe('POST /api/v1/uploads', () => {
  const valid = () => ({
    meetingId: crypto.randomUUID(),
    kind: 'audio-mic',
    size: 100,
    sha256: sha(Buffer.from('x')),
    ifMatch: null,
  });

  it('answers 201 with the id, the 16 MiB default part size and the deadline', async () => {
    const res = await client.beginUpload(owner.deviceToken, valid());
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      uploadId: expect.stringMatching(/^[A-Za-z0-9]{21}$/),
      partSize: 16 * MiB,
      expiresAt: h.now.value + 7 * DAY,
    });
  });

  it('accepts a library kind when meetingId is null', async () => {
    const res = await client.beginUpload(owner.deviceToken, {
      ...valid(),
      meetingId: null,
      kind: `voice/${crypto.randomUUID()}`,
    });
    expect(res.status).toBe(201);
  });

  it('is 400 on an unknown kind, a non-UUID meeting, a bad hash, a bad part size, or a size over 2^31-1', async () => {
    const bad = [
      { ...valid(), kind: 'audio-everything' },
      { ...valid(), kind: 'tag-list' }, // a library kind under a meeting
      { ...valid(), meetingId: null, kind: 'audio-mic' }, // a meeting kind in the library
      { ...valid(), meetingId: null, kind: 'voice/../x' },
      { ...valid(), meetingId: 'not-a-uuid' },
      { ...valid(), sha256: 'ABCDEF' },
      { ...valid(), partSize: MiB - 1 },
      { ...valid(), partSize: 64 * MiB + 1 },
      { ...valid(), size: 2 ** 31 },
      { ...valid(), size: 0 },
      { ...valid(), size: '100' },
      { ...valid(), ifMatch: undefined },
      { ...valid(), ifMatch: -1 },
    ];
    for (const body of bad) {
      const res = await client.beginUpload(owner.deviceToken, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
  });

  it('an uppercase voice id or meeting id is 400 and begins nothing', async () => {
    const before = await h.prisma.upload.count();
    for (const body of [
      { ...valid(), meetingId: null, kind: `voice/${crypto.randomUUID().toUpperCase()}` },
      { ...valid(), meetingId: crypto.randomUUID().toUpperCase() },
    ]) {
      const res = await client.beginUpload(owner.deviceToken, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
    expect(await h.prisma.upload.count()).toBe(before);
  });

  it('a session token is refused for upload routes', async () => {
    const browser = new VaultClient(h.app);
    expect(
      (await browser.login({ password: owner.password, secretKey: owner.secretKey })).status
    ).toBe(200);
    const session = browser.asSession();
    const id = await begin(Buffer.alloc(100));

    expect((await client.beginUpload(session, valid())).status).toBe(401);
    expect((await client.putPart(session, id, 0, Buffer.alloc(100))).status).toBe(401);
    expect((await client.inspectUpload(session, id)).status).toBe(401);
    expect((await client.completeUpload(session, id)).status).toBe(401);
    expect((await client.abortUpload(session, id)).status).toBe(401);
  });
});

describe('the upload dance', () => {
  it('three parts out of order then complete yields one blob and one change', async () => {
    const meetingId = crypto.randomUUID();
    const bytes = sealedAudio(meetingId, 2 * MiB + 1000);
    const id = await begin(bytes, { meetingId });
    const changesBefore = await h.prisma.change.count();

    for (const n of [2, 0, 1]) {
      const res = await client.putPart(owner.deviceToken, id, n, part(bytes, n, MiB));
      expect(res.status).toBe(204);
    }
    const res = await client.completeUpload(owner.deviceToken, id);
    expect(res.status).toBe(201);
    // The hash the vault computed, which the Mac compares before deleting its WAVs.
    expect(res.body).toEqual({
      revision: 1,
      seq: expect.any(Number),
      sha256: sha(bytes),
      size: bytes.length,
    });

    expect(await h.prisma.blob.count({ where: { scope: meetingId } })).toBe(1);
    expect(await h.prisma.change.count()).toBe(changesBefore + 1);
    expect(fs.existsSync(uploadDir(id))).toBe(false);
    const got = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId,
      kind: 'audio-mic',
    });
    expect(got.bytes.equals(bytes)).toBe(true);

    // A completed session is gone.
    expect((await client.inspectUpload(owner.deviceToken, id)).status).toBe(404);
    expect((await client.completeUpload(owner.deviceToken, id)).status).toBe(404);
  });

  it('inspect lists the parts received so a client can resume', async () => {
    const bytes = sealedAudio(crypto.randomUUID(), 3 * MiB + 7);
    const id = await begin(bytes);
    await client.putPart(owner.deviceToken, id, 1, part(bytes, 1, MiB));
    await client.putPart(owner.deviceToken, id, 3, part(bytes, 3, MiB));

    const res = await client.inspectUpload(owner.deviceToken, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      parts: [1, 3],
      missing: [0, 2],
      partSize: MiB,
      size: bytes.length,
      expiresAt: expect.any(Number),
    });
  });

  it('completing with a missing part is 409 Incomplete and lists the missing parts', async () => {
    const meetingId = crypto.randomUUID();
    const bytes = sealedAudio(meetingId, 2 * MiB + 7);
    const id = await begin(bytes, { meetingId });
    await client.putPart(owner.deviceToken, id, 0, part(bytes, 0, MiB));

    const res = await client.completeUpload(owner.deviceToken, id);
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Incomplete', missing: [1, 2] });
    expect(await h.prisma.blob.count({ where: { scope: meetingId } })).toBe(0);
  });

  it('completing with a wrong declared hash is 400, the parts remain, and no blob exists', async () => {
    const meetingId = crypto.randomUUID();
    const bytes = sealedAudio(meetingId, MiB + 7);
    const id = await begin(bytes, { meetingId, sha256: sha(Buffer.from('not these bytes')) });
    await client.putPart(owner.deviceToken, id, 0, part(bytes, 0, MiB));
    await client.putPart(owner.deviceToken, id, 1, part(bytes, 1, MiB));

    const res = await client.completeUpload(owner.deviceToken, id);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Hash mismatch' });
    expect(fs.readdirSync(uploadDir(id)).sort()).toEqual(['0', '1']);
    expect(await h.prisma.blob.count({ where: { scope: meetingId } })).toBe(0);
    expect((await client.inspectUpload(owner.deviceToken, id)).body.parts).toEqual([0, 1]);
  });

  it('the first five bytes are checked on complete: plaintext is 400 Not a sealed blob', async () => {
    const meetingId = crypto.randomUUID();
    const bytes = Buffer.alloc(MiB + 7, 'plain');
    const id = await begin(bytes, { meetingId });
    await client.putPart(owner.deviceToken, id, 0, part(bytes, 0, MiB));
    await client.putPart(owner.deviceToken, id, 1, part(bytes, 1, MiB));

    const res = await client.completeUpload(owner.deviceToken, id);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Not a sealed blob' });
    expect(await h.prisma.blob.count({ where: { scope: meetingId } })).toBe(0);
  });

  it('a part of the wrong length is 400, a part over the part size is 413, a bad number is 400', async () => {
    const bytes = sealedAudio(crypto.randomUUID(), 2 * MiB + 7);
    const id = await begin(bytes);
    const short = await client.putPart(owner.deviceToken, id, 0, Buffer.alloc(MiB - 1));
    expect(short.status).toBe(400);
    expect(short.body).toEqual({ error: 'Invalid part' });
    const lastTooLong = await client.putPart(owner.deviceToken, id, 2, Buffer.alloc(8));
    expect(lastTooLong.status).toBe(400);
    expect(lastTooLong.body).toEqual({ error: 'Invalid part' });
    expect((await client.putPart(owner.deviceToken, id, 3, Buffer.alloc(7))).status).toBe(400);
    expect((await client.putPart(owner.deviceToken, id, 'x', Buffer.alloc(7))).status).toBe(400);
    const tooBig = await client.putPart(owner.deviceToken, id, 0, Buffer.alloc(MiB + 1));
    expect(tooBig.status).toBe(413);
    expect((await client.inspectUpload(owner.deviceToken, id)).body.parts).toEqual([]);
  });

  it('a conflict and a deleted meeting are answered like a direct PUT', async () => {
    const meetingId = crypto.randomUUID();
    const first = sealedAudio(meetingId, 1000);
    expect(
      (
        await client.upload({
          token: owner.deviceToken,
          meetingId,
          kind: 'audio-mic',
          bytes: first,
          partSize: MiB,
          ifMatch: null,
        })
      ).status
    ).toBe(201);

    const again = await client.upload({
      token: owner.deviceToken,
      meetingId,
      kind: 'audio-mic',
      bytes: sealedAudio(meetingId, 1000),
      partSize: MiB,
      ifMatch: null,
    });
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Revision conflict', currentRevision: 1 });

    const update = await client.upload({
      token: owner.deviceToken,
      meetingId,
      kind: 'audio-mic',
      bytes: sealedAudio(meetingId, 1000),
      partSize: MiB,
      ifMatch: 1,
    });
    expect(update.status).toBe(200);
    expect(update.body.revision).toBe(2);

    expect((await client.deleteMeeting(owner.deviceToken, meetingId)).status).toBe(204);
    const gone = await client.upload({
      token: owner.deviceToken,
      meetingId,
      kind: 'audio-system',
      bytes: sealedAudio(meetingId, 1000),
      partSize: MiB,
      ifMatch: null,
    });
    expect(gone.status).toBe(410);
    expect(gone.body).toEqual({ error: 'Meeting deleted' });
  });

  it('a 40 MiB upload in 16 MiB parts round-trips byte-exact', async () => {
    const meetingId = crypto.randomUUID();
    const bytes = sealedAudio(meetingId, 40 * MiB);
    const res = await client.upload({
      token: owner.deviceToken,
      meetingId,
      kind: 'audio-mic',
      bytes,
      partSize: 16 * MiB,
      ifMatch: null,
    });
    expect(res.status).toBe(201);
    expect(res.body.sha256).toBe(sha(bytes));
    const got = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId,
      kind: 'audio-mic',
    });
    expect(got.status).toBe(200);
    expect(got.sha256).toBe(sha(bytes));
    expect(got.bytes.equals(bytes)).toBe(true);
  }, 60_000);

  it('DELETE aborts the session and removes its parts', async () => {
    const bytes = sealedAudio(crypto.randomUUID(), 1000);
    const id = await begin(bytes);
    await client.putPart(owner.deviceToken, id, 0, bytes);
    expect((await client.abortUpload(owner.deviceToken, id)).status).toBe(204);
    expect(fs.existsSync(uploadDir(id))).toBe(false);
    expect((await client.inspectUpload(owner.deviceToken, id)).status).toBe(404);
    expect((await client.abortUpload(owner.deviceToken, id)).status).toBe(404);
  });
});

describe('who may touch a session', () => {
  it('another device cannot see or complete the session', async () => {
    const meetingId = crypto.randomUUID();
    const bytes = sealedAudio(meetingId, 1000);
    const id = await begin(bytes, { meetingId });
    await client.putPart(owner.deviceToken, id, 0, bytes);

    for (const res of [
      await client.inspectUpload(other, id),
      await client.putPart(other, id, 0, bytes),
      await client.completeUpload(other, id),
      await client.abortUpload(other, id),
    ]) {
      expect(res.status).toBe(404);
      expect(res.body).toEqual({ error: 'Not found' });
    }
    expect(await h.prisma.blob.count({ where: { scope: meetingId } })).toBe(0);
    expect((await client.completeUpload(owner.deviceToken, id)).status).toBe(201);
  });

  it('an unknown id is 404', async () => {
    expect((await client.inspectUpload(owner.deviceToken, 'nope')).status).toBe(404);
    expect((await client.completeUpload(owner.deviceToken, 'nope')).status).toBe(404);
  });

  it('a device revoked after begin gets 401 on the next part and on complete, and no blob exists', async () => {
    const mac = await enrol('Soon revoked');
    const meetingId = crypto.randomUUID();
    const bytes = sealedAudio(meetingId, MiB + 7);
    const id = await begin(bytes, { meetingId, token: mac.deviceToken });
    expect((await client.putPart(mac.deviceToken, id, 0, part(bytes, 0, MiB))).status).toBe(204);

    expect((await client.revokeDevice(owner.deviceToken, mac.deviceId)).status).toBe(204);
    const next = await client.putPart(mac.deviceToken, id, 1, part(bytes, 1, MiB));
    expect(next.status).toBe(401);
    expect(next.body).toEqual({ error: 'Unauthorized' });
    expect((await client.completeUpload(mac.deviceToken, id)).status).toBe(401);
    expect(await h.prisma.blob.count({ where: { scope: meetingId } })).toBe(0);
  });
});

describe('expiry', () => {
  it('a session older than seven days is removed by the sweep with its parts', async () => {
    const bytes = sealedAudio(crypto.randomUUID(), 1000);
    const id = await begin(bytes);
    await client.putPart(owner.deviceToken, id, 0, bytes);

    h.now.value += 7 * DAY - 1000;
    expect((await h.gc.sweep()).expiredUploads).toBe(0);
    expect(fs.existsSync(uploadDir(id))).toBe(true);

    h.now.value += 1000;
    expect((await h.gc.sweep()).expiredUploads).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(uploadDir(id))).toBe(false);
    expect(await h.prisma.upload.findUnique({ where: { id } })).toBeNull();
    expect((await client.inspectUpload(owner.deviceToken, id)).status).toBe(404);
  });
});

describe('a keys-lost reset', () => {
  let r: Harness;
  let rc: VaultClient;
  beforeAll(async () => {
    r = await createHarness();
    rc = new VaultClient(r.app);
    writeSetupCode(r.dataDir, 'test-setup-code');
  });
  afterAll(async () => {
    await r.close();
  });

  it('a session begun before a reset cannot complete after it (401, no blob)', async () => {
    const first = await createOwner(rc, { setupCode: 'test-setup-code' });
    const meetingId = crypto.randomUUID();
    const bytes = Buffer.concat([Buffer.from('SCRB\x01', 'latin1'), crypto.randomBytes(1000)]);
    const begun = await rc.beginUpload(first.deviceToken, {
      meetingId,
      kind: 'audio-mic',
      size: bytes.length,
      sha256: sha(bytes),
      ifMatch: null,
    });
    const id = begun.body.uploadId!;
    expect((await rc.putPart(first.deviceToken, id, 0, bytes)).status).toBe(204);

    expect(
      (await rc.deleteLibrary({ setupCode: 'test-setup-code', confirm: 'DELETE' })).status
    ).toBe(204);
    expect((await r.prisma.setting.findUnique({ where: { key: 'reset_epoch' } }))?.value).toBe('1');
    const second = await createOwner(rc, { setupCode: 'test-setup-code' });

    expect((await rc.completeUpload(first.deviceToken, id)).status).toBe(401);
    // Not even the new library's own device can finish the old session.
    expect((await rc.completeUpload(second.deviceToken, id)).status).toBe(404);
    expect(await r.prisma.blob.count()).toBe(0);
    expect(await r.prisma.upload.count()).toBe(0);
    // Its stray parts go with the next sweep.
    await r.gc.sweep();
    expect(fs.existsSync(path.join(r.dataDir, 'uploads', id))).toBe(false);
  }, 60_000);
});
