import type { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';

import { logger } from './logger';
import { requestLog } from './middleware/request-log';
import { requestTimeout } from './middleware/timeout';
import { createChangesRouter } from './routes/changes';
import { createDevicesRouter } from './routes/devices';
import { createLibraryRouter } from './routes/library';
import { createLibraryBlobsRouter } from './routes/library-blobs';
import { createMeetingsRouter } from './routes/meetings';
import { createRecoveryRouter } from './routes/recovery';
import { createSessionRouter } from './routes/session';
import { createStatusRouter } from './routes/status';
import type { BlobStore } from './services/blob-store';
import type { GarbageCollector } from './services/gc';
import type { JwtSecret } from './services/token';
import { VaultResetError } from './services/vault-gate';
import { AppConfig } from './types';
import { APP_VERSION } from './utils/app-version';

const log = logger('Server');

export type CreateServerDeps = {
  config: AppConfig;
  prisma: PrismaClient;
  /** Signing secret for the owner's access tokens (rotated by the keys-lost reset). */
  jwtSecret: JwtSecret;
  /** Content-addressed storage for sealed blobs, rooted at `config.blobsDir`. */
  blobStore: BlobStore;
  /** The collector `POST /library/purge` runs (the same one `startVault` runs hourly). */
  gc: GarbageCollector;
  /** Clock in epoch milliseconds; tests inject a fake one, production uses `Date.now`. */
  now?: () => number;
};

export function createServer({
  config,
  prisma,
  jwtSecret,
  blobStore,
  gc,
  now = Date.now,
}: CreateServerDeps): express.Express {
  const server = express();

  // Respond with a clean 503 before a ~100s proxy timeout turns into a 524.
  server.use(requestTimeout(90_000));
  server.use(requestLog());
  server.use(express.json());
  server.use(express.urlencoded({ extended: false }));
  server.use(cookieParser());

  server.use('/api/v1/status', createStatusRouter({ prisma, version: APP_VERSION }));

  server.use('/api/v1', createLibraryRouter({ prisma, jwtSecret, config, blobStore, gc, now }));
  server.use('/api/v1', createLibraryBlobsRouter({ prisma, jwtSecret, blobStore, now }));
  server.use('/api/v1', createDevicesRouter({ prisma, jwtSecret, config, now }));
  server.use('/api/v1', createSessionRouter({ prisma, jwtSecret, config, now }));
  server.use('/api/v1', createRecoveryRouter({ prisma, config, now }));
  server.use('/api/v1', createMeetingsRouter({ prisma, jwtSecret, blobStore, now }));
  server.use('/api/v1', createChangesRouter({ prisma, jwtSecret, now }));

  // Any other /api path is a JSON 404, so API clients never receive HTML.
  server.use('/api/{*splat}', (_req: Request, res: Response): void => {
    res.status(404).json({ error: 'Not found' });
  });

  server.use((err: unknown, _req: Request, res: Response, next: NextFunction): void => {
    if (err instanceof SyntaxError && 'body' in err) {
      log.warn(
        'Malformed request body — possible Cloudflare error page received as request (rejecting with 400)'
      );
      res.status(400).json({ error: 'Invalid request body' });
      return;
    }
    if (res.headersSent) {
      next(err);
      return;
    }
    // The request's credential belonged to a library a keys-lost reset deleted
    // while it was in flight (services/vault-gate.ts).
    if (err instanceof VaultResetError) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
    log.error(
      `Unhandled route error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    res.status(500).json({ error: 'Internal server error' });
  });

  return server;
}
