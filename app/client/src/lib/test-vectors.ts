import * as fs from 'fs';
import * as path from 'path';

/**
 * The committed cross-platform crypto contract, `test/vectors/scribe-crypto-v1.json`
 * at the repository root. Tests only: the client never reads it at runtime.
 */
export type CryptoVectors = {
  iterations: number;
  inputs: {
    password: string;
    unicodePasswordNfc: string;
    unicodePasswordNfd: string;
    unicodePasswordUtf8: string;
    secretKey: string;
    passwordSalt: string;
    recoverySalt: string;
    recoveryCode: string;
    libraryId: string;
    meetingId: string;
    voiceId: string;
    libraryKey: string;
    nonce: string;
    plaintext: string;
  };
  formatted: { secretKey: string; recoveryCode: string };
  password: Record<'kPw' | 'kSk' | 'auk' | 'kek' | 'authKey', string>;
  unicode: Record<'kPw' | 'kSk' | 'auk' | 'kek' | 'authKey', string>;
  recovery: Record<'kPw' | 'kSk' | 'auk' | 'kek' | 'authKey', string>;
  wraps: { passwordAad: string; password: string; recoveryAad: string; recovery: string };
  blob: { aad: string; sealed: string };
  libraryBlob: { aad: string; sealed: string };
};

export const loadVectors = (): CryptoVectors =>
  JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, '../../../../test/vectors/scribe-crypto-v1.json'),
      'utf8'
    )
  ) as CryptoVectors;
