import { beforeAll, describe, expect, it } from 'vitest';

import { fromHex, toHex, utf8 } from './bytes';
import { deriveAccountKeys, deriveIntermediates, PBKDF2_ITERATIONS, passwordBytes } from './kdf';
import { loadVectors } from './test-vectors';

const v = loadVectors();

type Intermediates = Awaited<ReturnType<typeof deriveIntermediates>>;
const NAMES = ['kPw', 'kSk', 'auk', 'kek', 'authKey'] as const;

// Each derivation costs 650k PBKDF2 rounds through WebCrypto, so derive once for
// the file and give the hook a generous budget.
let password: Intermediates;
let unicodeNfd: Intermediates;
let unicodeNfc: Intermediates;
let recovery: Intermediates;
let viaPublic: Awaited<ReturnType<typeof deriveAccountKeys>>;
beforeAll(async () => {
  [password, unicodeNfd, unicodeNfc, recovery, viaPublic] = await Promise.all([
    deriveIntermediates({
      secret: passwordBytes(v.inputs.password),
      secretKey: fromHex(v.inputs.secretKey),
      salt: fromHex(v.inputs.passwordSalt),
    }),
    deriveIntermediates({
      secret: passwordBytes(v.inputs.unicodePasswordNfd),
      secretKey: fromHex(v.inputs.secretKey),
      salt: fromHex(v.inputs.passwordSalt),
    }),
    deriveIntermediates({
      secret: passwordBytes(v.inputs.unicodePasswordNfc),
      secretKey: fromHex(v.inputs.secretKey),
      salt: fromHex(v.inputs.passwordSalt),
    }),
    deriveIntermediates({
      secret: fromHex(v.inputs.recoveryCode),
      secretKey: fromHex(v.inputs.secretKey),
      salt: fromHex(v.inputs.recoverySalt),
    }),
    deriveAccountKeys({
      secret: fromHex(v.inputs.recoveryCode),
      secretKey: fromHex(v.inputs.secretKey),
      salt: fromHex(v.inputs.recoverySalt),
    }),
  ]);
}, 60_000);

describe('deriveAccountKeys', () => {
  it('uses the vectors iteration count', () => {
    expect(PBKDF2_ITERATIONS).toBe(650_000);
    expect(v.iterations).toBe(PBKDF2_ITERATIONS);
  });

  it('matches the committed vectors', () => {
    for (const name of NAMES) {
      expect(toHex(password[name]), `password.${name}`).toBe(v.password[name]);
      expect(toHex(recovery[name]), `recovery.${name}`).toBe(v.recovery[name]);
    }
    expect(Object.keys(viaPublic).sort()).toEqual(['auk', 'authKey', 'kek']);
    expect(toHex(viaPublic.auk)).toBe(v.recovery.auk);
    expect(toHex(viaPublic.kek)).toBe(v.recovery.kek);
    expect(toHex(viaPublic.authKey)).toBe(v.recovery.authKey);
  });

  it('NFC-normalises a password: both spellings of the unicode vector derive its keys', () => {
    expect(v.inputs.unicodePasswordNfc).not.toBe(v.inputs.unicodePasswordNfd);
    expect(toHex(passwordBytes(v.inputs.unicodePasswordNfd))).toBe(v.inputs.unicodePasswordUtf8);
    expect(toHex(passwordBytes(v.inputs.unicodePasswordNfc))).toBe(v.inputs.unicodePasswordUtf8);
    // Raw UTF-8 of the NFD spelling is different bytes: the normalisation matters.
    expect(toHex(utf8(v.inputs.unicodePasswordNfd))).not.toBe(v.inputs.unicodePasswordUtf8);
    for (const name of NAMES) {
      expect(toHex(unicodeNfd[name]), `unicode.${name} (NFD)`).toBe(v.unicode[name]);
      expect(toHex(unicodeNfc[name]), `unicode.${name} (NFC)`).toBe(v.unicode[name]);
    }
  });

  it('passwordBytes does not trim', () => {
    expect(toHex(passwordBytes(' a '))).toBe('206120');
  });

  it('returns Uint8Arrays of 32 bytes', () => {
    for (const name of NAMES) {
      expect(password[name]).toBeInstanceOf(Uint8Array);
      expect(password[name].length).toBe(32);
    }
  });
});
