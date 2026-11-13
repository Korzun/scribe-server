import * as fs from 'fs';
import * as path from 'path';

import { loadConfig } from './config';
import { createPrismaClient } from './db/client';
import { runMigrations } from './db/migrate';
import { logger } from './logger';
import { createServer } from './server';
import { createBlobStore } from './services/blob-store';
import { createGarbageCollector } from './services/gc';
import { loadResetEpoch } from './services/library';
import { createJwtSecret } from './services/token';
import { createUploadSessions } from './services/upload-session';
import { initEpoch } from './services/vault-gate';
import { startVault } from './startup';
import { APP_VERSION } from './utils/app-version';
import { defaultPrivilegeOps, dropPrivileges, VAULT_UID } from './utils/drop-privileges';

const log = logger('Server');

process.on('unhandledRejection', (reason) => {
  log.error(
    `Unhandled promise rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)}`
  );
});

const config = loadConfig();

// Before anything is opened or written: as root, own the two data directories
// and become the unprivileged user, so every file the vault creates is that
// user's (utils/drop-privileges.ts). Not root: just make sure the directories exist.
const privilegeOps = defaultPrivilegeOps();
if (privilegeOps !== null && dropPrivileges([config.dataDir, config.blobsDir], privilegeOps)) {
  log.info(`Dropped privileges to uid ${VAULT_UID}`);
} else {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.blobsDir, { recursive: true });
}

(async () => {
  const dbPath = path.join(config.dataDir, 'db.sqlite');
  const prisma = createPrismaClient(`file:${dbPath}`);
  await runMigrations(prisma);

  // The keys-lost reset epoch survives restarts (services/vault-gate.ts);
  // set before anything can authenticate a request.
  initEpoch(await loadResetEpoch(prisma));

  // Persisted in the settings table so a signed-in browser survives a restart.
  const jwtSecret = await createJwtSecret(prisma);

  const blobStore = createBlobStore({ root: config.blobsDir });
  const uploads = createUploadSessions({
    prisma,
    dataDir: config.dataDir,
    blobStore,
    now: Date.now,
  });
  const gc = createGarbageCollector({ prisma, blobStore, now: Date.now, uploads });
  const server = createServer({ config, prisma, jwtSecret, blobStore, gc, uploads });

  await startVault({ prisma, config, version: APP_VERSION, server, gc });
})().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
