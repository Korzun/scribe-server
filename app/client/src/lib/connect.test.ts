import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromBase64, fromHex, toBase64 } from './bytes';
import { formatSecretKey } from './codes';
import {
  approveConnection,
  denyConnection,
  readConsentRequest,
  type ConsentRequest,
} from './connect';
import { deriveTokenKek, hashTokenSecret } from './kdf';
import { keyWrapAad, open, seal, tokenWrapAad } from './seal';
import { loadVectors } from './test-vectors';

const v = loadVectors();
const LIBRARY_ID = v.inputs.libraryId;
const LIBRARY_KEY = fromHex(v.inputs.libraryKey);
const SECRET_KEY = fromHex(v.inputs.secretKey);
// Each approval runs a real 650k-round PBKDF2 derivation.
const SLOW = 60_000;

const REQUEST: ConsentRequest = {
  clientId: 'c1',
  redirectUri: 'https://client.example/callback',
  codeChallenge: 'challenge',
  state: 'xyz',
  scope: 'library:read',
  resource: 'https://vault.example/mcp',
};

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

type Call = { url: string; method: string; body: Record<string, unknown> | undefined };
let calls: Call[];
let passwordWrap: string;

const fromBase64Url = (text: string) =>
  fromBase64(text.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (text.length % 4)) % 4));

/** A stand-in vault holding the vector library, answering consent as routes/mcp-admin.ts does. */
const vault = async (url: string, init?: RequestInit): Promise<Response> => {
  const method = init?.method ?? 'GET';
  const body =
    typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : undefined;
  calls.push({ url, method, body });
  switch (`${method} ${url}`) {
    case 'GET /api/v1/library/salts':
      return json(200, {
        passwordSalt: toBase64(fromHex(v.inputs.passwordSalt)),
        recoverySalt: toBase64(fromHex(v.inputs.recoverySalt)),
      });
    case 'GET /api/v1/library':
      return json(200, { id: LIBRARY_ID, passwordWrap });
    case 'POST /api/v1/mcp/authorize': {
      const redirect = new URL(body!.redirectUri as string);
      redirect.searchParams.set('state', body!.state as string);
      if (body!.approve !== true) redirect.searchParams.set('error', 'access_denied');
      return json(200, { redirectUrl: redirect.href });
    }
    default:
      return json(404, { error: 'Not found' });
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

describe('readConsentRequest', () => {
  it('reads the forwarded parameters and refuses a link missing any required one', () => {
    const params = new URLSearchParams({
      client_id: 'c1',
      redirect_uri: 'https://client.example/callback',
      code_challenge: 'challenge',
      state: 'xyz',
    });
    expect(readConsentRequest(params)).toEqual({ ...REQUEST, scope: null, resource: null });
    params.delete('code_challenge');
    expect(readConsentRequest(params)).toBeNull();
  });
});

describe('approveConnection', () => {
  it(
    'sends the vault the code hash and a wrap only the code opens, and appends the code to the redirect',
    async () => {
      const result = await approveConnection({
        request: REQUEST,
        password: v.inputs.password,
        secretKey: formatSecretKey(SECRET_KEY),
      });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      const posted = calls.find((c) => c.url === '/api/v1/mcp/authorize')!.body!;
      expect(posted).toMatchObject({
        clientId: 'c1',
        redirectUri: REQUEST.redirectUri,
        codeChallenge: 'challenge',
        state: 'xyz',
        scope: 'library:read',
        resource: REQUEST.resource,
        approve: true,
      });
      // The vault was never sent the code itself.
      expect(JSON.stringify(posted)).not.toContain(
        new URL(result.body.redirectUrl).searchParams.get('code')
      );

      const url = new URL(result.body.redirectUrl);
      expect(url.origin + url.pathname).toBe(REQUEST.redirectUri);
      expect(url.searchParams.get('state')).toBe('xyz');
      const wire = url.searchParams.get('code')!;
      expect(wire).toMatch(/^[A-Za-z0-9_-]{43}$/);
      expect(posted.codeHash).toBe(await hashTokenSecret(wire));

      // What the vault will do at the token exchange: derive the key from the
      // code and open the wrap under the code's own AAD.
      const kek = await deriveTokenKek(fromBase64Url(wire));
      const opened = await open(
        kek,
        fromBase64(posted.wrap as string),
        tokenWrapAad(LIBRARY_ID, 'code', posted.codeHash as string)
      );
      expect(opened).toEqual(LIBRARY_KEY);
      await expect(
        open(
          kek,
          fromBase64(posted.wrap as string),
          tokenWrapAad(LIBRARY_ID, 'access', posted.codeHash as string)
        )
      ).rejects.toThrow();
      expect(result.body.secretKey).toBe(formatSecretKey(SECRET_KEY));
    },
    SLOW
  );

  it(
    'a wrong password is Invalid credentials and nothing is posted to the vault',
    async () => {
      const result = await approveConnection({
        request: REQUEST,
        password: 'wrong',
        secretKey: formatSecretKey(SECRET_KEY),
      });
      expect(result).toEqual({ ok: false, status: 401, error: 'Invalid credentials' });
      expect(calls.some((c) => c.url === '/api/v1/mcp/authorize')).toBe(false);
    },
    SLOW
  );

  it('a malformed Secret Key is refused before anything is fetched', async () => {
    const result = await approveConnection({ request: REQUEST, password: 'x', secretKey: 'nope' });
    expect(result).toEqual({ ok: false, status: 400, error: 'Invalid secret key' });
    expect(calls).toEqual([]);
  });
});

describe('denyConnection', () => {
  it('posts the decision without any key material and returns where to go', async () => {
    const result = await denyConnection(REQUEST);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(new URL(result.body.redirectUrl).searchParams.get('error')).toBe('access_denied');
    const posted = calls[0]!.body!;
    expect(posted.approve).toBe(false);
    expect(posted.codeHash).toBeUndefined();
    expect(posted.wrap).toBeUndefined();
    expect(calls).toHaveLength(1);
  });
});
