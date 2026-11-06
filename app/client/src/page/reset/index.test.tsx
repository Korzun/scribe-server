import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { ResetPage } from './index';

describe('ResetPage', () => {
  it('is a placeholder until Task 13', () => {
    renderWithProviders(<ResetPage />);
    expect(screen.getByText('Coming in Task 13')).toBeInTheDocument();
  });
});
