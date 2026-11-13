import { describe, expect, it } from 'vitest';

import { fromHex, toHex } from './bytes';
import {
  formatRecoveryCode,
  formatSecretKey,
  generateRecoveryCode,
  generateSecretKey,
  parseRecoveryCode,
  parseSecretKey,
} from './codes';
import { loadVectors } from './test-vectors';

const bytes = fromHex('00112233445566778899aabbccddeeff');
const hexOf = (b: Uint8Array | null) => (b === null ? null : toHex(b));

describe('secret key', () => {
  it('formatSecretKey produces A1- and 26 base32 chars in 5-5-5-5-6 groups', () => {
    expect(formatSecretKey(bytes)).toMatch(
      /^A1-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/
    );
  });

  it('round-trips and generates 16 bytes', () => {
    expect(hexOf(parseSecretKey(formatSecretKey(bytes)))).toBe(toHex(bytes));
    const generated = generateSecretKey();
    expect(generated).toBeInstanceOf(Uint8Array);
    expect(generated.length).toBe(16);
  });

  it('parseSecretKey accepts lowercase and no dashes', () => {
    const text = formatSecretKey(bytes);
    expect(hexOf(parseSecretKey(text.toLowerCase()))).toBe(toHex(bytes));
    expect(hexOf(parseSecretKey(text.replace(/-/g, '')))).toBe(toHex(bytes));
    expect(hexOf(parseSecretKey(' ' + text.replace(/-/g, ' ') + ' '))).toBe(toHex(bytes));
  });

  it('parseSecretKey rejects a wrong version prefix and a wrong length', () => {
    const text = formatSecretKey(bytes);
    expect(parseSecretKey('A2' + text.slice(2))).toBeNull();
    expect(parseSecretKey(text.slice(0, -1))).toBeNull();
    expect(parseSecretKey(text + 'A')).toBeNull();
    expect(parseSecretKey('')).toBeNull();
  });

  it('parseSecretKey rejects characters outside the alphabet and non-zero padding bits', () => {
    const text = formatSecretKey(bytes);
    expect(parseSecretKey(text.slice(0, -1) + '1')).toBeNull();
    // The 26th char holds 3 data bits and 2 padding bits; 'B' (=1) sets a padding bit.
    expect(parseSecretKey(text.slice(0, -1) + 'B')).toBeNull();
  });
});

describe('recovery code', () => {
  it('recovery code is 16 base32 chars and round-trips', () => {
    const raw = fromHex('21222324252627282930');
    const text = formatRecoveryCode(raw);
    expect(text).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(hexOf(parseRecoveryCode(text))).toBe(toHex(raw));
    expect(hexOf(parseRecoveryCode(text.toLowerCase().replace(/-/g, ' ')))).toBe(toHex(raw));
    expect(parseRecoveryCode(text.slice(0, -1))).toBeNull();
    expect(parseRecoveryCode('1111-1111-1111-1111')).toBeNull();
    expect(generateRecoveryCode().length).toBe(10);
  });

  it('formats the committed vector inputs as the committed strings', () => {
    const v = loadVectors();
    expect(formatSecretKey(fromHex(v.inputs.secretKey))).toBe(v.formatted.secretKey);
    expect(formatRecoveryCode(fromHex(v.inputs.recoveryCode))).toBe(v.formatted.recoveryCode);
    expect(hexOf(parseSecretKey(v.formatted.secretKey))).toBe(v.inputs.secretKey);
    expect(hexOf(parseRecoveryCode(v.formatted.recoveryCode))).toBe(v.inputs.recoveryCode);
  });
});
