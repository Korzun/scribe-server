import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { fromHex, toBase64 } from '~/lib/bytes';
import { loadVectors } from '~/lib/test-vectors';
import { renderWithProviders } from '~/test-utils';

import { LoginPage } from './index';

const v = loadVectors();
const SECRET_KEY_STORAGE = 'scribe:secret-key';

const routerMocks = vi.hoisted(() => ({ navigate: vi.fn() }));
// Real derivation unless a test opts into the stand-in.
const kdfMocks = vi.hoisted(() => ({ fake: false }));
vi.mock('~/lib/kdf', async (orig) => {
  const real = await orig<typeof import('~/lib/kdf')>();
  return {
    ...real,
    deriveAccountKeys: (input: Parameters<typeof real.deriveAccountKeys>[0]) =>
      kdfMocks.fake
        ? Promise.resolve({
            auk: new Uint8Array(32),
            kek: new Uint8Array(32),
            authKey: new Uint8Array(32).fill(1),
          })
        : real.deriveAccountKeys(input),
  };
});

vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => routerMocks.navigate,
}));

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

const posts = (url: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) => u === url && (init as RequestInit | undefined)?.method === 'POST'
  );

beforeEach(() => {
  routes = {
    '/api/v1/status': () => json(200, { libraryExists: true, version: '0.1.0' }),
    '/api/v1/library/salts': () =>
      json(200, {
        passwordSalt: toBase64(fromHex(v.inputs.passwordSalt)),
        recoverySalt: toBase64(fromHex(v.inputs.recoverySalt)),
      }),
    '/api/v1/session': () => json(200, { accessToken: 'owner.jwt.token' }),
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  routerMocks.navigate.mockReset();
  localStorage.clear();
});

const fillAndSubmit = async (password: string, secretKey: string) => {
  const user = userEvent.setup();
  const keyField = await screen.findByPlaceholderText('Secret Key');
  await user.type(screen.getByPlaceholderText('Password'), password);
  await user.clear(keyField);
  await user.type(keyField, secretKey);
  await user.click(screen.getByRole('button', { name: 'Sign In' }));
  return user;
};

describe('LoginPage', () => {
  it('redirects to setup when no library exists', async () => {
    routes['/api/v1/status'] = () => json(200, { libraryExists: false, version: '0.1.0' });
    renderWithProviders(<LoginPage />);

    await waitFor(() =>
      expect(routerMocks.navigate).toHaveBeenCalledWith('/setup', { replace: true })
    );
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Sign In' })).not.toBeInTheDocument();
  });

  it('derives the auth key and posts it, remembering the secret key on success', async () => {
    const signIn = vi.fn();
    renderWithProviders(<LoginPage />, { auth: { signIn } });

    await fillAndSubmit(v.inputs.password, v.formatted.secretKey);

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('owner.jwt.token'), {
      timeout: 30_000,
    });
    const [[, init]] = posts('/api/v1/session');
    expect(JSON.parse(init.body as string)).toEqual({
      authKey: toBase64(fromHex(v.password.authKey)),
    });
    expect(localStorage.getItem(SECRET_KEY_STORAGE)).toBe(v.formatted.secretKey);
  }, 60_000);

  it('a wrong secret key format shows an inline error and posts nothing', async () => {
    const signIn = vi.fn();
    renderWithProviders(<LoginPage />, { auth: { signIn } });

    await fillAndSubmit('whatever', 'A1-NOT-A-KEY');

    expect(await screen.findByText("That doesn't look like a Secret Key")).toBeInTheDocument();
    expect(posts('/api/v1/session')).toHaveLength(0);
    expect(fetchMock.mock.calls.map(([u]) => u)).not.toContain('/api/v1/library/salts');
    expect(signIn).not.toHaveBeenCalled();
    expect(localStorage.getItem(SECRET_KEY_STORAGE)).toBeNull();
  });

  it('pre-fills the remembered secret key, and forgets it on request', async () => {
    localStorage.setItem(SECRET_KEY_STORAGE, v.formatted.secretKey);
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    expect(await screen.findByPlaceholderText('Secret Key')).toHaveValue(v.formatted.secretKey);
    await user.click(screen.getByRole('button', { name: 'Forget this key on this browser' }));
    expect(screen.getByPlaceholderText('Secret Key')).toHaveValue('');
    expect(localStorage.getItem(SECRET_KEY_STORAGE)).toBeNull();
  });

  // The remaining outcomes do not need the real key: the derivation is pinned
  // above, so a cheap stand-in keeps each test off 650k PBKDF2 rounds.
  describe('server answers', () => {
    beforeEach(() => {
      kdfMocks.fake = true;
    });
    afterEach(() => {
      kdfMocks.fake = false;
    });

    const renderPage = () => {
      const signIn = vi.fn();
      renderWithProviders(<LoginPage />, { auth: { signIn } });
      return signIn;
    };

    it('toasts "Invalid credentials" on a 401 and keeps the key unremembered', async () => {
      routes['/api/v1/session'] = () => json(401, { error: 'Invalid credentials' });
      const signIn = renderPage();
      await fillAndSubmit('wrong', v.formatted.secretKey);

      expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
      expect(signIn).not.toHaveBeenCalled();
      expect(localStorage.getItem(SECRET_KEY_STORAGE)).toBeNull();
    });

    it('toasts a retry-after message on a 429 rather than "Invalid credentials"', async () => {
      routes['/api/v1/session'] = () =>
        json(429, { error: 'Too many attempts' }, { 'Retry-After': '42' });
      renderPage();
      await fillAndSubmit('pw', v.formatted.secretKey);

      expect(
        await screen.findByText('Too many attempts — try again in 42 seconds')
      ).toBeInTheDocument();
      expect(screen.queryByText('Invalid credentials')).not.toBeInTheDocument();
    });

    it('toasts a network error when the vault cannot be reached', async () => {
      routes['/api/v1/session'] = () => {
        throw new TypeError('Failed to fetch');
      };
      renderPage();
      await fillAndSubmit('pw', v.formatted.secretKey);

      expect(await screen.findByText('Network error — please try again')).toBeInTheDocument();
    });
  });

  it('links to recovery and to the keys-lost reset', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.click(await screen.findByRole('button', { name: 'Forgot password' }));
    expect(routerMocks.navigate).toHaveBeenLastCalledWith('/recover');
    await user.click(screen.getByRole('button', { name: 'Lost everything' }));
    expect(routerMocks.navigate).toHaveBeenLastCalledWith('/reset');
  });
});
