import { describe, expect, it } from 'vitest';

import { fromHex, toHex, utf8 } from './bytes';
import {
  blobAad,
  isSealed,
  keyWrapAad,
  open,
  seal,
  SEAL_HEADER_LENGTH,
  SealError,
  TAG_LENGTH,
} from './seal';
import { loadVectors } from './test-vectors';

const v = loadVectors();
const key = new Uint8Array(32).fill(7);
const aad = 'lib/library/settings/1';

async function reasonOf(promise: Promise<unknown>): Promise<string | undefined> {
  try {
    await promise;
  } catch (err) {
    return err instanceof SealError ? err.reason : 'other';
  }
  return undefined;
}

describe('seal', () => {
  it('round-trips with a random nonce', async () => {
    const plain = utf8('hello vault');
    const a = await seal(key, plain, aad);
    const b = await seal(key, plain, aad);
    expect(new TextDecoder().decode(a.subarray(0, 4))).toBe('SCRB');
    expect(a[4]).toBe(1);
    expect(a.length).toBe(SEAL_HEADER_LENGTH + plain.length + TAG_LENGTH);
    expect(toHex(a)).not.toBe(toHex(b));
    expect(toHex(await open(key, a, aad))).toBe(toHex(plain));
  });

  it('rejects a flipped ciphertext byte, and the right key under a different aad', async () => {
    const blob = await seal(key, utf8('payload'), aad);
    expect(await reasonOf(open(key, blob, aad + 'x'))).toBe('auth_failed');
    blob[SEAL_HEADER_LENGTH] ^= 0x01;
    expect(await reasonOf(open(key, blob, aad))).toBe('auth_failed');
  });

  it('rejects bad magic, a version other than 1, and a short blob', async () => {
    const blob = await seal(key, utf8('payload'), aad);
    const badMagic = Uint8Array.from(blob);
    badMagic[0] = 0x58;
    const badVersion = Uint8Array.from(blob);
    badVersion[4] = 2;
    expect(await reasonOf(open(key, badMagic, aad))).toBe('bad_magic');
    expect(await reasonOf(open(key, badVersion, aad))).toBe('bad_version');
    expect(await reasonOf(open(key, blob.subarray(0, 20), aad))).toBe('too_short');
  });

  it('isSealed is true for sealed output and false for JSON text', async () => {
    expect(isSealed(await seal(key, utf8('x'), aad))).toBe(true);
    expect(isSealed(utf8('{"a":1}'))).toBe(false);
    expect(isSealed(new Uint8Array(2))).toBe(false);
  });

  it('builds the aad strings the spec defines, matching the vectors', () => {
    expect(keyWrapAad('L', 'password')).toBe('L/keys/password');
    expect(blobAad('L', 'library', 'settings', 3)).toBe('L/library/settings/3');
    expect(keyWrapAad(v.inputs.libraryId, 'password')).toBe(v.wraps.passwordAad);
    expect(keyWrapAad(v.inputs.libraryId, 'recovery')).toBe(v.wraps.recoveryAad);
    expect(blobAad(v.inputs.libraryId, v.inputs.meetingId, 'transcript', 1)).toBe(v.blob.aad);
  });

  it('opens the vector blob and the vector password wrap', async () => {
    const libraryKey = fromHex(v.inputs.libraryKey);
    expect(toHex(await open(libraryKey, fromHex(v.blob.sealed), v.blob.aad))).toBe(
      v.inputs.plaintext
    );
    for (const slot of ['password', 'recovery'] as const) {
      const unwrapped = await open(
        fromHex(v[slot].kek),
        fromHex(v.wraps[slot]),
        v.wraps[`${slot}Aad`]
      );
      expect(toHex(unwrapped), slot).toBe(v.inputs.libraryKey);
    }
  });

  it('reproduces the vector blob and wraps with the fixed nonce', async () => {
    const libraryKey = fromHex(v.inputs.libraryKey);
    const nonce = fromHex(v.inputs.nonce);
    const sealed = await seal(libraryKey, fromHex(v.inputs.plaintext), v.blob.aad, nonce);
    expect(toHex(sealed)).toBe(v.blob.sealed);
    for (const slot of ['password', 'recovery'] as const) {
      const wrap = await seal(fromHex(v[slot].kek), libraryKey, v.wraps[`${slot}Aad`], nonce);
      expect(toHex(wrap), slot).toBe(v.wraps[slot]);
    }
  });
});
