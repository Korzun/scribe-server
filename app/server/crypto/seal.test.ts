import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { blobAad, isSealed, keyWrapAad, open, seal, SEAL_HEADER_LENGTH, SealError } from './seal';

const key = Buffer.alloc(32, 7);
const aad = 'lib/library/settings/1';

function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
  } catch (err) {
    return err instanceof SealError ? err.reason : 'other';
  }
  return undefined;
}

describe('seal', () => {
  it('round-trips with a random nonce', () => {
    const plain = Buffer.from('hello vault');
    const a = seal(key, plain, aad);
    const b = seal(key, plain, aad);
    expect(a.subarray(0, 4).toString('ascii')).toBe('SCRB');
    expect(a[4]).toBe(1);
    expect(a.length).toBe(SEAL_HEADER_LENGTH + plain.length + 16);
    expect(a.equals(b)).toBe(false);
    expect(open(key, a, aad).equals(plain)).toBe(true);
  });

  it('rejects a flipped ciphertext byte with auth_failed', () => {
    const blob = seal(key, Buffer.from('payload'), aad);
    blob[SEAL_HEADER_LENGTH] ^= 0x01;
    expect(reasonOf(() => open(key, blob, aad))).toBe('auth_failed');
  });

  it('rejects the right key under a different aad', () => {
    const blob = seal(key, Buffer.from('payload'), aad);
    expect(reasonOf(() => open(key, blob, aad + 'x'))).toBe('auth_failed');
  });

  it('rejects bad magic and a version other than 1', () => {
    const blob = seal(key, Buffer.from('payload'), aad);
    const badMagic = Buffer.from(blob);
    badMagic[0] = 0x58;
    const badVersion = Buffer.from(blob);
    badVersion[4] = 2;
    expect(reasonOf(() => open(key, badMagic, aad))).toBe('bad_magic');
    expect(reasonOf(() => open(key, badVersion, aad))).toBe('bad_version');
    expect(reasonOf(() => open(key, blob.subarray(0, 20), aad))).toBe('too_short');
  });

  it('isSealed is true for sealed output and false for JSON text', () => {
    expect(isSealed(seal(key, Buffer.from('x'), aad))).toBe(true);
    expect(isSealed(Buffer.from('{"a":1}'))).toBe(false);
    expect(isSealed(Buffer.alloc(2))).toBe(false);
  });

  it('builds the aad strings the spec defines', () => {
    expect(keyWrapAad('L', 'password')).toBe('L/keys/password');
    expect(keyWrapAad('L', 'recovery')).toBe('L/keys/recovery');
    expect(blobAad('L', 'library', 'settings', 3)).toBe('L/library/settings/3');
  });

  it('seals the vector plaintext to the vector ciphertext with the fixed nonce', () => {
    const v = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../test/vectors/scribe-crypto-v1.json'),
        'utf8'
      )
    );
    const libraryKey = Buffer.from(v.inputs.libraryKey, 'hex');
    const sealed = seal(
      libraryKey,
      Buffer.from(v.inputs.plaintext, 'hex'),
      v.blob.aad,
      Buffer.from(v.inputs.nonce, 'hex')
    );
    expect(sealed.toString('hex')).toBe(v.blob.sealed);
    expect(open(libraryKey, sealed, v.blob.aad).toString('hex')).toBe(v.inputs.plaintext);

    // A library-scope blob whose kind contains a slash.
    const libraryAad = blobAad(v.inputs.libraryId, 'library', `voice/${v.inputs.voiceId}`, 1);
    expect(libraryAad).toBe(v.libraryBlob.aad);
    const library = seal(
      libraryKey,
      Buffer.from(v.inputs.plaintext, 'hex'),
      libraryAad,
      Buffer.from(v.inputs.nonce, 'hex')
    );
    expect(library.toString('hex')).toBe(v.libraryBlob.sealed);
    expect(open(libraryKey, library, libraryAad).toString('hex')).toBe(v.inputs.plaintext);
  });

  it('reproduces the vector aad strings and key wraps', () => {
    const v = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../test/vectors/scribe-crypto-v1.json'),
        'utf8'
      )
    );
    const hex = (s: string) => Buffer.from(s, 'hex');
    expect(keyWrapAad(v.inputs.libraryId, 'password')).toBe(v.wraps.passwordAad);
    expect(keyWrapAad(v.inputs.libraryId, 'recovery')).toBe(v.wraps.recoveryAad);
    expect(blobAad(v.inputs.libraryId, v.inputs.meetingId, 'transcript', 1)).toBe(v.blob.aad);
    const libraryKey = hex(v.inputs.libraryKey);
    const nonce = hex(v.inputs.nonce);
    for (const slot of ['password', 'recovery'] as const) {
      const kek = hex(v[slot].kek);
      const aadStr = v.wraps[`${slot}Aad`];
      const wrap = seal(kek, libraryKey, aadStr, nonce);
      expect(wrap.toString('hex')).toBe(v.wraps[slot]);
      expect(open(kek, hex(v.wraps[slot]), aadStr).equals(libraryKey)).toBe(true);
    }
  });
});
