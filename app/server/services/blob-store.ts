import { createHash, randomBytes } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { Readable, Transform } from 'stream';
import { pipeline } from 'stream/promises';

/**
 * Content-addressed storage for sealed blobs (spec §4, §6).
 *
 * A file is named by the SHA-256 of its bytes and lives at
 * `<root>/<first two hex>/<sha256>`; the two-character fan-out keeps any one
 * directory to a few thousand entries on a library of years. The bytes are
 * ciphertext the vault cannot read, so this module knows nothing of kinds,
 * meetings or revisions: the `blobs` table maps those to a hash, and two rows
 * with identical bytes share one file.
 *
 * Every write goes to a temp file in the destination directory and is then
 * renamed into place, so a crash leaves either the whole file or a stray temp
 * (never a short file under a real hash), and the rename never crosses a
 * filesystem. Writing the same bytes twice is harmless: same name, same
 * content. Nothing here logs.
 */
export type BlobStore = {
  /** Stores `bytes`; idempotent for identical bytes. */
  put(bytes: Buffer): Promise<{ sha256: string; size: number }>;
  /**
   * Stores a stream, hashing as it writes. If the bytes do not hash to
   * `expectedSha256` the temp file is removed and `HashMismatchError` thrown,
   * so nothing lands under either hash.
   */
  putStream(source: Readable, expectedSha256: string): Promise<{ sha256: string; size: number }>;
  createReadStream(sha256: string): fs.ReadStream;
  /** Removes the file; quiet when it is already gone. */
  remove(sha256: string): Promise<void>;
  exists(sha256: string): Promise<boolean>;
  /** Sum of the sizes of every stored file (temps excluded). */
  totalBytes(): Promise<number>;
  /**
   * Removes everything under the root (files, shards, temps) and leaves the
   * root itself, empty. Only the keys-lost reset (spec §9) calls this. The
   * root is emptied rather than removed because it may be a mount point.
   */
  clear(): Promise<void>;
};

/** The streamed bytes did not hash to what the caller declared. Carries both hashes, which are safe to log. */
export class HashMismatchError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string
  ) {
    super('blob-store: hash mismatch');
    this.name = 'HashMismatchError';
  }
}

const SHA256_RE = /^[0-9a-f]{64}$/;

export function createBlobStore({ root }: { root: string }): BlobStore {
  // The only way a caller-supplied string becomes a path: anything but a
  // lowercase hex digest is refused, so no hash can climb out of `root`.
  function fileFor(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new Error('blob-store: not a sha256');
    return path.join(root, sha256.slice(0, 2), sha256);
  }

  async function tempIn(dir: string): Promise<string> {
    await fs.promises.mkdir(dir, { recursive: true });
    return path.join(dir, `.tmp-${randomBytes(8).toString('hex')}`);
  }

  async function exists(sha256: string): Promise<boolean> {
    try {
      return (await fs.promises.stat(fileFor(sha256))).isFile();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw err;
    }
  }

  return {
    exists,

    async put(bytes) {
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      const dest = fileFor(sha256);
      if (!(await exists(sha256))) {
        const temp = await tempIn(path.dirname(dest));
        try {
          // `flush` fsyncs before close: the row that will point at this file
          // is committed next, and must not outlive the bytes across a power cut.
          await fs.promises.writeFile(temp, bytes, { flush: true });
          await fs.promises.rename(temp, dest);
        } catch (err) {
          await fs.promises.rm(temp, { force: true });
          throw err;
        }
      }
      return { sha256, size: bytes.length };
    },

    async putStream(source, expectedSha256) {
      const dest = fileFor(expectedSha256);
      const temp = await tempIn(path.dirname(dest));
      const hash = createHash('sha256');
      let size = 0;
      const tap = new Transform({
        transform(chunk: Buffer, _enc, done) {
          hash.update(chunk);
          size += chunk.length;
          done(null, chunk);
        },
      });
      try {
        await pipeline(source, tap, fs.createWriteStream(temp, { flush: true }));
        const actual = hash.digest('hex');
        if (actual !== expectedSha256) throw new HashMismatchError(expectedSha256, actual);
        await fs.promises.rename(temp, dest);
      } catch (err) {
        await fs.promises.rm(temp, { force: true });
        throw err;
      }
      return { sha256: expectedSha256, size };
    },

    createReadStream(sha256) {
      return fs.createReadStream(fileFor(sha256));
    },

    async remove(sha256) {
      await fs.promises.rm(fileFor(sha256), { force: true });
    },

    async clear() {
      await fs.promises.mkdir(root, { recursive: true });
      for (const name of await fs.promises.readdir(root)) {
        await fs.promises.rm(path.join(root, name), { recursive: true, force: true });
      }
    },

    async totalBytes() {
      let total = 0;
      const shards = await fs.promises.readdir(root, { withFileTypes: true }).catch(() => []);
      for (const shard of shards) {
        if (!shard.isDirectory()) continue;
        const dir = path.join(root, shard.name);
        for (const name of await fs.promises.readdir(dir)) {
          if (!SHA256_RE.test(name)) continue;
          total += (await fs.promises.stat(path.join(dir, name))).size;
        }
      }
      return total;
    },
  };
}
