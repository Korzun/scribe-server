import { describe, expect, it } from 'vitest';

import { fromBase64, fromHex, toBase64, toHex, utf8 } from './bytes';

describe('bytes', () => {
  it('round-trips hex', () => {
    expect(toHex(fromHex('00ff10ab'))).toBe('00ff10ab');
    expect(Array.from(fromHex('00FF'))).toEqual([0, 255]);
  });

  it('round-trips standard base64, padding included', () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    expect(toHex(fromBase64(toBase64(all)))).toBe(toHex(all));
    expect(toBase64(fromHex('fbff'))).toBe('+/8=');
  });

  it('encodes UTF-8', () => {
    expect(toHex(utf8('é'))).toBe('c3a9');
  });

  it('rejects odd-length or non-hex input', () => {
    expect(() => fromHex('abc')).toThrow();
    expect(() => fromHex('zz')).toThrow();
  });
});
