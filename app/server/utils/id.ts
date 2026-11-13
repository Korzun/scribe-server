import { customAlphabet } from 'nanoid';

/** Generates a 21-character alphanumeric ID, used as the surrogate primary key for recovery codes and devices. */
export const generateId = customAlphabet(
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789',
  21
);
