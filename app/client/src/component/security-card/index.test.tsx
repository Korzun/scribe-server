import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { SecurityCard } from './index';

describe('SecurityCard', () => {
  it('renders its heading and the placeholder text', () => {
    renderWithProviders(<SecurityCard />);
    expect(screen.getByText('Security')).toBeInTheDocument();
    expect(
      screen.getByText('Password and recovery codes — coming in the next step.')
    ).toBeInTheDocument();
  });
});
