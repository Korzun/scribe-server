import { api, type ApiResult } from './api';
import { toBase64 } from './bytes';
import {
  formatRecoveryCode,
  formatSecretKey,
  generateRecoveryCode,
  generateSecretKey,
} from './codes';
import { deriveAccountKeys, passwordBytes } from './kdf';
import { keyWrapAad, seal } from './seal';

/**
 * First-run setup in the browser (Docker-first design §7): the page generates
 * the Library Key, the Secret Key and ten recovery codes here, derives and
 * wraps per the original design's §3, shows the owner the kit, and only then
 * creates the library. Pure over `api` and the crypto libs, no React.
 *
 * The vault never sees a key in the clear: the request carries salts, derived
 * auth keys and wraps, nothing else. The browser is not a device, so the
 * request names none and the response is only the library id.
 */

export type CreateLibraryRequest = {
  libraryId: string;
  passwordSalt: string;
  recoverySalt: string;
  authKey: string;
  passwordWrap: string;
  recoveryCodes: Array<{ authKey: string; wrap: string }>;
};

export type Kit = {
  libraryId: string;
  /** Formatted `A1-XXXXX-…`, as the owner will type it. */
  secretKey: string;
  /** Ten formatted `XXXX-XXXX-XXXX-XXXX` codes. */
  recoveryCodes: string[];
  /** The password-derived auth key, base64: what signs the owner in right after creation. */
  authKey: string;
  request: CreateLibraryRequest;
};

export const KIT_FILE_NAME = 'scribe-kit.txt';
const SALT_LENGTH = 16;
const LIBRARY_KEY_LENGTH = 32;
const RECOVERY_CODE_COUNT = 10;

const random = (length: number) => crypto.getRandomValues(new Uint8Array(length));

/** Generates every secret and derives the request. Throws outside a secure context (no WebCrypto). */
export async function prepareLibrary(password: string): Promise<Kit> {
  const libraryId = crypto.randomUUID();
  const libraryKey = random(LIBRARY_KEY_LENGTH);
  const secretKey = generateSecretKey();
  const passwordSalt = random(SALT_LENGTH);
  const recoverySalt = random(SALT_LENGTH);

  const { kek, authKey } = await deriveAccountKeys({
    secret: passwordBytes(password),
    secretKey,
    salt: passwordSalt,
  });
  const passwordWrap = await seal(kek, libraryKey, keyWrapAad(libraryId, 'password'));

  const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
  const recoveryCodes = await Promise.all(
    codes.map(async (code) => {
      const keys = await deriveAccountKeys({ secret: code, secretKey, salt: recoverySalt });
      const wrap = await seal(keys.kek, libraryKey, keyWrapAad(libraryId, 'recovery'));
      return { authKey: toBase64(keys.authKey), wrap: toBase64(wrap) };
    })
  );

  return {
    libraryId,
    secretKey: formatSecretKey(secretKey),
    recoveryCodes: codes.map(formatRecoveryCode),
    authKey: toBase64(authKey),
    request: {
      libraryId,
      passwordSalt: toBase64(passwordSalt),
      recoverySalt: toBase64(recoverySalt),
      authKey: toBase64(authKey),
      passwordWrap: toBase64(passwordWrap),
      recoveryCodes,
    },
  };
}

/** Creates the library from a prepared kit. A 403 (setup code) or 409 (library exists) passes through. */
export const createLibrary = (
  kit: Kit,
  setupCode: string
): Promise<ApiResult<{ libraryId: string }>> =>
  api<{ libraryId: string }>('/api/v1/library', {
    method: 'POST',
    body: JSON.stringify({ setupCode, ...kit.request }),
  });

const EXPLANATION =
  'The Secret Key and your password together unlock the library. A recovery code ' +
  'replaces a forgotten password, once, and needs the Secret Key too. Your password is ' +
  'not on this page. Without the Secret Key nothing can recover this library.';

/** The plain-text kit the owner downloads and keeps. */
export const kitFileText = (kit: Kit, vaultUrl: string): string =>
  [
    'Scribe vault kit',
    '',
    `Vault: ${vaultUrl}`,
    `Secret Key: ${kit.secretKey}`,
    '',
    'Recovery codes (each works once):',
    ...kit.recoveryCodes,
    '',
    EXPLANATION,
    '',
  ].join('\n');
