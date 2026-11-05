import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { authenticateDevice } from '../services/device';

export type OwnerAuthDeps = {
  prisma: PrismaClient;
  now: () => number;
};

/**
 * Guards the owner-only routes (spec §5): `Authorization: Bearer <credential>`
 * where the credential proves the caller is the library's owner. For now that
 * is a device token; on success sets `req.owner = { via: 'device', deviceId }`.
 * Anything else answers 401 `{ error: 'Unauthorized' }` without saying whether
 * the credential was absent, unknown or revoked.
 */
export function ownerAuth({ prisma, now }: OwnerAuthDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      const bearer = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';

      // A device token is base64url, which never contains a dot; a JWT always
      // does. Task 6 verifies the JWT here and sets `req.owner = { via:
      // 'session' }`. Until then a dotted bearer is simply not a credential.
      if (bearer === '' || bearer.includes('.')) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }

      const device = await authenticateDevice(prisma, bearer, now());
      if (device === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      req.owner = { via: 'device', deviceId: device.deviceId };
      next();
    } catch (err) {
      next(err);
    }
  };
}
