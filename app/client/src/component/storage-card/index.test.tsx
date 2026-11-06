import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import type { Storage } from '~/lib/dashboard';
import { renderWithProviders } from '~/test-utils';

import { StorageCard } from './index';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const storage = (deletedMeetingCount: number): Storage => ({
  blobBytes: 1536,
  blobCount: 4,
  meetingCount: 3,
  deletedMeetingCount,
});

describe('StorageCard', () => {
  it('humanises the bytes and shows the counts', () => {
    renderWithProviders(<StorageCard storage={storage(1)} onPurge={async () => undefined} />);
    expect(screen.getByText('1.5 KB')).toBeInTheDocument();
    expect(screen.getByText('4')).toBeInTheDocument();
    expect(screen.getByText('3')).toBeInTheDocument();
  });

  it('shows the inline error when the load failed', () => {
    renderWithProviders(<StorageCard failed onPurge={async () => undefined} />);
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
  });

  it('cancelling the confirmation does not purge', async () => {
    const user = userEvent.setup();
    const onPurge = vi.fn(async () => undefined);
    renderWithProviders(<StorageCard storage={storage(2)} onPurge={onPurge} />);
    await user.click(screen.getByRole('button', { name: 'Empty now' }));
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Cancel' }));
    expect(onPurge).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('confirming purges once and closes the dialog', async () => {
    const user = userEvent.setup();
    const onPurge = vi.fn(async () => undefined);
    renderWithProviders(<StorageCard storage={storage(1)} onPurge={onPurge} />);
    await user.click(screen.getByRole('button', { name: 'Empty now' }));
    expect(
      within(screen.getByRole('dialog')).getByText(
        'Remove the files of 1 deleted meeting now? They are already gone from every Mac.'
      )
    ).toBeInTheDocument();
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Empty now' }));
    await waitFor(() => expect(onPurge).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
