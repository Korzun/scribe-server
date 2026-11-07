import { fireEvent, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { CodesSheet } from './index';

const CODES = Array.from({ length: 10 }, (_, i) => `CODE-${i}AAA-BBBB-CCCC`);

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

describe('CodesSheet', () => {
  it('renders the ten codes and the warning', () => {
    renderWithProviders(<CodesSheet isOpen codes={CODES} onDone={vi.fn()} />);
    expect(screen.getAllByRole('listitem').map((li) => li.textContent)).toEqual(CODES);
    expect(
      screen.getByText('Your old codes no longer work. Each code needs your Secret Key.')
    ).toBeInTheDocument();
  });

  it('cannot be dismissed by Escape; only the saved button closes it', async () => {
    const onDone = vi.fn();
    renderWithProviders(<CodesSheet isOpen codes={CODES} onDone={onDone} />);
    fireEvent(screen.getByRole('dialog'), new Event('cancel', { cancelable: true }));
    expect(onDone).not.toHaveBeenCalled();

    await userEvent.setup().click(screen.getByRole('button', { name: "I've saved them" }));
    expect(onDone).toHaveBeenCalledOnce();
  });

  it('toasts when the clipboard refuses', async () => {
    const user = userEvent.setup();
    vi.spyOn(navigator.clipboard, 'writeText').mockRejectedValue(new Error('denied'));
    renderWithProviders(<CodesSheet isOpen codes={CODES} onDone={vi.fn()} />);

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(
      await screen.findByText("Couldn't copy — select the codes and copy them by hand")
    ).toBeInTheDocument();
  });
});
