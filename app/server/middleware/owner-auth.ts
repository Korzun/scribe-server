import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { authenticateDevice } from '../services/device';
import { verifyAccessToken } from '../services/jwt';
import type { JwtSecret } from '../services/token';
import { currentEpoch } from '../services/vault-gate';

export type OwnerAuthDeps = {
  prisma: PrismaClient;
  jwtSecret: JwtSecret;
  now: () => number;
};

/**
 * Guards the owner-only routes (spec §5): `Authorization: Bearer <credential>`
 * where the credential proves the caller is the library's owner: either a
 * device token (sets `req.owner = { via: 'device', deviceId }`) or the browser
 * session's access token (sets `req.owner = { via: 'session' }`). Anything else answers 401 `{ error: 'Unauthorized' }` without saying whether
 * the credential was absent, unknown or revoked.
 */
export function ownerAuth({ prisma, jwtSecret, now }: OwnerAuthDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      // Recorded before the credential is checked, so a keys-lost reset that
      // lands anywhere after this point refuses the request's writes.
      const epoch = currentEpoch();
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

      if (bearer === '') {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      // A device token is base64url, which never contains a dot; a JWT always
      // does, so the shape alone says which check to run. The JWT is judged
      // against the injected clock, like everything else that expires.
      if (bearer.includes('.')) {
        if (verifyAccessToken(jwtSecret.current(), bearer, now() / 1000) === null) {
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }
        req.owner = { via: 'session' };
        req.vaultEpoch = epoch;
        next();
        return;
      }

      const device = await authenticateDevice(prisma, bearer, now());
      if (device === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      req.owner = { via: 'device', deviceId: device.deviceId };
      req.vaultEpoch = epoch;
      next();
    } catch (err) {
      next(err);
    }
  };
}
