import type { PrismaClient } from '@prisma/client';
import cookieParser from 'cookie-parser';
import express, { NextFunction, Request, Response } from 'express';

import { logger } from './logger';
import { requestLog } from './middleware/request-log';
import { requestTimeout } from './middleware/timeout';
import { createStatusRouter } from './routes/status';
import { AppConfig } from './types';
import { APP_VERSION } from './utils/app-version';

const log = logger('Server');

export type CreateServerDeps = {
  config: AppConfig;
  prisma: PrismaClient;
  /** Signing secret for access tokens. Nothing reads it until auth is wired in. */
  jwtSecret: Buffer;
  /** Clock in epoch milliseconds; tests inject a fake one, production uses `Date.now`. */
  now?: () => number;
};

export function createServer({ prisma }: CreateServerDeps): express.Express {
  const server = express();

  // Respond with a clean 503 before a ~100s proxy timeout turns into a 524.
  server.use(requestTimeout(90_000));
  server.use(requestLog());
  server.use(express.json());
  server.use(express.urlencoded({ extended: false }));
  server.use(cookieParser());

  server.use('/api/v1/status', createStatusRouter({ prisma, version: APP_VERSION }));

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
    log.error(
      `Unhandled route error: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}`
    );
    res.status(500).json({ error: 'Internal server error' });
  });

  return server;
}
