import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { RecoverPage } from './index';

describe('RecoverPage', () => {
  it('is a placeholder until Task 13', () => {
    renderWithProviders(<RecoverPage />);
    expect(screen.getByText('Coming in Task 13')).toBeInTheDocument();
  });
});
