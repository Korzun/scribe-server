import * as crypto from 'crypto';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import { HashMismatchError } from './blob-store';
import { getBlob, putBlob, type BlobsDeps } from './blobs';

vi.mock('../logger');

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
// putBlob stores whatever it is given; the sealed-header check is the route's.
const blob = (text: string) => Buffer.from(`SCRB\x01${text}`, 'latin1');

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let h: Harness;
let deps: BlobsDeps;
beforeEach(async () => {
  h = await createHarness();
  deps = { prisma: h.prisma, blobStore: h.blobStore, now: () => h.now.value };
});
afterEach(async () => {
  await h.close();
});

describe('putBlob', () => {
  it('writes from a stream and records the meeting on first sight', async () => {
    const id = crypto.randomUUID();
    const bytes = blob('streamed');
    const res = await putBlob(deps, {
      scope: id,
      kind: 'audio-mic',
      stream: Readable.from([bytes]),
      sha256: sha(bytes),
      size: bytes.length,
      ifMatch: null,
      deviceId: null,
    });

    expect(res).toEqual({ ok: true, revision: 1, seq: 1, sha256: sha(bytes), size: bytes.length });
    expect(await h.prisma.meeting.findUnique({ where: { id } })).toEqual({
      id,
      createdAt: h.now.value,
      deletedAt: null,
      purgeAfter: null,
    });
    const got = await getBlob(deps, id, 'audio-mic');
    expect(got).toMatchObject({ revision: 1, sha256: sha(bytes), size: bytes.length });
    expect((await readAll(got!.stream)).equals(bytes)).toBe(true);
  });

  it('a stream whose hash differs rejects and leaves no row', async () => {
    const id = crypto.randomUUID();
    const bytes = blob('streamed');
    await expect(
      putBlob(deps, {
        scope: id,
        kind: 'audio-mic',
        stream: Readable.from([bytes]),
        sha256: sha(blob('other')),
        size: bytes.length,
        ifMatch: null,
        deviceId: null,
      })
    ).rejects.toBeInstanceOf(HashMismatchError);
    expect(await h.prisma.blob.count()).toBe(0);
    expect(await h.prisma.change.count()).toBe(0);
    expect(await h.blobStore.totalBytes()).toBe(0);
  });

  it('library-scoped writes log a change without a meeting', async () => {
    const bytes = blob('tags');
    const res = await putBlob(deps, {
      scope: 'library',
      kind: 'tag-list',
      bytes,
      sha256: sha(bytes),
      size: bytes.length,
      ifMatch: null,
      deviceId: null,
    });

    expect(res.ok).toBe(true);
    expect(await h.prisma.meeting.count()).toBe(0);
    expect(await h.prisma.change.findFirst()).toMatchObject({
      meetingId: null,
      kind: 'tag-list',
      revision: 1,
    });
  });

  it('a deleted meeting is gone and nothing is stored', async () => {
    const id = crypto.randomUUID();
    await h.prisma.meeting.create({ data: { id, createdAt: 1, deletedAt: 2, purgeAfter: 3 } });
    const bytes = blob('late');

    const res = await putBlob(deps, {
      scope: id,
      kind: 'manifest',
      bytes,
      sha256: sha(bytes),
      size: bytes.length,
      ifMatch: null,
      deviceId: null,
    });

    expect(res).toEqual({ ok: false, reason: 'gone' });
    expect(await h.blobStore.exists(sha(bytes))).toBe(false);
    expect(await h.prisma.change.count()).toBe(0);
  });

  it('getBlob is null for an absent blob', async () => {
    expect(await getBlob(deps, crypto.randomUUID(), 'manifest')).toBeNull();
  });
});
