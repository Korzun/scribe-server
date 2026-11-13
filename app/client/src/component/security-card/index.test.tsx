import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { SecurityCard } from './index';

const SECRET_KEY = 'A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74';
const STORAGE_KEY = 'scribe:secret-key';
const CODES = Array.from(
  { length: 10 },
  (_, i) => `AAAA-BBBB-CCCC-DD${String.fromCharCode(65 + i)}A`
);

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  changePassword: vi.fn(),
  regenerateRecoveryCodes: vi.fn(),
}));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));
vi.mock('~/lib/account', () => ({
  changePassword: mocks.changePassword,
  regenerateRecoveryCodes: mocks.regenerateRecoveryCodes,
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

beforeEach(() => {
  localStorage.setItem(STORAGE_KEY, SECRET_KEY);
});
afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

const openDialog = () => screen.getByRole('dialog');

describe('SecurityCard', () => {
  it('security-card regenerates and shows the codes once', async () => {
    mocks.regenerateRecoveryCodes.mockResolvedValue({ ok: true, status: 200, body: CODES });
    const onChanged = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(<SecurityCard recoveryCodesRemaining={3} onChanged={onChanged} />);

    expect(screen.getByText('3 remaining')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.type(within(openDialog()).getByPlaceholderText('Password'), 'hunter2');
    await user.click(within(openDialog()).getByRole('button', { name: 'Regenerate' }));

    await waitFor(() =>
      expect(mocks.regenerateRecoveryCodes).toHaveBeenCalledWith({
        password: 'hunter2',
        secretKey: SECRET_KEY,
      })
    );
    const sheet = await screen.findByRole('dialog');
    expect(within(sheet).getAllByRole('listitem')).toHaveLength(10);
    for (const code of CODES) expect(within(sheet).getByText(code)).toBeInTheDocument();
    expect(
      within(sheet).getByText('Your old codes no longer work. Each code needs your Secret Key.')
    ).toBeInTheDocument();
    expect(onChanged).toHaveBeenCalled();

    await user.click(within(sheet).getByRole('button', { name: 'Copy' }));
    expect(await navigator.clipboard.readText()).toBe(CODES.join('\n'));

    await user.click(within(sheet).getByRole('button', { name: "I've saved them" }));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    for (const code of CODES) expect(screen.queryByText(code)).not.toBeInTheDocument();
  });

  it('downloads the codes as scribe-recovery-codes.txt', async () => {
    mocks.regenerateRecoveryCodes.mockResolvedValue({ ok: true, status: 200, body: CODES });
    const createObjectURL = vi.fn(() => 'blob:codes');
    const revokeObjectURL = vi.fn();
    // jsdom has no object URLs.
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    const clicked: string[] = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement
    ) {
      clicked.push(this.download);
    });
    const user = userEvent.setup();
    renderWithProviders(<SecurityCard recoveryCodesRemaining={10} onChanged={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.type(within(openDialog()).getByPlaceholderText('Password'), 'pw');
    await user.click(within(openDialog()).getByRole('button', { name: 'Regenerate' }));
    await user.click(await screen.findByRole('button', { name: 'Download .txt' }));

    expect(clicked).toEqual(['scribe-recovery-codes.txt']);
    const [[blob]] = createObjectURL.mock.calls as unknown as [[Blob]];
    expect(await blob.text()).toContain(CODES.join('\n'));
    expect(revokeObjectURL).toHaveBeenCalledWith('blob:codes');
    click.mockRestore();
    Reflect.deleteProperty(URL, 'createObjectURL');
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  });

  it('a wrong password on regenerate toasts and shows no codes', async () => {
    mocks.regenerateRecoveryCodes.mockResolvedValue({
      ok: false,
      status: 401,
      error: 'Invalid credentials',
    });
    const user = userEvent.setup();
    renderWithProviders(<SecurityCard recoveryCodesRemaining={3} onChanged={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.type(within(openDialog()).getByPlaceholderText('Password'), 'nope');
    await user.click(within(openDialog()).getByRole('button', { name: 'Regenerate' }));

    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(screen.queryByRole('listitem')).not.toBeInTheDocument();
  });

  it('change password refuses a mismatch inline, then signs out to login on success', async () => {
    mocks.changePassword.mockResolvedValue({ ok: true, status: 204, body: undefined });
    const signOut = vi.fn(async () => undefined);
    const user = userEvent.setup();
    renderWithProviders(<SecurityCard recoveryCodesRemaining={3} onChanged={vi.fn()} />, {
      auth: { signedIn: true, signOut },
    });

    await user.click(screen.getByRole('button', { name: 'Change password' }));
    const dialog = openDialog();
    await user.type(within(dialog).getByPlaceholderText('Current password'), 'old');
    await user.type(within(dialog).getByPlaceholderText('New password'), 'new one');
    await user.type(within(dialog).getByPlaceholderText('Confirm new password'), 'new two');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));
    expect(within(dialog).getByText("The new passwords don't match")).toBeInTheDocument();
    expect(mocks.changePassword).not.toHaveBeenCalled();

    const confirm = within(dialog).getByPlaceholderText('Confirm new password');
    await user.clear(confirm);
    await user.type(confirm, 'new one');
    await user.click(within(dialog).getByRole('button', { name: 'Change password' }));

    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/login'));
    expect(mocks.changePassword).toHaveBeenCalledWith({
      currentPassword: 'old',
      newPassword: 'new one',
      secretKey: SECRET_KEY,
    });
    expect(signOut).toHaveBeenCalledOnce();
    expect(await screen.findByText('Password changed — sign in again.')).toBeInTheDocument();
  });

  it('masks the remembered secret key, reveals, copies and forgets it', async () => {
    const user = userEvent.setup();
    renderWithProviders(<SecurityCard recoveryCodesRemaining={3} onChanged={vi.fn()} />);

    expect(screen.getByText('A1-•••••-•••••-•••••-•••••-••••••')).toBeInTheDocument();
    expect(screen.queryByText(SECRET_KEY)).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reveal' }));
    expect(screen.getByText(SECRET_KEY)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Hide' }));
    expect(screen.queryByText(SECRET_KEY)).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy Secret Key' }));
    expect(await navigator.clipboard.readText()).toBe(SECRET_KEY);

    await user.click(screen.getByRole('button', { name: 'Forget on this browser' }));
    expect(screen.getByText('Not remembered on this browser')).toBeInTheDocument();
    expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
  });

  it('asks for the secret key in the prompt when none is remembered', async () => {
    localStorage.clear();
    mocks.regenerateRecoveryCodes.mockResolvedValue({ ok: true, status: 200, body: CODES });
    const user = userEvent.setup();
    renderWithProviders(<SecurityCard recoveryCodesRemaining={0} onChanged={vi.fn()} />);

    expect(screen.getByText('Not remembered on this browser')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Regenerate' }));
    await user.type(within(openDialog()).getByPlaceholderText('Password'), 'pw');
    await user.type(within(openDialog()).getByPlaceholderText('Secret Key'), SECRET_KEY);
    await user.click(within(openDialog()).getByRole('button', { name: 'Regenerate' }));

    await waitFor(() =>
      expect(mocks.regenerateRecoveryCodes).toHaveBeenCalledWith({
        password: 'pw',
        secretKey: SECRET_KEY,
      })
    );
  });
});
