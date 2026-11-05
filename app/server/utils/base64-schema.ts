import { z } from 'zod';

/** Canonical base64 only: decoding and re-encoding must round-trip, so junk is a 400 rather than silently truncated. */
export const base64Bytes = (min: number, max: number) =>
  z
    .string()
    .max(max * 2)
    .refine((s) => Buffer.from(s, 'base64').toString('base64') === s, 'not canonical base64')
    .transform((s) => Buffer.from(s, 'base64'))
    .refine((b) => b.length >= min && b.length <= max, 'wrong length');
