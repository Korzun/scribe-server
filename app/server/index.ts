import * as fs from 'fs';
import * as path from 'path';

import { loadConfig } from './config';
import { createPrismaClient } from './db/client';
import { runMigrations } from './db/migrate';
import { logger } from './logger';
import { createServer } from './server';
import { createBlobStore } from './services/blob-store';
import { createGarbageCollector } from './services/gc';
import { getOrCreateJwtSecret } from './services/token';
import { startVault } from './startup';
import { APP_VERSION } from './utils/app-version';

const log = logger('Server');

process.on('unhandledRejection', (reason) => {
  log.error(
    `Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
  );
});

const config = loadConfig();

fs.mkdirSync(config.dataDir, { recursive: true });
fs.mkdirSync(config.blobsDir, { recursive: true });

(async () => {
  const dbPath = path.join(config.dataDir, 'db.sqlite');
  const prisma = createPrismaClient(`file:${dbPath}`);
  await runMigrations(prisma);

  // Persisted in the settings table so a signed-in browser survives a restart.
  const jwtSecret = await getOrCreateJwtSecret(prisma);

  const blobStore = createBlobStore({ root: config.blobsDir });
  const gc = createGarbageCollector({ prisma, blobStore, now: Date.now });
  const server = createServer({ config, prisma, jwtSecret, blobStore, gc });

  await startVault({ prisma, config, version: APP_VERSION, server, gc });
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
