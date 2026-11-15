import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Grant } from '~/lib/dashboard';
import { renderWithProviders } from '~/test-utils';

import { AssistantsCard, MCP_OFF_HINT, MCP_ON_HINT } from './index';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const NOW = 1_800_000_000_000;
const grant = (id: string, clientName: string, lastUsedAt: number | null = null): Grant => ({
  id,
  clientId: `client-${id}`,
  clientName,
  clientUri: id === 'g1' ? 'https://claude.ai' : null,
  createdAt: NOW - 1e9,
  lastUsedAt,
});

const setup = (
  grants: Grant[] | undefined,
  options: { failed?: boolean; mcpEnabled?: boolean } = {}
) => {
  const onDisconnect = vi.fn(async () => undefined);
  renderWithProviders(
    <AssistantsCard
      grants={grants}
      failed={options.failed}
      mcpEnabled={options.mcpEnabled}
      now={NOW}
      onDisconnect={onDisconnect}
    />
  );
  return { onDisconnect };
};

describe('AssistantsCard', () => {
  it('shows the empty state, with the hint that fits the vault', () => {
    setup([], { mcpEnabled: false });
    expect(screen.getByText('No assistants connected.')).toBeInTheDocument();
    expect(screen.getByText(MCP_OFF_HINT)).toBeInTheDocument();
  });

  it('tells an enabled vault how to connect one', () => {
    setup([], { mcpEnabled: true });
    expect(screen.getByText(MCP_ON_HINT)).toBeInTheDocument();
  });

  it('shows the inline error when the load failed', () => {
    setup(undefined, { failed: true });
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
  });

  it('lists each assistant with its link and when it was last used', () => {
    setup([grant('g1', 'Claude', NOW - 3 * 3600_000), grant('g2', 'Other')]);
    expect(screen.getByRole('link', { name: 'Claude' })).toHaveAttribute(
      'href',
      'https://claude.ai'
    );
    expect(screen.getByText(/Last used 3 hours ago/)).toBeInTheDocument();
    expect(screen.getByText(/Last used never/)).toBeInTheDocument();
  });

  it('cancelling the disconnect confirmation sends nothing', async () => {
    const user = userEvent.setup();
    const { onDisconnect } = setup([grant('g1', 'Claude')]);
    await user.click(screen.getByRole('button', { name: 'Disconnect Claude' }));
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Disconnect Claude? It can no longer read your meetings. Its tokens stop working now.'
      )
    ).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(onDisconnect).not.toHaveBeenCalled();
  });

  it('confirming disconnects that assistant and closes the dialog', async () => {
    const user = userEvent.setup();
    const { onDisconnect } = setup([grant('g1', 'Claude'), grant('g2', 'Other')]);
    await user.click(screen.getByRole('button', { name: 'Disconnect Other' }));
    await user.click(
      within(screen.getByRole('dialog')).getByRole('button', { name: 'Disconnect' })
    );
    await waitFor(() => expect(onDisconnect).toHaveBeenCalledWith('g2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
