import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { rememberSecretKey } from '~/lib/secret-key-store';
import { renderWithProviders } from '~/test-utils';

import { CAN_DO, ConnectPage, INVALID_LINK, LEAD } from './index';

vi.mock('~/lib/connect', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/lib/connect')>();
  return {
    ...actual,
    approveConnection: vi.fn(),
    denyConnection: vi.fn(),
    loadConsentClient: vi.fn(),
  };
});

import { approveConnection, denyConnection, loadConsentClient } from '~/lib/connect';

const approve = vi.mocked(approveConnection);
const deny = vi.mocked(denyConnection);
const loadClient = vi.mocked(loadConsentClient);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const LINK =
  '/connect?client_id=c1&redirect_uri=https%3A%2F%2Fclient.example%2Fcb&code_challenge=ch&state=xyz&scope=library%3Aread';

let assign: ReturnType<typeof vi.fn>;
beforeEach(() => {
  localStorage.clear();
  assign = vi.fn();
  Object.defineProperty(window, 'location', {
    value: { ...window.location, assign },
    writable: true,
    configurable: true,
  });
  loadClient.mockResolvedValue({
    ok: true,
    status: 200,
    body: { clientId: 'c1', clientName: 'Claude', clientUri: 'https://claude.ai' },
  });
});
afterEach(() => {
  vi.clearAllMocks();
});

const renderPage = (entry = LINK) =>
  renderWithProviders(<ConnectPage />, { auth: { signedIn: true }, initialEntries: [entry] });

describe('ConnectPage', () => {
  it('names the assistant, says what it gets, and offers Approve and Deny', async () => {
    renderPage();
    expect(await screen.findByRole('heading', { name: 'Connect Claude?' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Claude' })).toHaveAttribute(
      'href',
      'https://claude.ai'
    );
    expect(screen.getByText(LEAD)).toBeInTheDocument();
    expect(screen.getByText(CAN_DO)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Approve' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deny' })).toBeInTheDocument();
    expect(loadClient).toHaveBeenCalledWith('c1');
  });

  it('a link missing its parameters, or naming an unknown client, is invalid with nothing to decide', async () => {
    renderPage('/connect?client_id=c1');
    expect(await screen.findByText(INVALID_LINK)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument();
    expect(loadClient).not.toHaveBeenCalled();

    loadClient.mockResolvedValue({ ok: false, status: 404, error: 'Unknown client' });
    renderPage();
    await waitFor(() => expect(screen.getAllByText(INVALID_LINK)).toHaveLength(2));
  });

  it('Approve asks for the password (and the Secret Key when none is remembered), then follows the vault’s URL', async () => {
    approve.mockResolvedValue({
      ok: true,
      status: 200,
      body: { redirectUrl: 'https://client.example/cb?state=xyz&code=abc', secretKey: 'A1-KEY' },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).getByText('Unlock for this assistant')).toBeInTheDocument();
    await user.type(within(dialog).getByPlaceholderText('Password'), 'hunter2');
    await user.type(within(dialog).getByPlaceholderText('Secret Key'), 'A1-TYPED');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));

    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve.mock.calls[0]![0]).toEqual({
      request: {
        clientId: 'c1',
        redirectUri: 'https://client.example/cb',
        codeChallenge: 'ch',
        state: 'xyz',
        scope: 'library:read',
        resource: null,
      },
      password: 'hunter2',
      secretKey: 'A1-TYPED',
    });
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://client.example/cb?state=xyz&code=abc')
    );
    expect(localStorage.getItem('scribe:secret-key')).toBe('A1-KEY');
    expect(deny).not.toHaveBeenCalled();
  });

  it('uses the remembered Secret Key without asking for it', async () => {
    rememberSecretKey('A1-REMEMBERED');
    approve.mockResolvedValue({
      ok: true,
      status: 200,
      body: { redirectUrl: 'https://client.example/cb?code=x', secretKey: 'A1-REMEMBERED' },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    expect(within(dialog).queryByPlaceholderText('Secret Key')).not.toBeInTheDocument();
    await user.type(within(dialog).getByPlaceholderText('Password'), 'hunter2');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(approve).toHaveBeenCalledTimes(1));
    expect(approve.mock.calls[0]![0].secretKey).toBe('A1-REMEMBERED');
  });

  it('a wrong password toasts and leaves the page where it was', async () => {
    rememberSecretKey('A1-REMEMBERED');
    approve.mockResolvedValue({ ok: false, status: 401, error: 'Invalid credentials' });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Approve' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('Password'), 'wrong');
    await user.click(within(dialog).getByRole('button', { name: 'Approve' }));
    expect(await screen.findByText('Invalid credentials')).toBeInTheDocument();
    expect(assign).not.toHaveBeenCalled();
  });

  it('Deny needs no password and follows the vault’s URL', async () => {
    deny.mockResolvedValue({
      ok: true,
      status: 200,
      body: { redirectUrl: 'https://client.example/cb?state=xyz&error=access_denied' },
    });
    const user = userEvent.setup();
    renderPage();
    await user.click(await screen.findByRole('button', { name: 'Deny' }));
    await waitFor(() =>
      expect(assign).toHaveBeenCalledWith('https://client.example/cb?state=xyz&error=access_denied')
    );
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(approve).not.toHaveBeenCalled();
  });
});
