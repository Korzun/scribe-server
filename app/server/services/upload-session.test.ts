import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import { getBlob } from './blobs';
import {
  createUploadSessions,
  DEFAULT_PART_SIZE,
  InvalidUploadError,
  MAX_PART_SIZE,
  MIN_PART_SIZE,
  UPLOAD_TTL_MS,
  type UploadSessions,
} from './upload-session';
import { currentEpoch, VaultResetError, withVaultReset } from './vault-gate';

vi.mock('../logger');

const MiB = 1024 * 1024;
const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
/** Bytes that pass the vault's only check of a seal: the `SCRB\x01` header. */
const sealedBytes = (size: number) =>
  Buffer.concat([Buffer.from('SCRB\x01', 'latin1'), crypto.randomBytes(size - 5)]);

let h: Harness;
let uploads: UploadSessions;
beforeEach(async () => {
  h = await createHarness();
  uploads = createUploadSessions({
    prisma: h.prisma,
    dataDir: h.dataDir,
    blobStore: h.blobStore,
    now: () => h.now.value,
  });
});
afterEach(async () => {
  await h.close();
});

const meeting = () => crypto.randomUUID();
const uploadDir = (id: string) => path.join(h.dataDir, 'uploads', id);

async function begin(bytes: Buffer, opts: { scope?: string; partSize?: number } = {}) {
  return uploads.begin({
    deviceId: 'dev-a',
    scope: opts.scope ?? meeting(),
    kind: 'audio-mic',
    sha256: sha(bytes),
    size: bytes.length,
    partSize: opts.partSize ?? MIN_PART_SIZE,
    ifMatch: null,
    epoch: currentEpoch(),
  });
}

const part = (bytes: Buffer, n: number, partSize = MIN_PART_SIZE) =>
  bytes.subarray(n * partSize, Math.min(bytes.length, (n + 1) * partSize));

const write = (id: string, n: number, bytes: Buffer) =>
  uploads.writePart(id, n, Readable.from([bytes]));

describe('begin', () => {
  it('defaults to 16 MiB parts and a seven-day deadline', async () => {
    const bytes = sealedBytes(100);
    const res = await uploads.begin({
      deviceId: 'dev-a',
      scope: meeting(),
      kind: 'audio-mic',
      sha256: sha(bytes),
      size: bytes.length,
      ifMatch: null,
      epoch: currentEpoch(),
    });
    expect(res).toEqual({
      uploadId: expect.stringMatching(/^[A-Za-z0-9]{21}$/),
      partSize: DEFAULT_PART_SIZE,
      expiresAt: h.now.value + UPLOAD_TTL_MS,
    });
    expect(DEFAULT_PART_SIZE).toBe(16 * MiB);
    expect(UPLOAD_TTL_MS).toBe(7 * 24 * 60 * 60 * 1000);
  });

  it('refuses a part size outside 1 MiB to 64 MiB, a size over 2^31-1, or a bad hash', async () => {
    const bytes = sealedBytes(100);
    for (const partSize of [MIN_PART_SIZE - 1, MAX_PART_SIZE + 1, 1.5 * MiB + 0.5]) {
      await expect(begin(bytes, { partSize })).rejects.toBeInstanceOf(InvalidUploadError);
    }
    expect(MAX_PART_SIZE).toBe(64 * MiB);
    const base = {
      deviceId: 'dev-a',
      scope: meeting(),
      kind: 'audio-mic',
      sha256: sha(bytes),
      ifMatch: null,
      epoch: currentEpoch(),
    };
    await expect(uploads.begin({ ...base, size: 2 ** 31 })).rejects.toBeInstanceOf(
      InvalidUploadError
    );
    await expect(uploads.begin({ ...base, size: 0 })).rejects.toBeInstanceOf(InvalidUploadError);
    await expect(uploads.begin({ ...base, size: 100, sha256: 'ABC' })).rejects.toBeInstanceOf(
      InvalidUploadError
    );
    expect(await h.prisma.upload.count()).toBe(0);
  });

  it('refuses a request authenticated before a reset', async () => {
    const stale = currentEpoch();
    await withVaultReset(async () => undefined);
    const bytes = sealedBytes(100);
    await expect(
      uploads.begin({
        deviceId: 'dev-a',
        scope: meeting(),
        kind: 'audio-mic',
        sha256: sha(bytes),
        size: bytes.length,
        ifMatch: null,
        epoch: stale,
      })
    ).rejects.toBeInstanceOf(VaultResetError);
    expect(await h.prisma.upload.count()).toBe(0);
  });
});

describe('writePart and inspect', () => {
  it('refuses a part number out of range or of the wrong length, and inspect lists what arrived', async () => {
    const bytes = sealedBytes(2 * MiB + 10); // parts 0, 1 (1 MiB each) and 2 (10 bytes)
    const { uploadId } = await begin(bytes);

    expect(await write(uploadId, 3, Buffer.alloc(10))).toBe('invalid_part');
    expect(await write(uploadId, 0, Buffer.alloc(MiB - 1))).toBe('invalid_part');
    expect(await write(uploadId, 2, Buffer.alloc(11))).toBe('invalid_part');
    expect(await write(uploadId, 2, Buffer.alloc(9))).toBe('invalid_part');

    expect(await write(uploadId, 2, part(bytes, 2))).toBe('ok');
    expect(await write(uploadId, 0, part(bytes, 0))).toBe('ok');
    expect(await uploads.inspect(uploadId)).toEqual({
      parts: [0, 2],
      missing: [1],
      partSize: MiB,
      size: bytes.length,
      expiresAt: h.now.value + UPLOAD_TTL_MS,
    });
    // No temp files are left behind by the refused parts.
    expect(fs.readdirSync(uploadDir(uploadId)).sort()).toEqual(['0', '2']);
  });

  it('an unknown id is not_found', async () => {
    expect(await write('nope', 0, Buffer.alloc(1))).toBe('not_found');
    expect(await uploads.inspect('nope')).toBeNull();
  });
});

describe('complete', () => {
  it('assembles parts sent out of order into one blob and removes the parts', async () => {
    const bytes = sealedBytes(2 * MiB + 10);
    const scope = meeting();
    const { uploadId } = await begin(bytes, { scope });
    for (const n of [2, 0, 1]) expect(await write(uploadId, n, part(bytes, n))).toBe('ok');

    const res = await uploads.complete(uploadId);
    expect(res).toEqual({
      ok: true,
      created: true,
      revision: 1,
      seq: expect.any(Number),
      sha256: sha(bytes),
      size: bytes.length,
    });
    const blob = await getBlob(h, scope, 'audio-mic');
    expect(blob?.sha256).toBe(sha(bytes));
    expect(fs.readFileSync(path.join(h.blobsDir, sha(bytes).slice(0, 2), sha(bytes)))).toEqual(
      bytes
    );
    expect(fs.existsSync(uploadDir(uploadId))).toBe(false);
    expect((await h.prisma.upload.findUnique({ where: { id: uploadId } }))?.completedAt).toBe(
      h.now.value
    );
    // A completed session is gone for every purpose.
    expect(await uploads.get(uploadId)).toBeNull();
    expect(await uploads.complete(uploadId)).toEqual({ ok: false, reason: 'not_found' });
  });

  it('a missing part is incomplete and lists it', async () => {
    const bytes = sealedBytes(2 * MiB + 10);
    const { uploadId } = await begin(bytes);
    await write(uploadId, 1, part(bytes, 1));
    expect(await uploads.complete(uploadId)).toEqual({
      ok: false,
      reason: 'incomplete',
      missing: [0, 2],
    });
  });

  it('a wrong declared hash keeps the parts, drops the assembled temp, and stores nothing', async () => {
    const bytes = sealedBytes(MiB + 10);
    const scope = meeting();
    const { uploadId } = await uploads.begin({
      deviceId: 'dev-a',
      scope,
      kind: 'audio-mic',
      sha256: sha(Buffer.from('something else')),
      size: bytes.length,
      partSize: MiB,
      ifMatch: null,
      epoch: currentEpoch(),
    });
    await write(uploadId, 0, part(bytes, 0));
    await write(uploadId, 1, part(bytes, 1));
    expect(await uploads.complete(uploadId)).toEqual({ ok: false, reason: 'hash_mismatch' });
    expect(fs.readdirSync(uploadDir(uploadId)).sort()).toEqual(['0', '1']);
    expect(await getBlob(h, scope, 'audio-mic')).toBeNull();
    expect(await h.prisma.change.count()).toBe(0);
    expect((await uploads.inspect(uploadId))?.missing).toEqual([]);
  });

  it('plaintext is not_sealed', async () => {
    const bytes = Buffer.alloc(MiB + 10, 0x41);
    const { uploadId } = await begin(bytes);
    await write(uploadId, 0, part(bytes, 0));
    await write(uploadId, 1, part(bytes, 1));
    expect(await uploads.complete(uploadId)).toEqual({ ok: false, reason: 'not_sealed' });
    expect(fs.readdirSync(uploadDir(uploadId)).sort()).toEqual(['0', '1']);
    expect(await h.prisma.blob.count()).toBe(0);
  });

  it('uses the precondition recorded at begin', async () => {
    const first = sealedBytes(100);
    const scope = meeting();
    const a = await begin(first, { scope });
    await write(a.uploadId, 0, first);
    expect((await uploads.complete(a.uploadId)).ok).toBe(true);

    const second = sealedBytes(100);
    const b = await begin(second, { scope }); // ifMatch: null, but a blob now exists
    await write(b.uploadId, 0, second);
    expect(await uploads.complete(b.uploadId)).toEqual({
      ok: false,
      reason: 'conflict',
      currentRevision: 1,
    });
  });

  it('a session begun before a reset can neither take a part nor complete after it', async () => {
    const bytes = sealedBytes(MiB + 10);
    const scope = meeting();
    const { uploadId } = await begin(bytes, { scope });
    await write(uploadId, 0, part(bytes, 0));
    await withVaultReset(async () => undefined); // the epoch moves; the row survives here

    await expect(write(uploadId, 1, part(bytes, 1))).rejects.toBeInstanceOf(VaultResetError);
    await expect(uploads.complete(uploadId)).rejects.toBeInstanceOf(VaultResetError);
    expect(await getBlob(h, scope, 'audio-mic')).toBeNull();
  });

  it('sessions survive a restart: a fresh process (epoch counted from zero again) can still complete them', async () => {
    const bytes = sealedBytes(100);
    const scope = meeting();
    const { uploadId } = await begin(bytes, { scope });
    await write(uploadId, 0, bytes);
    // A row written by an earlier process carries that process's epoch.
    await h.prisma.upload.update({ where: { id: uploadId }, data: { epoch: currentEpoch() + 5 } });

    const restarted = createUploadSessions({
      prisma: h.prisma,
      dataDir: h.dataDir,
      blobStore: h.blobStore,
      now: () => h.now.value,
    });
    expect((await restarted.complete(uploadId)).ok).toBe(true);
  });
});

describe('abort and expire', () => {
  it('abort removes the session and its parts', async () => {
    const bytes = sealedBytes(100);
    const { uploadId } = await begin(bytes);
    await write(uploadId, 0, bytes);
    expect(await uploads.abort(uploadId)).toBe(true);
    expect(fs.existsSync(uploadDir(uploadId))).toBe(false);
    expect(await uploads.get(uploadId)).toBeNull();
    expect(await uploads.abort(uploadId)).toBe(false);
  });

  it('expire drops sessions past their deadline with their parts, and stray part directories', async () => {
    const bytes = sealedBytes(100);
    const old = await begin(bytes);
    await write(old.uploadId, 0, bytes);
    h.now.value += UPLOAD_TTL_MS - 1000;
    const fresh = await begin(bytes);
    await write(fresh.uploadId, 0, bytes);
    fs.mkdirSync(uploadDir('strayFromAResetLibrary'), { recursive: true });

    expect(await uploads.expire(h.now.value)).toBe(0);
    expect(fs.existsSync(uploadDir('strayFromAResetLibrary'))).toBe(false);
    expect(fs.existsSync(uploadDir(old.uploadId))).toBe(true);

    h.now.value += 1000;
    expect(await uploads.expire(h.now.value)).toBe(1);
    expect(await h.prisma.upload.findUnique({ where: { id: old.uploadId } })).toBeNull();
    expect(fs.existsSync(uploadDir(old.uploadId))).toBe(false);
    expect(fs.existsSync(uploadDir(fresh.uploadId))).toBe(true);
  });

  it('a session at its deadline is no longer usable, even before the sweep', async () => {
    const bytes = sealedBytes(100);
    const { uploadId } = await begin(bytes);
    h.now.value += UPLOAD_TTL_MS;
    expect(await uploads.get(uploadId)).toBeNull();
    expect(await write(uploadId, 0, bytes)).toBe('not_found');
    expect(await uploads.complete(uploadId)).toEqual({ ok: false, reason: 'not_found' });
  });
});
