import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import type { Device } from '~/lib/dashboard';
import { renderWithProviders } from '~/test-utils';

import { DeviceRow } from './index';

const NOW = 1_800_000_000_000;
const device = (over: Partial<Device> = {}): Device => ({
  id: 'd1',
  name: 'Work Mac',
  createdAt: NOW - 1e9,
  lastSeenAt: NOW - 5 * 60_000,
  revokedAt: null,
  isCurrent: false,
  ...over,
});

const setup = (over: Partial<Device> = {}, onRename = vi.fn(async () => true)) => {
  const onRevoke = vi.fn();
  const view = renderWithProviders(
    <DeviceRow device={device(over)} now={NOW} onRename={onRename} onRevoke={onRevoke} />
  );
  return { onRename, onRevoke, ...view };
};

describe('DeviceRow', () => {
  it('shows the name, enrolled date and relative last seen', () => {
    setup();
    expect(screen.getByText('Work Mac')).toBeInTheDocument();
    expect(screen.getByText(/Last seen 5 minutes ago/)).toBeInTheDocument();
  });

  it('an empty or whitespace name closes the input without renaming', async () => {
    const user = userEvent.setup();
    const { onRename } = setup();
    await user.click(screen.getByText('Work Mac'));
    const input = screen.getByRole('textbox');
    await user.clear(input);
    await user.type(input, '   {Enter}');
    expect(onRename).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('an unchanged name is not sent', async () => {
    const user = userEvent.setup();
    const { onRename } = setup();
    await user.click(screen.getByText('Work Mac'));
    await user.type(screen.getByRole('textbox'), '{Enter}');
    expect(onRename).not.toHaveBeenCalled();
  });

  it('keeps the input open when the rename fails', async () => {
    const user = userEvent.setup();
    const { onRename } = setup(
      {},
      vi.fn(async () => false)
    );
    await user.click(screen.getByText('Work Mac'));
    await user.type(screen.getByRole('textbox'), 'x{Enter}');
    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('textbox')).toBeInTheDocument();
  });

  it('a second Enter during a pending save sends nothing more', async () => {
    const user = userEvent.setup();
    let finish: (ok: boolean) => void = () => undefined;
    const onRename = vi.fn(() => new Promise<boolean>((resolve) => (finish = resolve)));
    setup({}, onRename);
    await user.click(screen.getByText('Work Mac'));
    await user.type(screen.getByRole('textbox'), 'x{Enter}{Enter}');
    expect(onRename).toHaveBeenCalledTimes(1);
    finish(true);
    await waitFor(() => expect(screen.queryByRole('textbox')).not.toBeInTheDocument());
  });

  it('a revoked row has no rename or Revoke affordance', async () => {
    const user = userEvent.setup();
    const { onRename, onRevoke } = setup({ revokedAt: NOW - 1000 });
    await user.click(screen.getByText('Work Mac'));
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Revoke/ })).not.toBeInTheDocument();
    expect(screen.getByText(/Revoked /)).toBeInTheDocument();
    expect(onRename).not.toHaveBeenCalled();
    expect(onRevoke).not.toHaveBeenCalled();
  });

  it('Revoke hands the device to onRevoke', async () => {
    const user = userEvent.setup();
    const { onRevoke } = setup();
    await user.click(screen.getByRole('button', { name: 'Revoke Work Mac' }));
    expect(onRevoke).toHaveBeenCalledWith(expect.objectContaining({ id: 'd1' }));
  });
});
