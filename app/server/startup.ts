import * as fs from 'fs';

import type { PrismaClient } from '@prisma/client';
import type express from 'express';

import { logger } from './logger';
import { AppConfig } from './types';

const log = logger('Server');

export type StartupDeps = {
  prisma: PrismaClient;
  config: AppConfig;
  version: string;
  server: Pick<express.Express, 'listen'>;
};

// The startup sequence, extracted from `index.ts`'s top-level IIFE so it is
// under unit test rather than only exercised by booting the real process.
// Migration runs in `index.ts` before this, because building the server needs
// a migrated database.
export async function startVault({ prisma, config, version, server }: StartupDeps): Promise<void> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.blobsDir, { recursive: true });

  const shutdown = async (): Promise<void> => {
    log.info('Server shutting down');
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown());
  process.on('SIGINT', () => void shutdown());

  // Express 5 reports a listen failure (EADDRINUSE, EACCES) to this callback
  // instead of throwing it; left unhandled, the process would log "starting"
  // and stay alive with nothing listening.
  server.listen(config.port, (err?: Error) => {
    if (err) {
      log.error(`Failed to listen on port ${config.port}: ${err.message}`);
      process.exit(1);
      return;
    }
    log.info(
      `Scribe vault v${version} starting — port: ${config.port}, blobsDir: ${config.blobsDir}, dataDir: ${config.dataDir}`
    );
  });
}
