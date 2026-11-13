import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromBase64, toBase64 } from './bytes';
import { parseRecoveryCode, parseSecretKey } from './codes';
import { deriveAccountKeys, passwordBytes } from './kdf';
import { keyWrapAad, open } from './seal';
import { createLibrary, type Kit, kitFileText, prepareLibrary } from './setup';

// Each kit costs eleven real 650k-round PBKDF2 derivations.
const SLOW = 120_000;
const PASSWORD = 'correct horse battery staple';

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

let fetchMock: ReturnType<typeof vi.fn>;
let kit: Kit;

beforeEach(async () => {
  kit ??= await prepareLibrary(PASSWORD);
  fetchMock = vi.fn(async () => json(201, { libraryId: kit.libraryId }));
  vi.stubGlobal('fetch', fetchMock);
}, SLOW);
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('prepareLibrary', () => {
  it(
    'produces a kit whose wraps open with the keys the password and the codes derive',
    async () => {
      expect(kit.libraryId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
      );
      const secretKey = parseSecretKey(kit.secretKey);
      expect(secretKey).not.toBeNull();
      expect(kit.recoveryCodes).toHaveLength(10);
      expect(new Set(kit.recoveryCodes).size).toBe(10);
      expect(kit.request.recoveryCodes).toHaveLength(10);
      expect(kit.request.libraryId).toBe(kit.libraryId);

      // The password wrap opens under the password-derived kek, and the auth
      // key the kit carries is the one the server will verify.
      const password = await deriveAccountKeys({
        secret: passwordBytes(PASSWORD),
        secretKey: secretKey!,
        salt: fromBase64(kit.request.passwordSalt),
      });
      expect(toBase64(password.authKey)).toBe(kit.authKey);
      expect(kit.request.authKey).toBe(kit.authKey);
      const libraryKey = await open(
        password.kek,
        fromBase64(kit.request.passwordWrap),
        keyWrapAad(kit.libraryId, 'password')
      );
      expect(libraryKey).toHaveLength(32);

      // The first recovery code's wrap opens to the same Library Key.
      const code = parseRecoveryCode(kit.recoveryCodes[0]);
      expect(code).not.toBeNull();
      const recovery = await deriveAccountKeys({
        secret: code!,
        secretKey: secretKey!,
        salt: fromBase64(kit.request.recoverySalt),
      });
      expect(toBase64(recovery.authKey)).toBe(kit.request.recoveryCodes[0].authKey);
      expect(
        await open(
          recovery.kek,
          fromBase64(kit.request.recoveryCodes[0].wrap),
          keyWrapAad(kit.libraryId, 'recovery')
        )
      ).toEqual(libraryKey);
    },
    SLOW
  );
});

describe('createLibrary', () => {
  it('posts the request with the setup code and no device, and returns the library id', async () => {
    const result = await createLibrary(kit, 'a-long-setup-code');

    expect(result).toEqual({ ok: true, status: 201, body: { libraryId: kit.libraryId } });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('/api/v1/library');
    expect(init.method).toBe('POST');
    const sent = JSON.parse(init.body as string);
    expect(sent).toEqual({ setupCode: 'a-long-setup-code', ...kit.request });
    expect(sent.device).toBeUndefined();
  });

  it('passes a 403 through unchanged', async () => {
    fetchMock.mockImplementation(async () => json(403, { error: 'Wrong setup code' }));

    const result = await createLibrary(kit, 'the-wrong-code-12');

    expect(result).toEqual({ ok: false, status: 403, error: 'Wrong setup code' });
  });
});

describe('kitFileText', () => {
  it('contains the URL, the Secret Key, every code, and the explanation', () => {
    const text = kitFileText(kit, 'https://vault.example.com');

    expect(text).toContain('https://vault.example.com');
    expect(text).toContain(kit.secretKey);
    for (const code of kit.recoveryCodes) expect(text).toContain(code);
    expect(text).toContain('Your password is not on this page');
  });
});
