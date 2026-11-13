import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { DashboardPage } from './index';

beforeAll(() => {
  // jsdom has no modal dialog: model open/closed with the `open` attribute.
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

const library = (deletedMeetingCount = 2) => ({
  id: 'lib',
  createdAt: 1,
  recoveryCodesRemaining: 3,
  storage: {
    blobBytes: 12.3 * 1024 * 1024,
    blobCount: 41,
    meetingCount: 7,
    deletedMeetingCount,
  },
});

const NOW = Date.now();
const devices = () => [
  {
    id: 'd1',
    name: 'Work Mac',
    createdAt: NOW - 1e9,
    lastSeenAt: NOW - 3 * 3600_000,
    revokedAt: null,
    isCurrent: false,
  },
  {
    id: 'd2',
    name: 'Old Mac',
    createdAt: NOW - 2e9,
    lastSeenAt: null,
    revokedAt: NOW - 1e8,
    isCurrent: false,
  },
];

type Route = (init: RequestInit | undefined) => Response | Promise<Response>;
let routes: Record<string, Route>;
let fetchMock: ReturnType<typeof vi.fn>;

const calls = (url: string, method: string) =>
  fetchMock.mock.calls.filter(
    ([u, init]) => u === url && ((init as RequestInit | undefined)?.method ?? 'GET') === method
  );

const grants = () => [
  {
    id: 'g1',
    clientId: 'c1',
    clientName: 'Claude',
    clientUri: 'https://claude.ai',
    createdAt: NOW - 2e9,
    lastUsedAt: NOW - 3 * 3600_000,
  },
];

const jobs = () => ({
  depth: 2,
  leased: 1,
  recent: [
    {
      id: 'j1',
      meetingId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
      reason: 'new pipeline',
      requestedBy: 'session',
      status: 'done',
      attempts: 1,
      leaseDeviceId: null,
      leaseExpiresAt: null,
      createdAt: NOW - 7200_000,
      startedAt: NOW - 7000_000,
      finishedAt: NOW - 3600_000,
      outcome: 'ok',
      note: null,
    },
  ],
});

beforeEach(() => {
  routes = {
    '/api/v1/library': () => json(200, library()),
    '/api/v1/devices': () => json(200, { devices: devices() }),
    '/api/v1/mcp/grants': () => json(200, { grants: grants() }),
    '/api/v1/jobs': () => json(200, jobs()),
    '/api/v1/status': () =>
      json(200, {
        libraryExists: true,
        version: '0',
        publicUrl: 'https://vault.example',
        mcp: true,
      }),
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const route = routes[url] ?? routes[url.split('?')[0]];
    if (!route) throw new Error(`unexpected fetch ${url}`);
    return route(init);
  });
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const renderPage = (signOut = vi.fn(async () => undefined)) =>
  renderWithProviders(<DashboardPage />, { auth: { signedIn: true, signOut } });

describe('DashboardPage', () => {
  it('renders storage numbers and the device rows from the API', async () => {
    renderPage();

    expect(await screen.findByText('12.3 MB')).toBeInTheDocument();
    expect(screen.getByText('41')).toBeInTheDocument();
    expect(screen.getByText('7')).toBeInTheDocument();
    expect(screen.getByText('Work Mac')).toBeInTheDocument();
    expect(screen.getByText('Old Mac')).toBeInTheDocument();
    expect(screen.getByText(/Last seen 3 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/Revoked /)).toBeInTheDocument();
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(screen.getByText('3 remaining')).toBeInTheDocument();
  });

  it('signs out', async () => {
    const signOut = vi.fn(async () => undefined);
    renderPage(signOut);
    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });

  it('shows the empty state when no Mac is enrolled', async () => {
    routes['/api/v1/devices'] = () => json(200, { devices: [] });
    renderPage();
    expect(await screen.findByText('No Macs enrolled yet.')).toBeInTheDocument();
  });

  it('revoking asks for confirmation and calls DELETE then refetches', async () => {
    routes['/api/v1/devices/d1'] = () => new Response(null, { status: 204 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Revoke Work Mac' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        'Revoke Work Mac? That Mac can no longer reach the vault. Anything it already holds stays readable to it.'
      )
    ).toBeInTheDocument();
    expect(calls('/api/v1/devices/d1', 'DELETE')).toHaveLength(0);
    expect(calls('/api/v1/devices', 'GET')).toHaveLength(1);

    await user.click(within(dialog).getByRole('button', { name: 'Revoke' }));

    await waitFor(() => expect(calls('/api/v1/devices/d1', 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(calls('/api/v1/devices', 'GET')).toHaveLength(2));
    await waitFor(() => expect(calls('/api/v1/library', 'GET')).toHaveLength(2));
  });

  it('a revoked device cannot be renamed', async () => {
    const user = userEvent.setup();
    renderPage();

    const name = await screen.findByText('Old Mac');
    await user.click(name);

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Revoke Old Mac' })).not.toBeInTheDocument();
    expect(calls('/api/v1/devices/d2', 'PATCH')).toHaveLength(0);
  });

  it('renaming saves on Enter and sends PATCH with the trimmed name', async () => {
    routes['/api/v1/devices/d1'] = () => json(200, { id: 'd1', name: 'Desk Mac' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Work Mac'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, '  Desk Mac  {Enter}');

    await waitFor(() => expect(calls('/api/v1/devices/d1', 'PATCH')).toHaveLength(1));
    const [[, init]] = calls('/api/v1/devices/d1', 'PATCH');
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: 'Desk Mac',
    });
    await waitFor(() => expect(calls('/api/v1/devices', 'GET')).toHaveLength(2));
    await waitFor(() => expect(calls('/api/v1/library', 'GET')).toHaveLength(2));
  });

  it('Escape cancels a rename without a request', async () => {
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Work Mac'));
    await user.type(screen.getByRole('textbox'), 'x{Escape}');

    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.getByText('Work Mac')).toBeInTheDocument();
    expect(calls('/api/v1/devices/d1', 'PATCH')).toHaveLength(0);
  });

  it('Empty now is disabled when nothing awaits purge', async () => {
    routes['/api/v1/library'] = () => json(200, library(0));
    renderPage();

    const button = await screen.findByRole('button', { name: 'Empty now' });
    expect(button).toHaveAttribute('aria-disabled', 'true');
    await userEvent.setup().click(button);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('Empty now confirms, purges and refetches the library', async () => {
    routes['/api/v1/library/purge'] = () => json(200, { purgedMeetings: 2, removedFiles: 5 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Empty now' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        'Remove the files of 2 deleted meetings now? They are already gone from every Mac.'
      )
    ).toBeInTheDocument();
    await user.click(within(dialog).getByRole('button', { name: 'Empty now' }));

    await waitFor(() => expect(calls('/api/v1/library/purge', 'POST')).toHaveLength(1));
    await waitFor(() => expect(calls('/api/v1/devices', 'GET')).toHaveLength(2));
    await waitFor(() => expect(calls('/api/v1/library', 'GET')).toHaveLength(2));
  });

  it('a failed library load shows the inline error and a toast', async () => {
    routes['/api/v1/library'] = () => json(500, { error: 'boom' });
    renderPage();

    expect(await screen.findByText("Couldn't load")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load storage")).toBeInTheDocument();
    // Devices still render.
    expect(await screen.findByText('Work Mac')).toBeInTheDocument();
  });

  it('a rename that races a revoke (409) toasts, closes the input and does not resend', async () => {
    routes['/api/v1/devices/d1'] = () => json(409, { error: 'Device revoked' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Work Mac'));
    // After the failed PATCH the refetch reports the Mac as revoked.
    routes['/api/v1/devices'] = () =>
      json(200, {
        devices: [{ ...devices()[0], revokedAt: NOW }, devices()[1]],
      });
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, 'Desk Mac{Enter}');

    expect(await screen.findByText('That Mac has been revoked')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
    expect(calls('/api/v1/devices/d1', 'PATCH')).toHaveLength(1);
  });

  it('toasts when a rename, revoke or purge fails', async () => {
    routes['/api/v1/devices/d1'] = (init) =>
      init?.method === 'PATCH' ? json(500, { error: 'x' }) : json(500, { error: 'x' });
    routes['/api/v1/library/purge'] = () => json(500, { error: 'x' });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByText('Work Mac'));
    await user.type(screen.getByRole('textbox'), 'z{Enter}');
    expect(await screen.findByText("Couldn't rename the Mac")).toBeInTheDocument();
    await user.keyboard('{Escape}');

    await user.click(screen.getByRole('button', { name: 'Revoke Work Mac' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    expect(await screen.findByText("Couldn't revoke the Mac")).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Empty now' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Empty now' }));
    expect(await screen.findByText("Couldn't empty the deleted meetings")).toBeInTheDocument();
  });

  it('renders the connected assistants and the job queue from the API', async () => {
    renderPage();
    expect(await screen.findByRole('link', { name: 'Claude' })).toHaveAttribute(
      'href',
      'https://claude.ai'
    );
    expect(screen.getByText(/Last used 3 hours ago/)).toBeInTheDocument();
    expect(screen.getByText('Waiting').nextElementSibling).toHaveTextContent('2');
    expect(screen.getByText('In progress').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('0f1e2d3c…')).toBeInTheDocument();
  });

  it('disconnecting asks for confirmation and calls DELETE then refetches', async () => {
    routes['/api/v1/mcp/grants/g1'] = () => new Response(null, { status: 204 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Disconnect Claude' }));
    const dialog = screen.getByRole('dialog');
    expect(
      within(dialog).getByText(
        'Disconnect Claude? It can no longer read your meetings. Its tokens stop working now.'
      )
    ).toBeInTheDocument();
    expect(calls('/api/v1/mcp/grants/g1', 'DELETE')).toHaveLength(0);
    await user.click(within(dialog).getByRole('button', { name: 'Disconnect' }));

    await waitFor(() => expect(calls('/api/v1/mcp/grants/g1', 'DELETE')).toHaveLength(1));
    await waitFor(() => expect(calls('/api/v1/mcp/grants', 'GET')).toHaveLength(2));
  });

  it('explains an empty assistant list by whether MCP is on', async () => {
    routes['/api/v1/mcp/grants'] = () => json(200, { grants: [] });
    routes['/api/v1/status'] = () =>
      json(200, { libraryExists: true, version: '0', publicUrl: null, mcp: false });
    renderPage();
    expect(await screen.findByText('No assistants connected.')).toBeInTheDocument();
    expect(
      screen.getByText('Set PUBLIC_URL to an https origin to turn the MCP endpoint on.')
    ).toBeInTheDocument();
  });

  it('toasts when the assistants or jobs fail to load, or a disconnect fails', async () => {
    routes['/api/v1/mcp/grants'] = () => json(500, { error: 'x' });
    routes['/api/v1/jobs'] = () => json(500, { error: 'x' });
    renderPage();
    expect(await screen.findByText("Couldn't load assistants")).toBeInTheDocument();
    expect(await screen.findByText("Couldn't load jobs")).toBeInTheDocument();
    expect(screen.getAllByText("Couldn't load")).toHaveLength(2);
  });

  it('a slow earlier devices response cannot overwrite a newer one', async () => {
    let releaseFirst: (r: Response) => void = () => undefined;
    let n = 0;
    routes['/api/v1/devices'] = () => {
      n += 1;
      if (n === 1) return new Promise<Response>((resolve) => (releaseFirst = resolve));
      return json(200, { devices: [{ ...devices()[0], name: 'Fresh Mac' }] });
    };
    routes['/api/v1/library/purge'] = () => json(200, { purgedMeetings: 2, removedFiles: 5 });
    const user = userEvent.setup();
    renderPage();

    await user.click(await screen.findByRole('button', { name: 'Empty now' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Empty now' }));
    expect(await screen.findByText('Fresh Mac')).toBeInTheDocument();

    releaseFirst(json(200, { devices: devices() }));
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByText('Fresh Mac')).toBeInTheDocument();
    expect(screen.queryByText('Old Mac')).not.toBeInTheDocument();
  });
});
