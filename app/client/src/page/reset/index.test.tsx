import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { ResetPage } from './index';

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }));
vi.mock('react-router', async (orig) => ({
  ...(await orig<typeof import('react-router')>()),
  useNavigate: () => mocks.navigate,
}));

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

let fetchMock: ReturnType<typeof vi.fn>;
let answer: () => Response;
beforeEach(() => {
  answer = () => new Response(null, { status: 204 });
  fetchMock = vi.fn(async () => answer());
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  localStorage.clear();
});

const deletes = () =>
  fetchMock.mock.calls.filter(
    ([u, init]) => u === '/api/v1/library' && (init as RequestInit).method === 'DELETE'
  );

describe('ResetPage', () => {
  it('explains, verbatim, that nothing can be done without the Secret Key', () => {
    renderWithProviders(<ResetPage />);
    expect(
      screen.getByText(
        'Lost the Secret Key: nothing can be done. The vault holds only what your keys can open, and it cannot help without them. Deleting the library and starting over is the only path.'
      )
    ).toBeInTheDocument();
  });

  it('reset page requires DELETE typed and the setup code', async () => {
    localStorage.setItem('scribe:secret-key', 'A1-AAISE-M2EKV-THPCE-ZVK54-ZXPO74');
    const user = userEvent.setup();
    renderWithProviders(<ResetPage />);

    const start = screen.getByRole('button', { name: 'Delete the library' });
    expect(start).toHaveAttribute('aria-disabled', 'true');
    await user.click(start);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();

    await user.type(screen.getByPlaceholderText('Setup code'), 'setup-123');
    await user.click(screen.getByRole('button', { name: 'Delete the library' }));
    const dialog = screen.getByRole('dialog');
    const confirm = within(dialog).getByRole('button', { name: 'Delete everything' });
    expect(confirm).toHaveAttribute('aria-disabled', 'true');

    const word = within(dialog).getByPlaceholderText('DELETE');
    await user.type(word, 'delete');
    expect(confirm).toHaveAttribute('aria-disabled', 'true');
    await user.click(confirm);
    expect(deletes()).toHaveLength(0);

    await user.clear(word);
    await user.type(word, 'DELETE');
    expect(confirm).not.toHaveAttribute('aria-disabled');
    await user.click(confirm);

    await waitFor(() => expect(deletes()).toHaveLength(1));
    expect(JSON.parse(deletes()[0][1].body as string)).toEqual({
      setupCode: 'setup-123',
      confirm: 'DELETE',
    });
    await waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/login'));
    expect(await screen.findByText('Library deleted')).toBeInTheDocument();
    expect(localStorage.getItem('scribe:secret-key')).toBeNull();
  });

  it('a refused setup code toasts the server error and stays', async () => {
    answer = () =>
      new Response(JSON.stringify({ error: 'Wrong setup code' }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' },
      });
    const user = userEvent.setup();
    renderWithProviders(<ResetPage />);

    await user.type(screen.getByPlaceholderText('Setup code'), 'nope');
    await user.click(screen.getByRole('button', { name: 'Delete the library' }));
    const dialog = screen.getByRole('dialog');
    await user.type(within(dialog).getByPlaceholderText('DELETE'), 'DELETE');
    await user.click(within(dialog).getByRole('button', { name: 'Delete everything' }));

    expect(await screen.findByText('Wrong setup code')).toBeInTheDocument();
    expect(mocks.navigate).not.toHaveBeenCalled();
  });
});
