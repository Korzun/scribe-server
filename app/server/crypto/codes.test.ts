import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

import {
  formatRecoveryCode,
  formatSecretKey,
  generateRecoveryCode,
  generateSecretKey,
  parseRecoveryCode,
  parseSecretKey,
} from './codes';

const bytes = Buffer.from('00112233445566778899aabbccddeeff', 'hex');

describe('secret key', () => {
  it('formatSecretKey produces A1- and 26 base32 chars in 5-5-5-5-6 groups', () => {
    expect(formatSecretKey(bytes)).toMatch(
      /^A1-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{5}-[A-Z2-7]{6}$/
    );
  });

  it('round-trips and generates 16 bytes', () => {
    expect(parseSecretKey(formatSecretKey(bytes))?.equals(bytes)).toBe(true);
    expect(generateSecretKey().length).toBe(16);
  });

  it('parseSecretKey accepts lowercase and no dashes', () => {
    const text = formatSecretKey(bytes);
    expect(parseSecretKey(text.toLowerCase())?.equals(bytes)).toBe(true);
    expect(parseSecretKey(text.replace(/-/g, ''))?.equals(bytes)).toBe(true);
    expect(parseSecretKey(' ' + text.replace(/-/g, ' ') + ' ')?.equals(bytes)).toBe(true);
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
    const raw = Buffer.from('21222324252627282930', 'hex');
    const text = formatRecoveryCode(raw);
    expect(text).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);
    expect(parseRecoveryCode(text)?.equals(raw)).toBe(true);
    expect(parseRecoveryCode(text.toLowerCase().replace(/-/g, ' '))?.equals(raw)).toBe(true);
    expect(parseRecoveryCode(text.slice(0, -1))).toBeNull();
    expect(parseRecoveryCode('1111-1111-1111-1111')).toBeNull();
    expect(generateRecoveryCode().length).toBe(10);
  });

  it('formats the committed vector inputs as the committed strings', () => {
    const v = JSON.parse(
      fs.readFileSync(
        path.resolve(__dirname, '../../../test/vectors/scribe-crypto-v1.json'),
        'utf8'
      )
    );
    expect(formatSecretKey(Buffer.from(v.inputs.secretKey, 'hex'))).toBe(v.formatted.secretKey);
    expect(formatRecoveryCode(Buffer.from(v.inputs.recoveryCode, 'hex'))).toBe(
      v.formatted.recoveryCode
    );
  });
});
