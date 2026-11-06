import type { PrismaClient } from '@prisma/client';
import { Router, type Response } from 'express';
import { z } from 'zod';

import { logger } from '../logger';
import { createIpRateLimit } from '../middleware/rate-limit';
import { signAccessToken } from '../services/jwt';
import { getLibrary, verifyOwner } from '../services/library';
import {
  consumeRefreshToken,
  createRefreshToken,
  deleteExpired,
  REFRESH_TOKEN_TTL_MS,
  revokeRefreshToken,
  type JwtSecret,
} from '../services/token';
import type { AppConfig } from '../types';
import { base64Bytes } from '../utils/base64-schema';

const log = logger('SessionRoute');

export type SessionRouterDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  config: AppConfig;
  now: () => number;
};

const loginBody = z.object({ authKey: base64Bytes(32, 32) });

const REFRESH_COOKIE = 'refresh_token';
// The cookie is only ever sent to the three session routes, never to the
// library or device routes, which authenticate with a bearer instead.
const REFRESH_COOKIE_PATH = '/api/v1/session';

/**
 * The owner's browser session (spec §5): a short-lived JWT access token the
 * admin page keeps in memory, plus a rotating refresh token in a cookie.
 *
 * The refresh token is httpOnly so a script on the page can never read it
 * (an XSS can still make requests, but cannot steal the long-lived credential),
 * SameSite=strict so another site cannot make the browser send it, and scoped
 * to this router's path so it travels nowhere else. It is single-use: every
 * refresh consumes it and issues a new one, so a copy stolen and replayed
 * later finds it already spent.
 *
 * Sign-in is the same proof the Macs give when enrolling: the auth key derived
 * from password + Secret Key. It is unauthenticated by nature and every
 * attempt costs an argon2 verify, so it is rate limited per IP.
 *
 * Nothing here logs a request body, token, key or cookie: outcomes only.
 */
export function createSessionRouter({ prisma, jwtSecret, config, now }: SessionRouterDeps): Router {
  const router = Router();
  const loginLimit = createIpRateLimit({
    max: 10,
    windowMs: 60_000,
    trustProxyHops: config.trustProxyHops,
    now,
  });
  // Only mark the cookie Secure when the vault is actually served over https;
  // a Secure cookie is never sent back over plain http, which would break a
  // LAN-only install.
  const secure = config.publicUrl?.startsWith('https') === true;

  async function issueTokens(res: Response): Promise<void> {
    const accessToken = signAccessToken(jwtSecret.current(), { owner: true }, now() / 1000);
    const refreshToken = await createRefreshToken(prisma, now());
    res.cookie(REFRESH_COOKIE, refreshToken, {
      httpOnly: true,
      sameSite: 'strict',
      secure,
      path: REFRESH_COOKIE_PATH,
      maxAge: REFRESH_TOKEN_TTL_MS,
    });
    res.json({ accessToken });
  }

  function clearRefreshCookie(res: Response): void {
    res.clearCookie(REFRESH_COOKIE, { path: REFRESH_COOKIE_PATH });
  }

  router.post('/session', loginLimit, async (req, res, next) => {
    try {
      const parsed = loginBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      if ((await getLibrary(prisma)) === null) {
        res.status(404).json({ error: 'No library' });
        return;
      }
      if (!(await verifyOwner(prisma, parsed.data.authKey))) {
        log.warn('Sign-in refused: invalid credentials');
        res.status(401).json({ error: 'Invalid credentials' });
        return;
      }
      log.info('Owner signed in');
      await deleteExpired(prisma, now());
      await issueTokens(res);
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/refresh', async (req, res, next) => {
    try {
      const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
      const reject = (): void => {
        clearRefreshCookie(res);
        res.status(401).json({ error: 'Unauthorized' });
      };
      if (typeof raw !== 'string' || raw === '') {
        reject();
        return;
      }
      if (!(await consumeRefreshToken(prisma, raw, now()))) {
        log.warn('Refresh rejected: unknown, reused or expired refresh token');
        reject();
        return;
      }
      await issueTokens(res);
    } catch (err) {
      next(err);
    }
  });

  router.post('/session/logout', async (req, res, next) => {
    try {
      const raw = (req.cookies as Record<string, string> | undefined)?.[REFRESH_COOKIE];
      if (typeof raw === 'string' && raw !== '') {
        await revokeRefreshToken(prisma, raw);
      }
      log.info('Owner signed out');
      clearRefreshCookie(res);
      res.status(204).end();
    } catch (err) {
      next(err);
    }
  });

  return router;
}
