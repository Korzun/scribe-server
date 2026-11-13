import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { changePassword, recover, regenerateRecoveryCodes, resetLibrary } from './account';
import { fromBase64, fromHex, toBase64, toHex, utf8 } from './bytes';
import { formatSecretKey, parseRecoveryCode } from './codes';
import { deriveAccountKeys } from './kdf';
import { keyWrapAad, open, seal } from './seal';
import { loadVectors } from './test-vectors';

const v = loadVectors();
const LIBRARY_ID = v.inputs.libraryId;
const LIBRARY_KEY = fromHex(v.inputs.libraryKey);
const SECRET_KEY = fromHex(v.inputs.secretKey);
// Each flow runs real 650k-round PBKDF2 derivations.
const SLOW = 60_000;

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
const noContent = () => new Response(null, { status: 204 });

type Call = { url: string; method: string; body: unknown };
let calls: Call[];
let passwordWrap: string;

const writes = () => calls.filter((c) => c.method !== 'GET');
const lastBody = (url: string, method: string) =>
  calls.filter((c) => c.url === url && c.method === method).at(-1)?.body as Record<string, unknown>;

/** A stand-in vault holding the vector library, wrapped under the vector password kek. */
const vault = async (url: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
  calls.push({ url, method, body });
  const route = `${method} ${url}`;
  switch (route) {
    case 'GET /api/v1/library/salts':
      return json(200, {
        passwordSalt: toBase64(fromHex(v.inputs.passwordSalt)),
        recoverySalt: toBase64(fromHex(v.inputs.recoverySalt)),
      });
    case 'GET /api/v1/library':
      return json(200, {
        id: LIBRARY_ID,
        createdAt: 1,
        passwordSalt: toBase64(fromHex(v.inputs.passwordSalt)),
        recoverySalt: toBase64(fromHex(v.inputs.recoverySalt)),
        passwordWrap,
        recoveryCodesRemaining: 10,
        storage: {},
      });
    case 'PUT /api/v1/library/password':
      return body.authKey === toBase64(fromHex(v.password.authKey))
        ? noContent()
        : json(401, { error: 'Invalid credentials' });
    case 'PUT /api/v1/library/recovery-codes':
      return json(200, { ids: body.codes.map((_: unknown, i: number) => `rc${i}`) });
    case 'POST /api/v1/recovery':
      return body.authKey === toBase64(fromHex(v.recovery.authKey))
        ? json(200, {
            recoveryId: 'rc1',
            libraryId: LIBRARY_ID,
            wrap: toBase64(fromHex(v.wraps.recovery)),
          })
        : json(401, { error: 'Invalid credentials' });
    case 'POST /api/v1/recovery/rc1/password':
      return noContent();
    case 'DELETE /api/v1/library':
      return body.setupCode === 'setup-123'
        ? noContent()
        : json(403, { error: 'Wrong setup code' });
    default:
      throw new Error(`unexpected fetch ${route}`);
  }
};

beforeEach(async () => {
  calls = [];
  passwordWrap = toBase64(
    await seal(fromHex(v.password.kek), LIBRARY_KEY, keyWrapAad(LIBRARY_ID, 'password'))
  );
  vi.stubGlobal('fetch', vi.fn(vault));
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('changePassword', () => {
  it(
    'changePassword posts a wrap that opens to the same library key under the new kek',
    async () => {
      const result = await changePassword({
        currentPassword: v.inputs.password,
        newPassword: 'a brand new passphrase',
        secretKey: v.formatted.secretKey,
      });
      expect(result.ok).toBe(true);

      const body = lastBody('/api/v1/library/password', 'PUT');
      expect(Object.keys(body).sort()).toEqual([
        'authKey',
        'newAuthKey',
        'newPasswordSalt',
        'newPasswordWrap',
      ]);
      expect(body.authKey).toBe(toBase64(fromHex(v.password.authKey)));
      const newSalt = fromBase64(body.newPasswordSalt as string);
      expect(newSalt.length).toBe(16);
      expect(toHex(newSalt)).not.toBe(v.inputs.passwordSalt);

      const fresh = await deriveAccountKeys({
        secret: utf8('a brand new passphrase'),
        secretKey: SECRET_KEY,
        salt: newSalt,
      });
      expect(body.newAuthKey).toBe(toBase64(fresh.authKey));
      const opened = await open(
        fresh.kek,
        fromBase64(body.newPasswordWrap as string),
        keyWrapAad(LIBRARY_ID, 'password')
      );
      expect(toHex(opened)).toBe(v.inputs.libraryKey);
    },
    SLOW
  );

  it(
    'a wrong current password fails before any write is posted',
    async () => {
      const result = await changePassword({
        currentPassword: 'not the password',
        newPassword: 'whatever',
        secretKey: v.formatted.secretKey,
      });
      expect(result).toEqual({ ok: false, status: 401, error: 'Invalid credentials' });
      expect(writes()).toEqual([]);
    },
    SLOW
  );
});

describe('regenerateRecoveryCodes', () => {
  it(
    'regenerateRecoveryCodes posts ten wraps that each open to the library key under their code',
    async () => {
      const result = await regenerateRecoveryCodes({
        password: v.inputs.password,
        secretKey: v.formatted.secretKey,
      });
      if (!result.ok) throw new Error(result.error);
      const codes = result.body;
      expect(codes).toHaveLength(10);
      expect(new Set(codes).size).toBe(10);
      for (const code of codes) expect(code).toMatch(/^[A-Z2-7]{4}(-[A-Z2-7]{4}){3}$/);

      const body = lastBody('/api/v1/library/recovery-codes', 'PUT');
      expect(body.authKey).toBe(toBase64(fromHex(v.password.authKey)));
      const salt = fromBase64(body.recoverySalt as string);
      expect(salt.length).toBe(16);
      expect(toHex(salt)).not.toBe(v.inputs.recoverySalt);
      const posted = body.codes as { authKey: string; wrap: string }[];
      expect(posted).toHaveLength(10);

      await Promise.all(
        codes.map(async (code, i) => {
          const keys = await deriveAccountKeys({
            secret: parseRecoveryCode(code)!,
            secretKey: SECRET_KEY,
            salt,
          });
          expect(posted[i].authKey).toBe(toBase64(keys.authKey));
          const opened = await open(
            keys.kek,
            fromBase64(posted[i].wrap),
            keyWrapAad(LIBRARY_ID, 'recovery')
          );
          expect(toHex(opened)).toBe(v.inputs.libraryKey);
        })
      );
    },
    SLOW
  );
});

describe('recover', () => {
  it(
    'recover unwraps with the code and posts new password material',
    async () => {
      const result = await recover({
        code: v.formatted.recoveryCode,
        secretKey: v.formatted.secretKey,
        newPassword: 'after recovery',
      });
      expect(result.ok).toBe(true);

      expect(lastBody('/api/v1/recovery', 'POST')).toEqual({
        authKey: toBase64(fromHex(v.recovery.authKey)),
      });
      const body = lastBody('/api/v1/recovery/rc1/password', 'POST');
      expect(body.authKey).toBe(toBase64(fromHex(v.recovery.authKey)));
      const newSalt = fromBase64(body.newPasswordSalt as string);
      expect(newSalt.length).toBe(16);
      const fresh = await deriveAccountKeys({
        secret: utf8('after recovery'),
        secretKey: SECRET_KEY,
        salt: newSalt,
      });
      expect(body.newAuthKey).toBe(toBase64(fresh.authKey));
      const opened = await open(
        fresh.kek,
        fromBase64(body.newPasswordWrap as string),
        keyWrapAad(LIBRARY_ID, 'password')
      );
      expect(toHex(opened)).toBe(v.inputs.libraryKey);
    },
    SLOW
  );

  it(
    'passes a 401 through when the code is not known',
    async () => {
      const result = await recover({
        code: 'AAAA-AAAA-AAAA-AAAA',
        secretKey: v.formatted.secretKey,
        newPassword: 'x',
      });
      expect(result).toMatchObject({ ok: false, status: 401 });
      expect(calls.filter((c) => c.url.endsWith('/password'))).toEqual([]);
    },
    SLOW
  );
});

describe('wrong or malformed secrets', () => {
  const otherKey = formatSecretKey(new Uint8Array(16).fill(7));

  it(
    'a wrong secret key fails before any write is posted',
    async () => {
      const changed = await changePassword({
        currentPassword: v.inputs.password,
        newPassword: 'new',
        secretKey: otherKey,
      });
      const regenerated = await regenerateRecoveryCodes({
        password: v.inputs.password,
        secretKey: otherKey,
      });
      expect(changed).toEqual({ ok: false, status: 401, error: 'Invalid credentials' });
      expect(regenerated).toEqual({ ok: false, status: 401, error: 'Invalid credentials' });
      expect(writes()).toEqual([]);
    },
    SLOW
  );

  it('a malformed secret key or recovery code sends no request at all', async () => {
    const invalidKey = { ok: false, status: 400, error: 'Invalid secret key' };
    expect(
      await changePassword({ currentPassword: 'a', newPassword: 'b', secretKey: 'A1-NOPE' })
    ).toEqual(invalidKey);
    expect(await regenerateRecoveryCodes({ password: 'a', secretKey: 'nope' })).toEqual(invalidKey);
    expect(
      await recover({ code: v.formatted.recoveryCode, secretKey: 'nope', newPassword: 'b' })
    ).toEqual(invalidKey);
    expect(
      await recover({ code: 'NOT-A-CODE', secretKey: v.formatted.secretKey, newPassword: 'b' })
    ).toEqual({ ok: false, status: 400, error: 'Invalid recovery code' });
    expect(calls).toEqual([]);
  });
});

describe('resetLibrary', () => {
  it('deletes the library with the setup code and the confirmation word', async () => {
    expect((await resetLibrary({ setupCode: 'setup-123' })).ok).toBe(true);
    expect(lastBody('/api/v1/library', 'DELETE')).toEqual({
      setupCode: 'setup-123',
      confirm: 'DELETE',
    });
    expect(await resetLibrary({ setupCode: 'wrong' })).toMatchObject({
      ok: false,
      status: 403,
      error: 'Wrong setup code',
    });
  });
});
