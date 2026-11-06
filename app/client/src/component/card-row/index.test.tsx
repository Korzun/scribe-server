import { fireEvent, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { CardRow } from './index';

describe('CardRow', () => {
  it('calls onClick on click, Enter and Space', () => {
    const onClick = vi.fn();
    renderWithProviders(<CardRow onClick={onClick}>row</CardRow>);
    const row = screen.getByText('row');
    fireEvent.click(row);
    fireEvent.keyDown(row, { key: 'Enter' });
    fireEvent.keyDown(row, { key: ' ' });
    fireEvent.keyDown(row, { key: 'a' });
    expect(onClick).toHaveBeenCalledTimes(3);
  });

  it('renders its children without a handler', () => {
    renderWithProviders(<CardRow>plain</CardRow>);
    expect(screen.getByText('plain')).toBeInTheDocument();
  });
});
