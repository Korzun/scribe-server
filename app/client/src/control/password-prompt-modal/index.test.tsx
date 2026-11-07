import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { PasswordPromptModal } from './index';

beforeAll(() => {
  HTMLDialogElement.prototype.showModal = function showModal() {
    this.setAttribute('open', '');
  };
  HTMLDialogElement.prototype.close = function close() {
    this.removeAttribute('open');
  };
});

const props = { title: 'Prompt', confirmText: 'Go', onCancel: () => undefined };

describe('PasswordPromptModal', () => {
  it('refuses mismatched new passwords inline without submitting', async () => {
    const onSubmit = vi.fn();
    const user = userEvent.setup();
    renderWithProviders(
      <PasswordPromptModal isOpen askNewPassword {...props} onSubmit={onSubmit} />
    );

    await user.type(screen.getByPlaceholderText('Current password'), 'old');
    await user.type(screen.getByPlaceholderText('New password'), 'a');
    await user.type(screen.getByPlaceholderText('Confirm new password'), 'b');
    await user.click(screen.getByRole('button', { name: 'Go' }));
    expect(screen.getByRole('alert')).toHaveTextContent("The new passwords don't match");
    expect(onSubmit).not.toHaveBeenCalled();

    await user.type(screen.getByPlaceholderText('Confirm new password'), '{Backspace}a{Enter}');
    expect(onSubmit).toHaveBeenCalledWith({ password: 'old', newPassword: 'a', secretKey: '' });
  });

  it('keeps the confirm button disabled until the fields are filled', async () => {
    const user = userEvent.setup();
    renderWithProviders(<PasswordPromptModal isOpen askSecretKey {...props} onSubmit={vi.fn()} />);

    const go = screen.getByRole('button', { name: 'Go' });
    expect(go).toHaveAttribute('aria-disabled', 'true');
    await user.type(screen.getByPlaceholderText('Password'), 'pw');
    expect(go).toHaveAttribute('aria-disabled', 'true');
    await user.type(screen.getByPlaceholderText('Secret Key'), 'A1-X');
    expect(go).not.toHaveAttribute('aria-disabled');
  });

  it('starts empty each time it opens', async () => {
    const user = userEvent.setup();
    const { rerender } = renderWithProviders(
      <PasswordPromptModal isOpen {...props} onSubmit={vi.fn()} />
    );
    await user.type(screen.getByPlaceholderText('Password'), 'secret');
    rerender(<PasswordPromptModal isOpen={false} {...props} onSubmit={vi.fn()} />);
    rerender(<PasswordPromptModal isOpen {...props} onSubmit={vi.fn()} />);
    expect(screen.getByPlaceholderText('Password')).toHaveValue('');
  });
});
