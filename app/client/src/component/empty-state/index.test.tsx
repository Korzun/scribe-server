import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { EmptyState } from './index';

describe('EmptyState', () => {
  it('renders the title and, when given, the second line', () => {
    renderWithProviders(<EmptyState title="No devices">Pair one from Scribe.</EmptyState>);
    expect(screen.getByText('No devices')).toBeInTheDocument();
    expect(screen.getByText('Pair one from Scribe.')).toBeInTheDocument();
  });

  it('renders the title alone when there is no second line', () => {
    const { container } = renderWithProviders(<EmptyState title="Nothing here" />);
    expect(container.firstElementChild?.childElementCount).toBe(1);
  });
});
