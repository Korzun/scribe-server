import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { HomePage } from './index';

describe('HomePage', () => {
  it('signs out from the placeholder dashboard', async () => {
    const signOut = vi.fn(async () => undefined);
    renderWithProviders(<HomePage />, { auth: { signedIn: true, signOut } });

    await userEvent.setup().click(screen.getByRole('button', { name: 'Sign out' }));
    expect(signOut).toHaveBeenCalledTimes(1);
  });
});
