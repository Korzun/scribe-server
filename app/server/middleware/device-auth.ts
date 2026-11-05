import type { PrismaClient } from '@prisma/client';
import type { NextFunction, Request, Response } from 'express';

import { authenticateDevice } from '../services/device';

export type DeviceAuthDeps = {
  prisma: PrismaClient;
  now: () => number;
};

/**
 * Guards a route behind a device token (spec §5): `Authorization: Bearer
 * <token>`. On success sets `req.device = { id }`; otherwise answers 401
 * `{ error: 'Unauthorized' }` without saying whether the token was unknown,
 * revoked or absent.
 */
export function deviceAuth({ prisma, now }: DeviceAuthDeps) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      const header = req.headers.authorization;
      const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length).trim() : '';
      const device = token === '' ? null : await authenticateDevice(prisma, token, now());
      if (device === null) {
        res.status(401).json({ error: 'Unauthorized' });
        return;
      }
      req.device = { id: device.deviceId };
      next();
    } catch (err) {
      next(err);
    }
  };
}
