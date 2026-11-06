import * as crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import { putBlob, tombstoneMeeting, type BlobsDeps } from './blobs';
import { createGarbageCollector } from './gc';

vi.mock('../logger');

const DAY = 24 * 60 * 60 * 1000;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const blob = (text: string) => Buffer.from(`SCRB\x01${text}`, 'latin1');

let h: Harness;
let deps: BlobsDeps;
beforeEach(async () => {
  h = await createHarness();
  deps = { prisma: h.prisma, blobStore: h.blobStore, now: () => h.now.value };
});
afterEach(async () => {
  await h.close();
});

async function write(scope: string, kind: string, bytes: Buffer): Promise<void> {
  const res = await putBlob(deps, {
    scope,
    kind,
    bytes,
    sha256: sha(bytes),
    size: bytes.length,
    ifMatch: null,
    deviceId: null,
  });
  if (!res.ok) throw new Error(`write: ${res.reason}`);
}

const gc = () =>
  createGarbageCollector({ prisma: h.prisma, blobStore: h.blobStore, now: deps.now });

describe('createGarbageCollector', () => {
  it('a meeting deleted six days ago keeps its files; seven days and one second later they are gone and the change rows remain', async () => {
    const id = crypto.randomUUID();
    const manifest = blob('manifest');
    const audio = blob('audio');
    await write(id, 'manifest', manifest);
    await write(id, 'audio-mic', audio);
    expect(await tombstoneMeeting(deps, id, null)).toBe('deleted');
    const changesBefore = await h.prisma.change.count();
    const deletedAt = h.now.value;

    h.now.value = deletedAt + 6 * DAY;
    expect(await gc().sweep()).toEqual({ purgedMeetings: 0, removedFiles: 0, expiredUploads: 0 });
    expect(await h.blobStore.exists(sha(manifest))).toBe(true);
    expect(await h.blobStore.exists(sha(audio))).toBe(true);
    expect(await h.prisma.blob.count({ where: { scope: id } })).toBe(2);

    h.now.value = deletedAt + 7 * DAY + 1000;
    expect(await gc().sweep()).toEqual({ purgedMeetings: 1, removedFiles: 2, expiredUploads: 0 });
    expect(await h.blobStore.exists(sha(manifest))).toBe(false);
    expect(await h.blobStore.exists(sha(audio))).toBe(false);
    expect(await h.prisma.blob.count({ where: { scope: id } })).toBe(0);
    // The tombstone and the whole history stay: a late Mac still learns of the deletion.
    expect(await h.prisma.meeting.findUnique({ where: { id } })).toMatchObject({ deletedAt });
    expect(await h.prisma.change.count()).toBe(changesBefore);

    // An already-purged tombstone is not counted again.
    expect(await gc().sweep()).toEqual({ purgedMeetings: 0, removedFiles: 0, expiredUploads: 0 });
  });

  it('a file shared with a live blob survives the purge', async () => {
    const dead = crypto.randomUUID();
    const live = crypto.randomUUID();
    const shared = blob('same bytes');
    const own = blob('only the dead meeting');
    await write(dead, 'summary', shared);
    await write(dead, 'transcript', own);
    await write(live, 'summary', shared);
    await write('library', 'tag-list', blob('tags'));
    await tombstoneMeeting(deps, dead, null);

    const result = await createGarbageCollector({
      prisma: h.prisma,
      blobStore: h.blobStore,
      now: deps.now,
      graceMs: 0,
    }).sweep();

    expect(result).toEqual({ purgedMeetings: 1, removedFiles: 1, expiredUploads: 0 });
    expect(await h.blobStore.exists(sha(shared))).toBe(true);
    expect(await h.blobStore.exists(sha(own))).toBe(false);
    expect(await h.prisma.blob.count({ where: { scope: live } })).toBe(1);
    expect(await h.prisma.blob.count({ where: { scope: 'library' } })).toBe(1);
  });

  it('graceMs 0 purges every deleted meeting now and leaves live ones alone', async () => {
    const dead = crypto.randomUUID();
    const live = crypto.randomUUID();
    await write(dead, 'manifest', blob('dead'));
    await write(live, 'manifest', blob('live'));
    await tombstoneMeeting(deps, dead, null);

    expect(await gc().sweep()).toMatchObject({ purgedMeetings: 0 });
    expect(await gc().sweep({ graceMs: 0 })).toMatchObject({ purgedMeetings: 1, removedFiles: 1 });
    expect(await h.prisma.blob.count({ where: { scope: live } })).toBe(1);
  });

  it('expires abandoned uploads through the uploads hook', async () => {
    const expire = vi.fn(async (_now: number) => 3);
    const result = await createGarbageCollector({
      prisma: h.prisma,
      blobStore: h.blobStore,
      now: deps.now,
      uploads: { expire },
    }).sweep();

    expect(result).toEqual({ purgedMeetings: 0, removedFiles: 0, expiredUploads: 3 });
    expect(expire).toHaveBeenCalledWith(h.now.value);
  });
});
