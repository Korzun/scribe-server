import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Readable } from 'stream';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createBlobStore, HashMismatchError, syncDir, type BlobStore } from './blob-store';

vi.mock('../logger');

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Every file under `dir`, as paths relative to it. */
function walk(dir: string): string[] {
  return fs
    .readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(dir, path.join(e.parentPath, e.name)));
}

async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

let root: string;
let store: BlobStore;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-blobs-'));
  store = createBlobStore({ root });
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('createBlobStore', () => {
  it('put is idempotent for identical bytes', async () => {
    const bytes = crypto.randomBytes(1000);
    const first = await store.put(bytes);
    const second = await store.put(bytes);

    expect(first).toEqual({ sha256: sha(bytes), size: 1000 });
    expect(second).toEqual(first);
    expect(walk(root)).toEqual([path.join(first.sha256.slice(0, 2), first.sha256)]);
    expect(await store.exists(first.sha256)).toBe(true);
    expect(await store.totalBytes()).toBe(1000);
    expect((await readAll(store.createReadStream(first.sha256))).equals(bytes)).toBe(true);
  });

  it('putStream with a wrong expected hash leaves no file', async () => {
    const bytes = crypto.randomBytes(200_000);
    const wrong = sha(Buffer.from('something else'));

    await expect(store.putStream(Readable.from([bytes]), wrong)).rejects.toBeInstanceOf(
      HashMismatchError
    );
    expect(walk(root)).toEqual([]);
    expect(await store.exists(wrong)).toBe(false);
  });

  it('putStream with the right hash stores the bytes', async () => {
    const bytes = crypto.randomBytes(200_000);
    const half = bytes.length / 2;
    const res = await store.putStream(
      Readable.from([bytes.subarray(0, half), bytes.subarray(half)]),
      sha(bytes)
    );

    expect(res).toEqual({ sha256: sha(bytes), size: bytes.length });
    expect((await readAll(store.createReadStream(res.sha256))).equals(bytes)).toBe(true);
  });

  it('remove deletes the file and is quiet when it is already gone', async () => {
    const { sha256 } = await store.put(Buffer.from('bytes'));
    await store.remove(sha256);
    await store.remove(sha256);

    expect(await store.exists(sha256)).toBe(false);
    expect(await store.totalBytes()).toBe(0);
  });

  it('refuses anything that is not a lowercase hex digest', async () => {
    await expect(store.exists('../../etc/passwd')).rejects.toThrow();
    expect(() => store.createReadStream('A'.repeat(64))).toThrow();
  });
});

describe('directory fsync', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  /** Records renames, directory opens and fsyncs, in order. */
  function spyOnDurability(): string[] {
    const events: string[] = [];
    const realRename = fs.promises.rename;
    vi.spyOn(fs.promises, 'rename').mockImplementation(async (from, to) => {
      await realRename(from, to);
      events.push(`rename ${path.relative(root, String(to))}`);
    });
    const realOpen = fs.promises.open;
    vi.spyOn(fs.promises, 'open').mockImplementation(async (file, flags, mode) => {
      const handle = await realOpen(file, flags, mode);
      const name = path.relative(root, String(file));
      events.push(`open ${name}`);
      const realSync = handle.sync.bind(handle);
      handle.sync = async () => {
        await realSync();
        events.push(`fsync ${name}`);
      };
      return handle;
    });
    return events;
  }

  it('put fsyncs the <aa>/ directory after the rename', async () => {
    const events = spyOnDurability();
    const { sha256 } = await store.put(Buffer.from('durable'));
    const shard = sha256.slice(0, 2);
    expect(events).toEqual([`rename ${shard}/${sha256}`, `open ${shard}`, `fsync ${shard}`]);
  });

  it('putStream fsyncs the <aa>/ directory after the rename', async () => {
    const bytes = Buffer.from('durable stream');
    const events = spyOnDurability();
    await store.putStream(Readable.from([bytes]), sha(bytes));
    const shard = sha(bytes).slice(0, 2);
    expect(events.filter((e) => !e.startsWith('open .tmp'))).toEqual([
      `rename ${shard}/${sha(bytes)}`,
      `open ${shard}`,
      `fsync ${shard}`,
    ]);
  });

  it('syncDir ignores EINVAL and EISDIR from a platform that cannot fsync a directory, and nothing else', async () => {
    for (const code of ['EINVAL', 'EISDIR']) {
      vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(Object.assign(new Error(code), { code }));
      await expect(syncDir(root)).resolves.toBeUndefined();
    }
    vi.spyOn(fs.promises, 'open').mockRejectedValueOnce(
      Object.assign(new Error('EIO'), { code: 'EIO' })
    );
    await expect(syncDir(root)).rejects.toThrow('EIO');
  });
});
