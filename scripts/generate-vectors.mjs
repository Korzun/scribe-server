#!/usr/bin/env node
// Generates test/vectors/scribe-crypto-v1.json, the byte-exact contract for the
// Scribe crypto (design spec section 3) shared by the vault (Node), the Mac app
// (Swift CryptoKit) and the browser (WebCrypto).
//
// This is deliberately an INDEPENDENT second implementation: plain Node, no
// imports from app/. If it imported the server's code, the committed vectors
// would only prove the library agrees with itself. The server tests and
// generate-vectors.test.mjs check the two implementations against each other.
//
// Output is deterministic (all inputs fixed). Usage:
//   node scripts/generate-vectors.mjs          print to stdout
//   node scripts/generate-vectors.mjs --write  write test/vectors/scribe-crypto-v1.json

import { createCipheriv, hkdfSync, pbkdf2Sync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ITERATIONS = 650_000;
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

const range = (from, to) => Buffer.from(Array.from({ length: to - from + 1 }, (_, i) => from + i));
const hex = (buf) => Buffer.from(buf).toString('hex');
const hkdf = (ikm, salt, info) => Buffer.from(hkdfSync('sha256', ikm, salt, info, 32));

// RFC 4648 base32, uppercase, no padding characters.
function base32(bytes) {
  let bits = '';
  for (const b of bytes) bits += b.toString(2).padStart(8, '0');
  bits = bits.padEnd(Math.ceil(bits.length / 5) * 5, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += ALPHABET[parseInt(bits.slice(i, i + 5), 2)];
  return out;
}

function derive(secret, secretKey, salt) {
  const kPw = pbkdf2Sync(secret, salt, ITERATIONS, 32, 'sha256');
  const kSk = hkdf(secretKey, salt, 'scribe/v1/secret-key');
  const auk = Buffer.from(kPw.map((b, i) => b ^ kSk[i]));
  // HKDF salt is ZERO-LENGTH for kek and authKey.
  const kek = hkdf(auk, Buffer.alloc(0), 'scribe/v1/kek');
  const authKey = hkdf(auk, Buffer.alloc(0), 'scribe/v1/auth');
  return { kPw, kSk, auk, kek, authKey };
}

// SCRB | 0x01 | nonce(12) | AES-256-GCM ciphertext | tag(16); AAD is UTF-8.
function seal(key, plaintext, aad, nonce) {
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(aad, 'utf8'));
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from('SCRB', 'ascii'), Buffer.from([1]), nonce, ct, cipher.getAuthTag()]);
}

// A password's secret bytes: NFC-normalised, then UTF-8, nothing trimmed.
const passwordBytes = (password) => Buffer.from(password.normalize('NFC'), 'utf8');

const group = (text, sizes) => {
  let at = 0;
  return sizes.map((n) => text.slice(at, (at += n))).join('-');
};

export function generate() {
  const password = 'correct horse battery staple';
  // "café" spelled two ways: precomposed U+00E9 (NFC) and e + U+0301 (NFD).
  const unicodePasswordNfc = 'caf\u00e9';
  const unicodePasswordNfd = 'cafe\u0301';
  const secretKey = Buffer.from('00112233445566778899aabbccddeeff', 'hex');
  const passwordSalt = range(0x01, 0x10);
  const recoverySalt = range(0x11, 0x20);
  const recoveryCode = range(0x21, 0x2a);
  const libraryId = '3f2b1c4e-9d8a-4f6b-8c7d-5e4f3a2b1c0d';
  const meetingId = '7a1e5b3c-2d4f-4a6b-9c8d-0e1f2a3b4c5d';
  const voiceId = 'c4d5e6f7-a8b9-4c0d-8e1f-2a3b4c5d6e7f';
  const libraryKey = range(0x40, 0x5f);
  const nonce = range(0x60, 0x6b);
  const plaintext = range(0x00, 0x3f);

  const pw = derive(passwordBytes(password), secretKey, passwordSalt);
  const uni = derive(passwordBytes(unicodePasswordNfd), secretKey, passwordSalt);
  const uniNfc = derive(passwordBytes(unicodePasswordNfc), secretKey, passwordSalt);
  if (!uni.authKey.equals(uniNfc.authKey) || !uni.kek.equals(uniNfc.kek)) {
    throw new Error('NFC and NFD spellings must derive the same keys');
  }
  const rec = derive(recoveryCode, secretKey, recoverySalt);
  const passwordAad = `${libraryId}/keys/password`;
  const recoveryAad = `${libraryId}/keys/recovery`;
  const blobAad = `${libraryId}/${meetingId}/transcript/1`;
  const libraryBlobAad = `${libraryId}/library/voice/${voiceId}/1`;
  const keys = (d) => ({
    kPw: hex(d.kPw),
    kSk: hex(d.kSk),
    auk: hex(d.auk),
    kek: hex(d.kek),
    authKey: hex(d.authKey),
  });

  return {
    version: 1,
    iterations: ITERATIONS,
    notes: [
      'All binary values are lowercase hex unless noted. Strings are UTF-8.',
      'secret is the UTF-8 bytes of the password (password and unicode blocks) or the raw 10 recovery-code bytes (recovery block).',
      'Passwords are normalised to Unicode NFC, then UTF-8 encoded; nothing is trimmed. The unicode block derives from inputs.unicodePasswordNfd and equals the derivation from inputs.unicodePasswordNfc (secret = inputs.unicodePasswordUtf8).',
      'kPw = PBKDF2-HMAC-SHA256(secret, salt, 650000 iterations, 32 bytes).',
      'kSk = HKDF-SHA256(ikm = secretKey, salt = salt, info = "scribe/v1/secret-key", 32 bytes).',
      'auk = kPw XOR kSk.',
      'kek = HKDF-SHA256(ikm = auk, salt = zero-length, info = "scribe/v1/kek", 32 bytes).',
      'authKey = HKDF-SHA256(ikm = auk, salt = zero-length, info = "scribe/v1/auth", 32 bytes).',
      'The HKDF salt for kek and authKey is zero-length, which for HMAC-SHA256 is equivalent to 32 zero bytes per RFC 5869.',
      'Sealed blob = "SCRB" (ASCII) | 0x01 | 12-byte nonce | AES-256-GCM ciphertext | 16-byte tag. AAD is a UTF-8 string.',
      'wraps.password = seal(password.kek, libraryKey, passwordAad, nonce); wraps.recovery = seal(recovery.kek, libraryKey, recoveryAad, nonce).',
      'Key-wrap AAD = "<libraryId>/keys/<slot>" with slot "password" or "recovery".',
      'Blob AAD = "<libraryId>/<scope>/<kind>/<revision>"; scope is a meeting UUID or "library". blob.sealed = seal(libraryKey, plaintext, blob.aad, nonce).',
      'A library kind may contain a slash: libraryBlob.aad = "<libraryId>/library/voice/<voiceId>/1" and libraryBlob.sealed = seal(libraryKey, plaintext, libraryBlob.aad, nonce).',
      'UUIDs in AADs and in every API path are canonical lowercase 8-4-4-4-12 hex; the server rejects anything else.',
      'libraryId is used exactly as the server returns it.',
      'Secret Key text = "A1-" + RFC 4648 base32 (uppercase, no padding) of the 16 bytes, 26 chars in groups 5-5-5-5-6 joined by "-"; the 2 padding bits of the last char must be zero.',
      'Recovery code text = RFC 4648 base32 of the 10 bytes, 16 chars in groups 4-4-4-4 joined by "-".',
      'The base32 alphabet is RFC 4648 (A-Z2-7) with no input aliases.',
      'The fixed nonce is reused across vectors for determinism only; real use draws a fresh random nonce per seal.',
    ],
    inputs: {
      password,
      unicodePasswordNfc,
      unicodePasswordNfd,
      unicodePasswordUtf8: hex(passwordBytes(unicodePasswordNfd)),
      secretKey: hex(secretKey),
      passwordSalt: hex(passwordSalt),
      recoverySalt: hex(recoverySalt),
      recoveryCode: hex(recoveryCode),
      libraryId,
      meetingId,
      voiceId,
      libraryKey: hex(libraryKey),
      nonce: hex(nonce),
      plaintext: hex(plaintext),
    },
    formatted: {
      secretKey: `A1-${group(base32(secretKey), [5, 5, 5, 5, 6])}`,
      recoveryCode: group(base32(recoveryCode), [4, 4, 4, 4]),
    },
    password: keys(pw),
    unicode: keys(uni),
    recovery: keys(rec),
    wraps: {
      passwordAad,
      password: hex(seal(pw.kek, libraryKey, passwordAad, nonce)),
      recoveryAad,
      recovery: hex(seal(rec.kek, libraryKey, recoveryAad, nonce)),
    },
    blob: { aad: blobAad, sealed: hex(seal(libraryKey, plaintext, blobAad, nonce)) },
    libraryBlob: {
      aad: libraryBlobAad,
      sealed: hex(seal(libraryKey, plaintext, libraryBlobAad, nonce)),
    },
  };
}

/** The exact bytes committed to disk: two-space JSON and a trailing newline. */
export function render() {
  return JSON.stringify(generate(), null, 2) + '\n';
}

export const VECTORS_PATH = fileURLToPath(
  new URL('../test/vectors/scribe-crypto-v1.json', import.meta.url),
);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes('--write')) {
    writeFileSync(VECTORS_PATH, render());
    console.log(`wrote ${VECTORS_PATH}`);
  } else {
    process.stdout.write(render());
  }
}
