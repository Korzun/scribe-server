/**
 * The sealed-blob container (design spec §3), the browser twin of the server's
 * `crypto/seal.ts`, over WebCrypto. Every client-encrypted object the vault
 * stores, key wraps included, uses this one layout:
 *
 *   "SCRB" (4 ASCII bytes) | version 0x01 | nonce (12) | AES-256-GCM ciphertext | tag (16)
 *
 * WebCrypto's AES-GCM output is `ciphertext | tag` already, so the container
 * is just the header prepended. test/vectors/scribe-crypto-v1.json pins it.
 * No logging lives here: nothing may ever emit key or plaintext.
 */

const MAGIC = new Uint8Array([0x53, 0x43, 0x52, 0x42]); // "SCRB"
const VERSION = 0x01;
const NONCE_LENGTH = 12;
const encoder = new TextEncoder();

/** AES-GCM authentication tag length: the last 16 bytes of every sealed blob. */
export const TAG_LENGTH = 16;

/** Bytes before the ciphertext: magic (4) + version (1) + nonce (12). */
export const SEAL_HEADER_LENGTH = MAGIC.length + 1 + NONCE_LENGTH;

export type SealFailure = 'bad_magic' | 'bad_version' | 'auth_failed' | 'too_short';

/** Why a blob could not be opened; `reason` is safe to show, nothing else is carried. */
export class SealError extends Error {
  constructor(readonly reason: SealFailure) {
    super(`seal: ${reason}`);
    this.name = 'SealError';
  }
}

/** WebCrypto's BufferSource typing wants an ArrayBuffer-backed view. */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

const importAesKey = (key: Uint8Array, usage: 'encrypt' | 'decrypt') =>
  crypto.subtle.importKey('raw', buf(key), 'AES-GCM', false, [usage]);

const hasMagic = (bytes: Uint8Array) => MAGIC.every((b, i) => bytes[i] === b);

/**
 * Encrypts `plaintext` under a 32-byte `key`, binding the UTF-8 `aad` string.
 * The AAD ties a ciphertext to its place (library, scope, kind, revision), so
 * the server cannot swap one blob for another without the client noticing.
 * `nonce` is only for the deterministic test vectors; production callers omit
 * it and get a fresh random 12-byte nonce.
 */
export async function seal(
  key: Uint8Array,
  plaintext: Uint8Array,
  aad: string,
  nonce?: Uint8Array
): Promise<Uint8Array> {
  const iv = nonce ? buf(nonce) : crypto.getRandomValues(new Uint8Array(NONCE_LENGTH));
  const sealed = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: TAG_LENGTH * 8 },
    await importAesKey(key, 'encrypt'),
    buf(plaintext)
  );
  const out = new Uint8Array(SEAL_HEADER_LENGTH + sealed.byteLength);
  out.set(MAGIC, 0);
  out[MAGIC.length] = VERSION;
  out.set(iv, MAGIC.length + 1);
  out.set(new Uint8Array(sealed), SEAL_HEADER_LENGTH);
  return out;
}

/**
 * Decrypts a sealed blob. Rejects with SealError: `too_short` when it cannot
 * hold a header and tag, `bad_magic` / `bad_version` for foreign or future
 * formats, `auth_failed` for a wrong key, wrong AAD or any tampered byte.
 */
export async function open(key: Uint8Array, blob: Uint8Array, aad: string): Promise<Uint8Array> {
  if (blob.length < SEAL_HEADER_LENGTH + TAG_LENGTH) throw new SealError('too_short');
  if (!hasMagic(blob)) throw new SealError('bad_magic');
  if (blob[MAGIC.length] !== VERSION) throw new SealError('bad_version');
  const iv = buf(blob.subarray(MAGIC.length + 1, SEAL_HEADER_LENGTH));
  try {
    const plain = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: encoder.encode(aad), tagLength: TAG_LENGTH * 8 },
      await importAesKey(key, 'decrypt'),
      buf(blob.subarray(SEAL_HEADER_LENGTH))
    );
    return new Uint8Array(plain);
  } catch {
    throw new SealError('auth_failed');
  }
}

/**
 * True when the bytes start with "SCRB" and version 1. Looks at the first five
 * bytes only; it says nothing about whether the blob authenticates.
 */
export function isSealed(bytes: Uint8Array): boolean {
  return bytes.length >= MAGIC.length + 1 && hasMagic(bytes) && bytes[MAGIC.length] === VERSION;
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
