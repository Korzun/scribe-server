import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Kit } from '~/lib/setup';
import { renderWithProviders } from '~/test-utils';

import { SetupPage } from './index';

const SECRET_KEY_STORAGE = 'scribe:secret-key';
const SETUP_CODE = 'a-long-setup-code';
const PASSWORD = 'correct horse battery staple';

const KIT: Kit = {
  libraryId: '0b8e6b1c-3a7a-4c7e-9a2f-5d2b4e8f1c11',
  secretKey: 'A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74',
  recoveryCodes: Array.from(
    { length: 10 },
    (_, i) => `CODE-${String(i).padStart(4, '0')}-AAAA-BBBB`
  ),
  authKey: 'YXV0aC1rZXktYXV0aC1rZXktYXV0aC1rZXktYXV0aA==',
  request: {
    libraryId: '0b8e6b1c-3a7a-4c7e-9a2f-5d2b4e8f1c11',
    passwordSalt: 'cGFzc3dvcmQtc2FsdC0xNg==',
    recoverySalt: 'cmVjb3Zlcnktc2FsdC0xNg==',
    authKey: 'YXV0aC1rZXktYXV0aC1rZXktYXV0aC1rZXktYXV0aA==',
    passwordWrap: 'd3JhcA==',
    recoveryCodes: Array.from({ length: 10 }, () => ({ authKey: 'YQ==', wrap: 'Yg==' })),
  },
};

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  prepareLibrary: vi.fn(),
}));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));
// The real kit costs eleven PBKDF2 runs; the page is tested against a fixed one.
// `createLibrary` and `kitFileText` stay real.
vi.mock('~/lib/setup', async (orig) => ({
  ...(await orig<typeof import('~/lib/setup')>()),
  prepareLibrary: mocks.prepareLibrary,
}));

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

const posts = (url: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) => u === url && (init as RequestInit | undefined)?.method === 'POST'
  );

beforeEach(() => {
  mocks.prepareLibrary.mockResolvedValue(KIT);
  routes = {
    '/api/v1/status': () => json(200, { libraryExists: false, version: '0.1.0', publicUrl: null }),
    '/api/v1/library': () => json(201, { libraryId: KIT.libraryId }),
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
  vi.clearAllMocks();
  localStorage.clear();
});

/** Fills step one and continues to the kit. */
const toKit = async (password = PASSWORD, confirm = PASSWORD, setupCode = SETUP_CODE) => {
  const user = userEvent.setup();
  await user.type(await screen.findByPlaceholderText('Password'), password);
  await user.type(screen.getByPlaceholderText('Confirm password'), confirm);
  await user.type(screen.getByPlaceholderText('Setup code'), setupCode);
  await user.click(screen.getByRole('button', { name: 'Continue' }));
  return user;
};

describe('SetupPage', () => {
  it('redirects to sign-in when a library already exists', async () => {
    routes['/api/v1/status'] = () =>
      json(200, { libraryExists: true, version: '0.1.0', publicUrl: null });
    renderWithProviders(<SetupPage />);

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/login', { replace: true }));
    expect(screen.queryByPlaceholderText('Password')).not.toBeInTheDocument();
  });

  it('step 1 refuses mismatched passwords and never generates a kit', async () => {
    renderWithProviders(<SetupPage />);
    await toKit(PASSWORD, 'something else');

    expect(screen.getByText("The passwords don't match")).toBeInTheDocument();
    expect(mocks.prepareLibrary).not.toHaveBeenCalled();
  });

  it('step 1 refuses a setup code shorter than 12 characters', async () => {
    renderWithProviders(<SetupPage />);
    await toKit(PASSWORD, PASSWORD, 'short');

    expect(screen.getByText('The setup code is at least 12 characters')).toBeInTheDocument();
    expect(mocks.prepareLibrary).not.toHaveBeenCalled();
  });

  it('step 2 shows the Secret Key and ten codes, with Create disabled until the checkbox is ticked', async () => {
    renderWithProviders(<SetupPage />);
    const user = await toKit();

    expect(await screen.findByText(KIT.secretKey)).toBeInTheDocument();
    for (const code of KIT.recoveryCodes) expect(screen.getByText(code)).toBeInTheDocument();
    expect(mocks.prepareLibrary).toHaveBeenCalledWith(PASSWORD);

    const create = screen.getByRole('button', { name: 'Create library' });
    expect(create).toBeDisabled();
    await user.click(
      screen.getByRole('checkbox', {
        name: 'I have saved my Secret Key and recovery codes somewhere safe.',
      })
    );
    expect(create).toBeEnabled();
    expect(posts('/api/v1/library')).toHaveLength(0);
  });

  it('Download kit saves a text file containing the Secret Key and the page origin', async () => {
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:kit';
      }),
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithProviders(<SetupPage />);
    const user = await toKit();

    await user.click(await screen.findByRole('button', { name: 'Download kit' }));

    expect(click).toHaveBeenCalledTimes(1);
    expect(blobs).toHaveLength(1);
    const text = await blobs[0].text();
    expect(text).toContain(KIT.secretKey);
    expect(text).toContain(KIT.recoveryCodes[9]);
    expect(text).toContain(window.location.origin);
    click.mockRestore();
  });

  it('names the vault by its public URL in the kit when the vault has one', async () => {
    routes['/api/v1/status'] = () =>
      json(200, { libraryExists: false, version: '0.1.0', publicUrl: 'https://vault.example.com' });
    const blobs: Blob[] = [];
    vi.stubGlobal('URL', {
      ...URL,
      createObjectURL: vi.fn((blob: Blob) => {
        blobs.push(blob);
        return 'blob:kit';
      }),
      revokeObjectURL: vi.fn(),
    });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    renderWithProviders(<SetupPage />);
    const user = await toKit();

    await user.click(await screen.findByRole('button', { name: 'Download kit' }));

    expect(await blobs[0].text()).toContain('Vault: https://vault.example.com');
    click.mockRestore();
  });

  it('creates the library, signs in, remembers the Secret Key, and lands home', async () => {
    const signIn = vi.fn();
    renderWithProviders(<SetupPage />, { auth: { signIn } });
    const user = await toKit();

    await user.click(
      await screen.findByRole('checkbox', {
        name: 'I have saved my Secret Key and recovery codes somewhere safe.',
      })
    );
    await user.click(screen.getByRole('button', { name: 'Create library' }));

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('owner.jwt.token'));
    const [[, createInit]] = posts('/api/v1/library');
    expect(JSON.parse((createInit as RequestInit).body as string)).toEqual({
      setupCode: SETUP_CODE,
      ...KIT.request,
    });
    const [[, sessionInit]] = posts('/api/v1/session');
    expect(JSON.parse((sessionInit as RequestInit).body as string)).toEqual({
      authKey: KIT.authKey,
    });
    expect(localStorage.getItem(SECRET_KEY_STORAGE)).toBe(KIT.secretKey);
  });

  it('a 403 keeps the kit on screen and lets the owner retry with a corrected code', async () => {
    let attempts = 0;
    routes['/api/v1/library'] = () =>
      ++attempts === 1
        ? json(403, { error: 'Wrong setup code' })
        : json(201, { libraryId: KIT.libraryId });
    const signIn = vi.fn();
    renderWithProviders(<SetupPage />, { auth: { signIn } });
    const user = await toKit();
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'I have saved my Secret Key and recovery codes somewhere safe.',
      })
    );

    await user.click(screen.getByRole('button', { name: 'Create library' }));

    expect(await screen.findByText('Wrong setup code')).toBeInTheDocument();
    expect(screen.getByText(KIT.secretKey)).toBeInTheDocument();
    expect(signIn).not.toHaveBeenCalled();
    expect(mocks.prepareLibrary).toHaveBeenCalledTimes(1);

    const codeField = screen.getByPlaceholderText('Setup code');
    await user.clear(codeField);
    await user.type(codeField, 'the-corrected-code');
    await user.click(screen.getByRole('button', { name: 'Create library' }));

    await waitFor(() => expect(signIn).toHaveBeenCalledWith('owner.jwt.token'));
    const bodies = posts('/api/v1/library').map(([, init]) =>
      JSON.parse((init as RequestInit).body as string)
    );
    expect(bodies.map((b) => b.setupCode)).toEqual([SETUP_CODE, 'the-corrected-code']);
    // The same kit both times: the owner saved one Secret Key and it is the one that works.
    expect(bodies[1].libraryId).toBe(KIT.libraryId);
  });

  it('a 409 sends the owner to sign in', async () => {
    routes['/api/v1/library'] = () => json(409, { error: 'Library exists' });
    renderWithProviders(<SetupPage />);
    const user = await toKit();
    await user.click(
      await screen.findByRole('checkbox', {
        name: 'I have saved my Secret Key and recovery codes somewhere safe.',
      })
    );

    await user.click(screen.getByRole('button', { name: 'Create library' }));

    expect(await screen.findByText('A library already exists here — sign in')).toBeInTheDocument();
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/login'));
  });

  it('shows the HTTPS message when key derivation is unavailable', async () => {
    mocks.prepareLibrary.mockRejectedValue(new Error('crypto.subtle is undefined'));
    renderWithProviders(<SetupPage />);
    await toKit();

    expect(
      await screen.findByText(
        'This browser cannot derive your keys here — open the vault over HTTPS'
      )
    ).toBeInTheDocument();
    expect(screen.queryByText('Create library')).not.toBeInTheDocument();
  });
});
