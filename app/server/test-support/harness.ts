import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PrismaClient } from '@prisma/client';
import type express from 'express';

import { createPrismaClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createServer } from '../server';
import { createBlobStore, type BlobStore } from '../services/blob-store';
import type { AppConfig } from '../types';

export type Harness = {
  app: express.Express;
  prisma: PrismaClient;
  config: AppConfig;
  dataDir: string;
  blobsDir: string;
  /** The store the app writes through, on `blobsDir`. */
  blobStore: BlobStore;
  /** Mutable fake clock; every dep that reads time reads this. */
  now: { value: number };
  close(): Promise<void>;
};

/**
 * A fully wired app over real temp dirs and a real, migrated SQLite file —
 * the same stack production runs, minus the network listener. Call `close()`
 * in `afterEach`/`afterAll`.
 */
export async function createHarness(): Promise<Harness> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-harness-'));
  const dataDir = path.join(root, 'data');
  const blobsDir = path.join(root, 'blobs');
  fs.mkdirSync(dataDir);
  fs.mkdirSync(blobsDir);

  const config: AppConfig = {
    dataDir,
    blobsDir,
    port: 0,
    publicUrl: null,
    trustProxyHops: 0,
    logLevel: 'error',
  };

  const prisma = createPrismaClient(`file:${path.join(dataDir, 'db.sqlite')}`);
  await runMigrations(prisma);

  const now = { value: 1_700_000_000_000 };
  const blobStore = createBlobStore({ root: blobsDir });
  const app = createServer({
    config,
    prisma,
    jwtSecret: Buffer.alloc(32, 7),
    blobStore,
    now: () => now.value,
  });

  return {
    app,
    prisma,
    config,
    dataDir,
    blobsDir,
    blobStore,
    now,
    async close() {
      await prisma.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
