/**
 * Account key derivation (design spec §3), the browser twin of the server's
 * `crypto/kdf.ts`, over WebCrypto. The same function serves the password and
 * the recovery code: `secret` is `passwordBytes(password)` (the UTF-8 bytes of
 * the NFC-normalised password), or the raw 10 bytes of the recovery code. Mac, browser and server all derive the
 * identical bytes; test/vectors/scribe-crypto-v1.json is the contract.
 *
 *   k_pw    = PBKDF2-HMAC-SHA256(secret, salt, 650000 iterations, 32 bytes)
 *   k_sk    = HKDF-SHA256(ikm = secretKey, salt = salt, info = "scribe/v1/secret-key", 32)
 *   auk     = k_pw XOR k_sk
 *   kek     = HKDF-SHA256(ikm = auk, salt = EMPTY, info = "scribe/v1/kek", 32)
 *   authKey = HKDF-SHA256(ikm = auk, salt = EMPTY, info = "scribe/v1/auth", 32)
 *
 * kek unwraps the Library Key and never leaves the browser; authKey is the
 * only thing sent to the server. For kek and authKey the HKDF salt is
 * zero-length (WebCrypto accepts an empty `salt`, which HMAC-SHA256 treats
 * exactly as RFC 5869's default of 32 zero bytes).
 *
 * WebCrypto (`crypto.subtle`) exists only in a secure context (HTTPS or
 * localhost). No logging lives here: nothing may ever emit a key or secret.
 */

export const PBKDF2_ITERATIONS = 650_000;

const KEY_LENGTH = 32;
const KEY_BITS = KEY_LENGTH * 8;
const EMPTY_SALT = new Uint8Array(0);
const encoder = new TextEncoder();

/**
 * The `secret` bytes of a password: the string normalised to Unicode NFC, then
 * UTF-8 encoded, with nothing trimmed. Without the normalisation, "café" typed
 * as a precomposed é on one keyboard and as e + combining acute on another
 * would derive different keys. Every place the browser encodes a password goes
 * through this. Recovery codes are bytes and never pass through here.
 */
export const passwordBytes = (password: string): Uint8Array =>
  encoder.encode(password.normalize('NFC'));

export type DeriveInput = { secret: Uint8Array; secretKey: Uint8Array; salt: Uint8Array };

/** WebCrypto's BufferSource typing wants an ArrayBuffer-backed view. */
const buf = (bytes: Uint8Array): Uint8Array<ArrayBuffer> => Uint8Array.from(bytes);

async function pbkdf2(secret: Uint8Array, salt: Uint8Array): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', buf(secret), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: buf(salt), iterations: PBKDF2_ITERATIONS },
    base,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

async function hkdf(ikm: Uint8Array, salt: Uint8Array, info: string): Promise<Uint8Array> {
  const base = await crypto.subtle.importKey('raw', buf(ikm), 'HKDF', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: buf(salt), info: encoder.encode(info) },
    base,
    KEY_BITS
  );
  return new Uint8Array(bits);
}

/**
 * Same derivation as deriveAccountKeys but also returns the intermediates kPw
 * and kSk, so the shared test vectors can pin every step. Do not use outside tests.
 */
export async function deriveIntermediates({ secret, secretKey, salt }: DeriveInput): Promise<{
  kPw: Uint8Array;
  kSk: Uint8Array;
  auk: Uint8Array;
  kek: Uint8Array;
  authKey: Uint8Array;
}> {
  const [kPw, kSk] = await Promise.all([
    pbkdf2(secret, salt),
    hkdf(secretKey, salt, 'scribe/v1/secret-key'),
  ]);
  const auk = new Uint8Array(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) auk[i] = kPw[i] ^ kSk[i];
  const [kek, authKey] = await Promise.all([
    hkdf(auk, EMPTY_SALT, 'scribe/v1/kek'),
    hkdf(auk, EMPTY_SALT, 'scribe/v1/auth'),
  ]);
  return { kPw, kSk, auk, kek, authKey };
}

export async function deriveAccountKeys(input: DeriveInput): Promise<{
  auk: Uint8Array;
  kek: Uint8Array;
  authKey: Uint8Array;
}> {
  const { auk, kek, authKey } = await deriveIntermediates(input);
  return { auk, kek, authKey };
}
