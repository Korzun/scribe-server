import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

/**
 * The sealed-blob container (design spec §3). Every client-encrypted object
 * the vault stores, key wraps included, uses this one layout:
 *
 *   "SCRB" (4 ASCII bytes) | version 0x01 | nonce (12) | AES-256-GCM ciphertext | tag (16)
 *
 * The Swift (CryptoKit) and browser (WebCrypto) implementations must produce
 * and accept exactly these bytes; test/vectors/scribe-crypto-v1.json pins it.
 * No logging lives in crypto/: nothing here may ever emit key or plaintext.
 */

const MAGIC = Buffer.from('SCRB', 'ascii');
const VERSION = 0x01;
const NONCE_LENGTH = 12;
/** AES-GCM authentication tag length: the last 16 bytes of every sealed blob. */
export const TAG_LENGTH = 16;

/** Bytes before the ciphertext: magic (4) + version (1) + nonce (12). */
export const SEAL_HEADER_LENGTH = MAGIC.length + 1 + NONCE_LENGTH;

export type SealFailure = 'bad_magic' | 'bad_version' | 'auth_failed' | 'too_short';

/** Why a blob could not be opened; `reason` is safe to log, nothing else is carried. */
export class SealError extends Error {
  constructor(readonly reason: SealFailure) {
    super(`seal: ${reason}`);
    this.name = 'SealError';
  }
}

/**
 * Encrypts `plaintext` under a 32-byte `key`, binding the UTF-8 `aad` string.
 * The AAD ties a ciphertext to its place (library, scope, kind, revision), so
 * the server cannot swap one blob for another without the client noticing.
 * `nonce` is only for the deterministic test vectors; production callers omit
 * it and get a fresh random 12-byte nonce.
 */
export function seal(key: Buffer, plaintext: Buffer, aad: string, nonce?: Buffer): Buffer {
  const iv = nonce ?? randomBytes(NONCE_LENGTH);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([MAGIC, Buffer.from([VERSION]), iv, ciphertext, cipher.getAuthTag()]);
}

/**
 * Decrypts a sealed blob. Throws SealError: `too_short` when it cannot hold a
 * header and tag, `bad_magic` / `bad_version` for foreign or future formats,
 * `auth_failed` for a wrong key, wrong AAD or any tampered byte.
 */
export function open(key: Buffer, blob: Buffer, aad: string): Buffer {
  if (blob.length < SEAL_HEADER_LENGTH + TAG_LENGTH) throw new SealError('too_short');
  if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new SealError('bad_magic');
  if (blob[MAGIC.length] !== VERSION) throw new SealError('bad_version');
  const nonce = blob.subarray(MAGIC.length + 1, SEAL_HEADER_LENGTH);
  const tag = blob.subarray(blob.length - TAG_LENGTH);
  const ciphertext = blob.subarray(SEAL_HEADER_LENGTH, blob.length - TAG_LENGTH);
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, nonce);
    decipher.setAAD(Buffer.from(aad, 'utf8'));
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  } catch {
    throw new SealError('auth_failed');
  }
}

/**
 * True when the bytes start with "SCRB" and version 1. Looks at the first five
 * bytes only; it says nothing about whether the blob authenticates. The vault
 * uses it to reject plaintext uploads without holding any key.
 */
export function isSealed(bytes: Buffer): boolean {
  return (
    bytes.length >= MAGIC.length + 1 &&
    bytes.subarray(0, MAGIC.length).equals(MAGIC) &&
    bytes[MAGIC.length] === VERSION
  );
}

/** AAD for a wrapped Library Key: `<libraryId>/keys/<slot>` (spec §3). */
export function keyWrapAad(libraryId: string, slot: 'password' | 'recovery'): string {
  return `${libraryId}/keys/${slot}`;
}

/**
 * AAD for a stored blob: `<libraryId>/<scope>/<kind>/<revision>` (spec §3),
 * where `scope` is a meeting UUID or the literal `library`.
 */
export function blobAad(libraryId: string, scope: string, kind: string, revision: number): string {
  return `${libraryId}/${scope}/${kind}/${revision}`;
}
