import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { LoadingPage } from './index';

describe('LoadingPage', () => {
  it('shows an accessible spinner', () => {
    renderWithProviders(<LoadingPage />);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });
});
