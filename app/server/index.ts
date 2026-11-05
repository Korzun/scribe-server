import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { loadConfig } from './config';
import { createPrismaClient } from './db/client';
import { runMigrations } from './db/migrate';
import { logger } from './logger';
import { createServer } from './server';
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

  // Task 6 replaces this with `getOrCreateJwtSecret(prisma)`, which persists
  // the secret so tokens survive a restart. Nothing reads it yet.
  const jwtSecret = crypto.randomBytes(32);

  const server = createServer({ config, prisma, jwtSecret });

  await startVault({ prisma, config, version: APP_VERSION, server });
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
