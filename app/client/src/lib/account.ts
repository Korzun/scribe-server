import { api, type ApiResult } from './api';
import { fromBase64, toBase64, utf8 } from './bytes';
import {
  formatRecoveryCode,
  generateRecoveryCode,
  parseRecoveryCode,
  parseSecretKey,
} from './codes';
import { deriveAccountKeys } from './kdf';
import { keyWrapAad, open, seal, SealError } from './seal';

/**
 * The owner's account flows in the browser (spec §3, §9): change the password,
 * regenerate recovery codes, recover with a code, and the keys-lost reset.
 * Pure over `api` and the crypto libs, no React.
 *
 * The vault never sees a key in the clear. Each flow unwraps the Library Key
 * here, rewraps it under freshly derived material, and sends only derived
 * auth keys, salts and wraps. Nothing here logs; no secret ever reaches an
 * error string, a URL or a toast.
 */

type Failure = Extract<ApiResult<never>, { ok: false }>;
type Salts = { passwordSalt: string; recoverySalt: string };
type LibraryWrap = { id: string; passwordWrap: string };
type Unlocked = { libraryId: string; libraryKey: Uint8Array; authKey: Uint8Array };
type PasswordMaterial = { newPasswordSalt: string; newAuthKey: string; newPasswordWrap: string };

const SALT_LENGTH = 16;
const RECOVERY_CODE_COUNT = 10;

const INVALID_CREDENTIALS: Failure = { ok: false, status: 401, error: 'Invalid credentials' };
const INVALID_SECRET_KEY: Failure = { ok: false, status: 400, error: 'Invalid secret key' };
const INVALID_RECOVERY_CODE: Failure = { ok: false, status: 400, error: 'Invalid recovery code' };
const NO_CRYPTO: Failure = {
  ok: false,
  status: 0,
  error: 'This browser cannot derive your keys here — open the vault over HTTPS',
};

const newSalt = () => crypto.getRandomValues(new Uint8Array(SALT_LENGTH));

/**
 * Runs a flow, folding a crypto exception into a failure: a SealError means
 * the keys were wrong; anything else (no WebCrypto outside a secure context,
 * a malformed base64 field) means the browser cannot do this here.
 */
async function guarded<T>(flow: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> {
  try {
    return await flow();
  } catch (err) {
    return err instanceof SealError ? INVALID_CREDENTIALS : NO_CRYPTO;
  }
}

/** Derives the current keys and unwraps the Library Key; fails before any write. */
async function unlock(password: string, secretKey: Uint8Array): Promise<ApiResult<Unlocked>> {
  const salts = await api<Salts>('/api/v1/library/salts');
  if (!salts.ok) return salts;
  const { kek, authKey } = await deriveAccountKeys({
    secret: utf8(password),
    secretKey,
    salt: fromBase64(salts.body.passwordSalt),
  });
  const library = await api<LibraryWrap>('/api/v1/library');
  if (!library.ok) return library;
  const libraryId = library.body.id;
  const libraryKey = await open(
    kek,
    fromBase64(library.body.passwordWrap),
    keyWrapAad(libraryId, 'password')
  );
  return { ok: true, status: 200, body: { libraryId, libraryKey, authKey } };
}

/** A new salt, the keys derived from it, and the Library Key wrapped under the new kek. */
async function passwordMaterial(
  libraryId: string,
  libraryKey: Uint8Array,
  newPassword: string,
  secretKey: Uint8Array
): Promise<PasswordMaterial> {
  const salt = newSalt();
  const { kek, authKey } = await deriveAccountKeys({ secret: utf8(newPassword), secretKey, salt });
  const wrap = await seal(kek, libraryKey, keyWrapAad(libraryId, 'password'));
  return {
    newPasswordSalt: toBase64(salt),
    newAuthKey: toBase64(authKey),
    newPasswordWrap: toBase64(wrap),
  };
}

export async function changePassword({
  currentPassword,
  newPassword,
  secretKey: secretKeyText,
}: {
  currentPassword: string;
  newPassword: string;
  secretKey: string;
}): Promise<ApiResult<void>> {
  const secretKey = parseSecretKey(secretKeyText);
  if (secretKey === null) return INVALID_SECRET_KEY;
  return guarded(async () => {
    const unlocked = await unlock(currentPassword, secretKey);
    if (!unlocked.ok) return unlocked;
    const { libraryId, libraryKey, authKey } = unlocked.body;
    const material = await passwordMaterial(libraryId, libraryKey, newPassword, secretKey);
    return api<void>('/api/v1/library/password', {
      method: 'PUT',
      body: JSON.stringify({ authKey: toBase64(authKey), ...material }),
    });
  });
}

/** Returns the ten new codes, formatted, exactly once: nothing keeps them. */
export async function regenerateRecoveryCodes({
  password,
  secretKey: secretKeyText,
}: {
  password: string;
  secretKey: string;
}): Promise<ApiResult<string[]>> {
  const secretKey = parseSecretKey(secretKeyText);
  if (secretKey === null) return INVALID_SECRET_KEY;
  return guarded(async () => {
    const unlocked = await unlock(password, secretKey);
    if (!unlocked.ok) return unlocked;
    const { libraryId, libraryKey, authKey } = unlocked.body;
    const recoverySalt = newSalt();
    const codes = Array.from({ length: RECOVERY_CODE_COUNT }, generateRecoveryCode);
    const wrapped = await Promise.all(
      codes.map(async (code) => {
        const keys = await deriveAccountKeys({ secret: code, secretKey, salt: recoverySalt });
        const wrap = await seal(keys.kek, libraryKey, keyWrapAad(libraryId, 'recovery'));
        return { authKey: toBase64(keys.authKey), wrap: toBase64(wrap) };
      })
    );
    const result = await api<{ ids: string[] }>('/api/v1/library/recovery-codes', {
      method: 'PUT',
      body: JSON.stringify({
        authKey: toBase64(authKey),
        recoverySalt: toBase64(recoverySalt),
        codes: wrapped,
      }),
    });
    if (!result.ok) return result;
    return { ok: true, status: result.status, body: codes.map(formatRecoveryCode) };
  });
}

export async function recover({
  code: codeText,
  secretKey: secretKeyText,
  newPassword,
}: {
  code: string;
  secretKey: string;
  newPassword: string;
}): Promise<ApiResult<void>> {
  const code = parseRecoveryCode(codeText);
  if (code === null) return INVALID_RECOVERY_CODE;
  const secretKey = parseSecretKey(secretKeyText);
  if (secretKey === null) return INVALID_SECRET_KEY;
  return guarded(async () => {
    const salts = await api<Salts>('/api/v1/library/salts');
    if (!salts.ok) return salts;
    const { kek, authKey } = await deriveAccountKeys({
      secret: code,
      secretKey,
      salt: fromBase64(salts.body.recoverySalt),
    });
    const found = await api<{ recoveryId: string; wrap: string; libraryId: string }>(
      '/api/v1/recovery',
      { method: 'POST', body: JSON.stringify({ authKey: toBase64(authKey) }) }
    );
    if (!found.ok) return found;
    const { recoveryId, wrap, libraryId } = found.body;
    const libraryKey = await open(kek, fromBase64(wrap), keyWrapAad(libraryId, 'recovery'));
    const material = await passwordMaterial(libraryId, libraryKey, newPassword, secretKey);
    return api<void>(`/api/v1/recovery/${encodeURIComponent(recoveryId)}/password`, {
      method: 'POST',
      body: JSON.stringify({ authKey: toBase64(authKey), ...material }),
    });
  });
}

/** The keys-lost path: deletes the library outright, proven by the setup code from Home Assistant. */
export const resetLibrary = ({ setupCode }: { setupCode: string }): Promise<ApiResult<void>> =>
  api<void>('/api/v1/library', {
    method: 'DELETE',
    body: JSON.stringify({ setupCode, confirm: 'DELETE' }),
  });
