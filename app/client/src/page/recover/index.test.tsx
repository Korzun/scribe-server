import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { RecoverPage } from './index';

const SECRET_KEY = 'A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74';
const CODE = 'EERC-GJBF-EYTS-QKJK';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), recover: vi.fn() }));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('~/lib/account', async (orig) => ({
  ...(await orig<typeof import('~/lib/account')>()),
  recover: mocks.recover,
}));

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn(async () => {
    throw new Error('no request expected');
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

const fill = async (code: string, secretKey: string | null, pw: string, confirm: string) => {
  const user = userEvent.setup();
  await user.type(screen.getByPlaceholderText('Recovery code'), code);
  if (secretKey !== null) await user.type(screen.getByPlaceholderText('Secret Key'), secretKey);
  await user.type(screen.getByPlaceholderText('New password'), pw);
  await user.type(screen.getByPlaceholderText('Confirm new password'), confirm);
  await user.click(screen.getByRole('button', { name: 'Set new password' }));
  return user;
};

describe('RecoverPage', () => {
  it('states that recovery needs the Secret Key, verbatim', () => {
    renderWithProviders(<RecoverPage />);
    expect(
      screen.getByText(
        'A recovery code needs your Secret Key. Without the Secret Key nothing can recover this library.'
      )
    ).toBeInTheDocument();
  });

  it('recover page refuses mismatched passwords and never posts', async () => {
    renderWithProviders(<RecoverPage />);
    await fill(CODE, SECRET_KEY, 'one password', 'another password');

    expect(screen.getByText("The new passwords don't match")).toBeInTheDocument();
    expect(mocks.recover).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('pre-fills the remembered secret key and on success sends the owner to sign in', async () => {
    localStorage.setItem('scribe:secret-key', SECRET_KEY);
    mocks.recover.mockResolvedValue({ ok: true, status: 204, body: undefined });
    renderWithProviders(<RecoverPage />);

    expect(screen.getByPlaceholderText('Secret Key')).toHaveValue(SECRET_KEY);
    await fill(CODE, null, 'fresh', 'fresh');

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/login'));
    expect(mocks.recover).toHaveBeenCalledWith({
      code: CODE,
      secretKey: SECRET_KEY,
      newPassword: 'fresh',
    });
    expect(await screen.findByText('Password set — sign in with it now')).toBeInTheDocument();
  });

  it('toasts on a 401 without navigating', async () => {
    mocks.recover.mockResolvedValue({ ok: false, status: 401, error: 'Invalid credentials' });
    renderWithProviders(<RecoverPage />);
    await fill(CODE, SECRET_KEY, 'fresh', 'fresh');

    expect(await screen.findByText('That code or Secret Key is wrong')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
