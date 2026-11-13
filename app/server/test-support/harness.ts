import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import type { PrismaClient } from '@prisma/client';
import type express from 'express';

import { createPrismaClient } from '../db/client';
import { runMigrations } from '../db/migrate';
import { createServer } from '../server';
import { createBlobStore, type BlobStore } from '../services/blob-store';
import { createGarbageCollector, type GarbageCollector } from '../services/gc';
import { loadResetEpoch } from '../services/library';
import { createJwtSecret, type JwtSecret } from '../services/token';
import { createUploadSessions, type UploadSessions } from '../services/upload-session';
import { initEpoch } from '../services/vault-gate';
import type { AppConfig } from '../types';

/** The secret the harness's signing secret starts as. */
export const HARNESS_JWT_SECRET = Buffer.alloc(32, 7);

export type Harness = {
  app: express.Express;
  prisma: PrismaClient;
  config: AppConfig;
  dataDir: string;
  blobsDir: string;
  /** The store the app writes through, on `blobsDir`. */
  blobStore: BlobStore;
  /** The app's signing secret, seeded with `HARNESS_JWT_SECRET`. */
  jwtSecret: JwtSecret;
  /** The collector the app's purge route runs, on the fake clock. */
  gc: GarbageCollector;
  /** The app's upload sessions (parts under `dataDir/uploads`), also expired by `gc`. */
  uploads: UploadSessions;
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

  // A fixed starting secret, so a test can mint a token without the holder.
  await prisma.setting.create({
    data: { key: 'jwt_secret', value: HARNESS_JWT_SECRET.toString('hex') },
  });
  const jwtSecret = await createJwtSecret(prisma);
  // As index.ts does at boot: the gate starts from the persisted epoch.
  initEpoch(await loadResetEpoch(prisma));

  const now = { value: 1_700_000_000_000 };
  const blobStore = createBlobStore({ root: blobsDir });
  const uploads = createUploadSessions({ prisma, dataDir, blobStore, now: () => now.value });
  const gc = createGarbageCollector({ prisma, blobStore, now: () => now.value, uploads });
  const app = createServer({
    config,
    prisma,
    jwtSecret,
    blobStore,
    gc,
    uploads,
    now: () => now.value,
  });

  return {
    app,
    prisma,
    config,
    dataDir,
    blobsDir,
    blobStore,
    jwtSecret,
    gc,
    uploads,
    now,
    async close() {
      await prisma.$disconnect();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
