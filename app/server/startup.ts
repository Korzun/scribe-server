import * as fs from 'fs';

import type { PrismaClient } from '@prisma/client';
import type express from 'express';

import { logger } from './logger';
import type { GarbageCollector } from './services/gc';
import { AppConfig } from './types';

const log = logger('Server');

export type StartupDeps = {
  prisma: PrismaClient;
  config: AppConfig;
  version: string;
  server: Pick<express.Express, 'listen'>;
  gc: Pick<GarbageCollector, 'sweep'>;
};

/** How often the collector runs (spec §6: the seven-day grace needs no finer clock). */
export const SWEEP_INTERVAL_MS = 60 * 60 * 1000;

// The startup sequence, extracted from `index.ts`'s top-level IIFE so it is
// under unit test rather than only exercised by booting the real process.
// Migration runs in `index.ts` before this, because building the server needs
// a migrated database.
//
// It also runs the garbage collector (services/gc.ts): once at boot, then
// hourly. The timer is unref'd so it never holds the process open, and a
// sweep that throws is logged and retried next hour, never fatal: a full disk
// or a locked database must not take the vault down with it. `stop()` (also
// run on shutdown) ends the timer.
export async function startVault({
  prisma,
  config,
  version,
  server,
  gc,
}: StartupDeps): Promise<{ stop(): void }> {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.blobsDir, { recursive: true });

  const runSweep = (): void => {
    gc.sweep().catch((err: unknown) => {
      log.error(`Sweep failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  };
  runSweep();
  const timer = setInterval(runSweep, SWEEP_INTERVAL_MS);
  timer.unref();
  const stop = (): void => clearInterval(timer);

  const shutdown = async (): Promise<void> => {
    log.info('Server shutting down');
    stop();
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

  return { stop };
}
