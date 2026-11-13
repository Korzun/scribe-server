import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { tokenWrapAad } from './seal';
import { deriveTokenKek, hashTokenSecret, newTokenSecret, tokenSecretFromWire } from './token-kek';

type Vector = {
  secret: string;
  wire: string;
  hash: string;
  k: string;
  libraryId: string;
  wrapAad: string;
};

const v = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, '../../../test/vectors/scribe-mcp-token-v1.json'), 'utf8')
) as Vector;

describe('token key derivation', () => {
  it('derives the pinned key from the pinned secret', () => {
    expect(deriveTokenKek(Buffer.from(v.secret, 'hex')).toString('hex')).toBe(v.k);
  });

  it('reads a wire-form secret back into its bytes and hash', () => {
    const secret = tokenSecretFromWire(v.wire);
    expect(secret.bytes.toString('hex')).toBe(v.secret);
    expect(secret.hash).toBe(v.hash);
    expect(hashTokenSecret(v.wire)).toBe(v.hash);
  });

  it('mints 32 random bytes, unpadded base64url, with a matching hash', () => {
    const a = newTokenSecret();
    const b = newTokenSecret();
    expect(a.bytes.length).toBe(32);
    expect(a.wire).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.wire).not.toBe(b.wire);
    expect(a.hash).toBe(hashTokenSecret(a.wire));
    expect(deriveTokenKek(a.bytes).equals(deriveTokenKek(b.bytes))).toBe(false);
  });

  it('binds a wrap to its library, kind and hash', () => {
    expect(tokenWrapAad(v.libraryId, 'code', v.hash)).toBe(v.wrapAad);
    expect(tokenWrapAad(v.libraryId, 'access', v.hash)).not.toBe(v.wrapAad);
  });
});
