import * as fs from 'fs';
import * as path from 'path';

import { beforeAll, describe, expect, it } from 'vitest';

import { deriveAccountKeys, deriveIntermediates, PBKDF2_ITERATIONS } from './kdf';

const secret = Buffer.from('correct horse battery staple');
const salt = Buffer.alloc(16, 3);

describe('deriveAccountKeys', () => {
  let a: ReturnType<typeof deriveAccountKeys>;
  let b: ReturnType<typeof deriveAccountKeys>;

  // Each derivation costs 650k PBKDF2 rounds, so derive once for the group.
  beforeAll(() => {
    a = deriveAccountKeys({ secret, secretKey: Buffer.alloc(16, 1), salt });
    b = deriveAccountKeys({ secret, secretKey: Buffer.alloc(16, 2), salt });
  });

  it('uses 650000 iterations', () => {
    expect(PBKDF2_ITERATIONS).toBe(650_000);
  });

  it('two different secret keys give different authKey for the same password and salt', () => {
    expect(a.authKey.equals(b.authKey)).toBe(false);
    expect(a.kek.equals(b.kek)).toBe(false);
  });

  it('authKey and kek differ', () => {
    expect(a.authKey.equals(a.kek)).toBe(false);
    expect(a.auk.length).toBe(32);
  });

  it('matches the committed vectors', () => {
    const v = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../test/vectors/scribe-crypto-v1.json'),
        'utf8'
      )
    );
    const hex = (s: string) => Buffer.from(s, 'hex');
    const check = (got: ReturnType<typeof deriveIntermediates>, want: Record<string, string>) => {
      for (const name of ['kPw', 'kSk', 'auk', 'kek', 'authKey'] as const) {
        expect(got[name].toString('hex'), name).toBe(want[name]);
      }
    };
    check(
      deriveIntermediates({
        secret: Buffer.from(v.inputs.password, 'utf8'),
        secretKey: hex(v.inputs.secretKey),
        salt: hex(v.inputs.passwordSalt),
      }),
      v.password
    );
    check(
      deriveIntermediates({
        secret: hex(v.inputs.recoveryCode),
        secretKey: hex(v.inputs.secretKey),
        salt: hex(v.inputs.recoverySalt),
      }),
      v.recovery
    );
    const viaPublic = deriveAccountKeys({
      secret: hex(v.inputs.recoveryCode),
      secretKey: hex(v.inputs.secretKey),
      salt: hex(v.inputs.recoverySalt),
    });
    expect(viaPublic.authKey.toString('hex')).toBe(v.recovery.authKey);
  });
});
