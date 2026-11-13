import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Job } from '~/lib/dashboard';
import { renderWithProviders } from '~/test-utils';

import { JobsCard } from './index';

const NOW = 1_800_000_000_000;
const job = (id: string, outcome: string, finishedAt: number): Job => ({
  id,
  meetingId: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
  reason: 'new pipeline',
  requestedBy: 'session',
  status: outcome === 'ok' ? 'done' : 'failed',
  attempts: 1,
  leaseDeviceId: null,
  leaseExpiresAt: null,
  createdAt: finishedAt - 60_000,
  startedAt: finishedAt - 30_000,
  finishedAt,
  outcome,
  note: null,
});

describe('JobsCard', () => {
  it('shows loading and failure states', () => {
    const { unmount } = renderWithProviders(<JobsCard now={NOW} />);
    expect(screen.getByText('Loading…')).toBeInTheDocument();
    unmount();
    renderWithProviders(<JobsCard now={NOW} failed />);
    expect(screen.getByText("Couldn't load")).toBeInTheDocument();
  });

  it('shows the depth, the live leases, and the last few outcomes', () => {
    renderWithProviders(
      <JobsCard
        now={NOW}
        jobs={{
          depth: 3,
          leased: 1,
          recent: [
            job('j1', 'ok', NOW - 3600_000),
            job('j2', 'failed', NOW - 2 * 3600_000),
            job('j3', 'lapsed', NOW - 86_400_000),
          ],
        }}
      />
    );
    expect(screen.getByText('Waiting').nextElementSibling).toHaveTextContent('3');
    expect(screen.getByText('In progress').nextElementSibling).toHaveTextContent('1');
    expect(screen.getByText('Done')).toBeInTheDocument();
    expect(screen.getByText('Failed')).toBeInTheDocument();
    expect(screen.getByText('Gave up')).toBeInTheDocument();
    expect(screen.getByText('1 hour ago')).toBeInTheDocument();
    expect(screen.getAllByText('0f1e2d3c…')).toHaveLength(3);
    expect(screen.getAllByTitle('0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0')).toHaveLength(3);
  });

  it('says so when nothing has finished yet', () => {
    renderWithProviders(<JobsCard now={NOW} jobs={{ depth: 0, leased: 0, recent: [] }} />);
    expect(screen.getByText('No jobs finished yet.')).toBeInTheDocument();
  });
});
