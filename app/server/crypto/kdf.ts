import { hkdfSync, pbkdf2Sync } from 'crypto';

/**
 * Account key derivation (design spec §3). The same function serves the
 * password and the recovery code: `secret` is the UTF-8 bytes of the password,
 * or the raw 10 bytes of the recovery code. Mac, browser and server all derive
 * the identical bytes; test/vectors/scribe-crypto-v1.json is the contract.
 *
 *   k_pw    = PBKDF2-HMAC-SHA256(secret, salt, 650000 iterations, 32 bytes)
 *   k_sk    = HKDF-SHA256(ikm = secretKey, salt = salt, info = "scribe/v1/secret-key", 32)
 *   auk     = k_pw XOR k_sk
 *   kek     = HKDF-SHA256(ikm = auk, salt = EMPTY, info = "scribe/v1/kek", 32)
 *   authKey = HKDF-SHA256(ikm = auk, salt = EMPTY, info = "scribe/v1/auth", 32)
 *
 * The secret key is 128 random bits that never reach the server, so a stolen
 * database cannot be brute-forced on the password alone. kek unwraps the
 * Library Key (stays on the client); authKey is what the server verifies
 * (argon2) and is domain-separated from kek so one cannot yield the other.
 * Note: for kek and authKey the HKDF salt is zero-length (not 32 zero bytes;
 * for HMAC-SHA256 the two are equivalent, but other APIs differ).
 * No logging lives in crypto/.
 */

export const PBKDF2_ITERATIONS = 650_000;

const KEY_LENGTH = 32;
const EMPTY_SALT = Buffer.alloc(0);

function hkdf(ikm: Buffer, salt: Buffer, info: string): Buffer {
  return Buffer.from(hkdfSync('sha256', ikm, salt, info, KEY_LENGTH));
}

export function deriveAccountKeys(input: { secret: Buffer; secretKey: Buffer; salt: Buffer }): {
  auk: Buffer;
  kek: Buffer;
  authKey: Buffer;
} {
  const { secret, secretKey, salt } = input;
  const kPw = pbkdf2Sync(secret, salt, PBKDF2_ITERATIONS, KEY_LENGTH, 'sha256');
  const kSk = hkdf(secretKey, salt, 'scribe/v1/secret-key');
  const auk = Buffer.alloc(KEY_LENGTH);
  for (let i = 0; i < KEY_LENGTH; i++) auk[i] = kPw[i] ^ kSk[i];
  return {
    auk,
    kek: hkdf(auk, EMPTY_SALT, 'scribe/v1/kek'),
    authKey: hkdf(auk, EMPTY_SALT, 'scribe/v1/auth'),
  };
}
