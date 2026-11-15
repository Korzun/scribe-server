import { createHash, hkdfSync, randomBytes } from 'crypto';

/**
 * The key chain through MCP tokens (design spec §10). An authorization code,
 * an access token and a refresh token are each 32 random bytes that only the
 * client holds. From each the vault derives a key that wraps the Library Key
 * for that one secret, so the Library Key sits on the vault's disk only under
 * keys the vault does not have: the client presents the secret, the vault
 * derives the key, opens the wrap, answers and forgets it.
 *
 *   wire = base64url(secret)                  what travels, what the client stores
 *   hash = sha256(utf8(wire)) as hex          what the vault stores and looks rows up by
 *   k    = HKDF-SHA256(secret, salt = EMPTY, info = "scribe/v1/token-kek", 32 bytes)
 *
 * The browser (`app/client/src/lib/kdf.ts`) derives `k` for the code it
 * mints; test/vectors/scribe-mcp-token-v1.json pins both. No logging lives in
 * crypto/: nothing here may ever emit a secret or a key.
 */

const SECRET_LENGTH = 32;
const KEY_LENGTH = 32;
const EMPTY_SALT = Buffer.alloc(0);
export const TOKEN_KEK_INFO = 'scribe/v1/token-kek';

export type TokenSecret = {
  /** The 32 raw bytes, for deriving the wrapping key. */
  bytes: Buffer;
  /** base64url, unpadded: the form handed to the client. */
  wire: string;
  /** SHA-256 of `wire`, lowercase hex: the only form the vault keeps. */
  hash: string;
};

/** SHA-256 of a secret's wire form, as the token tables store it. */
export function hashTokenSecret(wire: string): string {
  return createHash('sha256').update(wire, 'utf8').digest('hex');
}

/** Mints a fresh token secret in its three forms. */
export function newTokenSecret(): TokenSecret {
  return tokenSecretFromWire(randomBytes(SECRET_LENGTH).toString('base64url'));
}

/**
 * The three forms of a secret a client presented. Any string decodes as
 * base64url, so a malformed token still yields a hash that matches no row;
 * the length check is what the wrap derivation needs, not a security gate.
 */
export function tokenSecretFromWire(wire: string): TokenSecret {
  return { bytes: Buffer.from(wire, 'base64url'), wire, hash: hashTokenSecret(wire) };
}

/** The key that wraps the Library Key for one secret. */
export function deriveTokenKek(secret: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', secret, EMPTY_SALT, TOKEN_KEK_INFO, KEY_LENGTH));
}
