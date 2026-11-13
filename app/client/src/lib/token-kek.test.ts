import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from './bytes';
import { deriveTokenKek, hashTokenSecret, toBase64Url } from './kdf';
import { tokenWrapAad } from './seal';

type Vector = {
  secret: string;
  wire: string;
  hash: string;
  k: string;
  libraryId: string;
  wrapAad: string;
};

const v = JSON.parse(
  fs.readFileSync(
    path.resolve(__dirname, '../../../../test/vectors/scribe-mcp-token-v1.json'),
    'utf8'
  )
) as Vector;

describe('MCP token key derivation in the browser', () => {
  it('derives the pinned key from the pinned secret', async () => {
    expect(toHex(await deriveTokenKek(fromHex(v.secret)))).toBe(v.k);
  });

  it('spells the wire form and its hash as the vault does', async () => {
    expect(toBase64Url(fromHex(v.secret))).toBe(v.wire);
    expect(await hashTokenSecret(v.wire)).toBe(v.hash);
  });

  it('binds a wrap to its library, kind and hash', () => {
    expect(tokenWrapAad(v.libraryId, 'code', v.hash)).toBe(v.wrapAad);
  });
});
