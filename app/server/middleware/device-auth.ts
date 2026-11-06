import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { authenticateDevice } from '../services/device';
import { currentEpoch } from '../services/vault-gate';

export type DeviceAuthDeps = {
  prisma: PrismaClient;
  now: () => number;
};

/**
 * Guards a route behind a device token (spec §5): `Authorization: Bearer
 * <token>`. On success sets `req.device = { id }` and `req.vaultEpoch` (the
 * reset epoch, recorded before the token is checked, as `ownerAuth` does);
 * otherwise answers 401
 * `{ error: 'Unauthorized' }` without saying whether the token was unknown,
 * revoked or absent.
 */
export function deviceAuth({ prisma, now }: DeviceAuthDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const epoch = currentEpoch();
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      const device = token === '' ? null : await authenticateDevice(prisma, token, now());
      if (device === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      req.device = { id: device.deviceId };
      req.vaultEpoch = epoch;
      next();
    } catch (err) {
      next(err);
    }
  };
}
