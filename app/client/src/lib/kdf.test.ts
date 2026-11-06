import { beforeAll, describe, expect, it } from 'vitest';

import { fromHex, toHex, utf8 } from './bytes';
import { deriveAccountKeys, deriveIntermediates, PBKDF2_ITERATIONS } from './kdf';
import { loadVectors } from './test-vectors';

const v = loadVectors();

type Intermediates = Awaited<ReturnType<typeof deriveIntermediates>>;
const NAMES = ['kPw', 'kSk', 'auk', 'kek', 'authKey'] as const;

// Each derivation costs 650k PBKDF2 rounds through WebCrypto, so derive once for
// the file and give the hook a generous budget.
let password: Intermediates;
let recovery: Intermediates;
let viaPublic: Awaited<ReturnType<typeof deriveAccountKeys>>;
beforeAll(async () => {
  [password, recovery, viaPublic] = await Promise.all([
    deriveIntermediates({
      secret: utf8(v.inputs.password),
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

  it('returns Uint8Arrays of 32 bytes', () => {
    for (const name of NAMES) {
      expect(password[name]).toBeInstanceOf(Uint8Array);
      expect(password[name].length).toBe(32);
    }
  });
});
