import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Device } from '~/lib/dashboard';
import { renderWithProviders } from '~/test-utils';

import { DeviceList } from './index';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const NOW = 1_800_000_000_000;
const mac = (id: string, name: string, revokedAt: number | null = null): Device => ({
  id,
  name,
  createdAt: NOW - 1e9,
  lastSeenAt: null,
  revokedAt,
  isCurrent: false,
});

const setup = (devices: Device[] | undefined, failed = false) => {
  const onRevoke = vi.fn(async () => undefined);
  const onRename = vi.fn(async () => true);
  renderWithProviders(
    <DeviceList
      devices={devices}
      failed={failed}
      now={NOW}
      onRename={onRename}
      onRevoke={onRevoke}
    />
  );
  return { onRevoke, onRename };
};

describe('DeviceList', () => {
  it('shows the empty state', () => {
    setup([]);
    expect(screen.getByText('No Macs enrolled yet.')).toBeInTheDocument();
  });

  it('shows the inline error when the load failed', () => {
    setup(undefined, true);
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
  });

  it('cancelling the revoke confirmation sends nothing', async () => {
    const user = userEvent.setup();
    const { onRevoke } = setup([mac('d1', 'Work Mac')]);
    await user.click(screen.getByRole('button', { name: 'Revoke Work Mac' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(onRevoke).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirming revokes that device and closes the dialog', async () => {
    const user = userEvent.setup();
    const { onRevoke } = setup([mac('d1', 'Work Mac'), mac('d2', 'Home Mac')]);
    await user.click(screen.getByRole('button', { name: 'Revoke Home Mac' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Revoke' }));
    await waitFor(() => expect(onRevoke).toHaveBeenCalledWith('d2'));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
