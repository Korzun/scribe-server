import { randomBytes } from 'crypto';

/**
 * Human-transcribable secrets (design spec §3): the Secret Key and recovery
 * codes. Both are RFC 4648 base32 (uppercase, no padding), chosen so they can
 * be read aloud or copied from paper without ambiguous 0/O/1/I characters.
 * No logging lives in crypto/.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const SECRET_KEY_VERSION = 'A1';
const SECRET_KEY_BYTES = 16;
const SECRET_KEY_CHARS = 26;
const RECOVERY_CODE_BYTES = 10;
const RECOVERY_CODE_CHARS = 16;

function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
    value &= (1 << bits) - 1;
  }
  // Left-over bits are zero-padded on the right (RFC 4648), no '=' emitted.
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes to exactly `byteLength` bytes, or null if any char is invalid or any padding bit is set. */
function base32Decode(text: string, byteLength: number): Buffer | null {
  const out = Buffer.alloc(byteLength);
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const ch of text) {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) return null;
    value = (value << 5) | v;
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 0xff;
      bits -= 8;
      value &= (1 << bits) - 1;
    }
  }
  // Whatever remains is padding and must be zero, else two texts would map to one key.
  if (index !== byteLength || value !== 0) return null;
  return out;
}

/** Uppercases and drops dashes and whitespace so users may type any grouping. */
function normalise(text: string): string {
  return text.toUpperCase().replace(/[-\s]/g, '');
}

function group(text: string, sizes: number[]): string {
  const parts: string[] = [];
  let offset = 0;
  for (const size of sizes) {
    parts.push(text.slice(offset, offset + size));
    offset += size;
  }
  return parts.join('-');
}

/** `A1-` then 26 base32 chars in groups 5-5-5-5-6. 16 bytes = 128 bits = 25.6 chars, so the last char has 2 zero padding bits. */
export function formatSecretKey(bytes16: Buffer): string {
  return `${SECRET_KEY_VERSION}-${group(base32Encode(bytes16), [5, 5, 5, 5, 6])}`;
}

/** Null unless the version is A1, there are exactly 26 alphabet chars, and the padding bits are zero. */
export function parseSecretKey(text: string): Buffer | null {
  const clean = normalise(text);
  if (!clean.startsWith(SECRET_KEY_VERSION)) return null;
  const body = clean.slice(SECRET_KEY_VERSION.length);
  if (body.length !== SECRET_KEY_CHARS) return null;
  return base32Decode(body, SECRET_KEY_BYTES);
}

export function generateSecretKey(): Buffer {
  return randomBytes(SECRET_KEY_BYTES);
}

/** 10 bytes = 80 bits = exactly 16 base32 chars, shown as XXXX-XXXX-XXXX-XXXX. */
export function formatRecoveryCode(bytes10: Buffer): string {
  return group(base32Encode(bytes10), [4, 4, 4, 4]);
}

export function parseRecoveryCode(text: string): Buffer | null {
  const clean = normalise(text);
  if (clean.length !== RECOVERY_CODE_CHARS) return null;
  return base32Decode(clean, RECOVERY_CODE_BYTES);
}

export function generateRecoveryCode(): Buffer {
  return randomBytes(RECOVERY_CODE_BYTES);
}
