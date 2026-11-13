import { screen } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { UnprotectedRoute } from './unprotected-route';

const Probe = () => {
  const location = useLocation();
  return <div>devices page {location.search}</div>;
};

const renderAt = (
  signedIn: boolean,
  initialEntry: string | { pathname: string; state?: unknown },
  loading = false
) =>
  renderWithProviders(
    <Routes>
      <Route element={<UnprotectedRoute />}>
        <Route path="/login" element={<div>login page</div>} />
      </Route>
      <Route path="/" element={<div>home page</div>} />
      <Route path="/devices" element={<Probe />} />
    </Routes>,
    { auth: { signedIn, loading }, initialEntries: [initialEntry as string] }
  );

describe('UnprotectedRoute', () => {
  it('renders the route when signed out', () => {
    renderAt(false, '/login');
    expect(screen.getByText('login page')).toBeInTheDocument();
  });

  it('shows the loading page while the silent refresh is in flight', () => {
    renderAt(false, '/login', true);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('redirects home when signed in with no prior destination', () => {
    renderAt(true, '/login');
    expect(screen.getByText('home page')).toBeInTheDocument();
  });

  it('redirects to the prior destination, query string included', () => {
    renderAt(true, {
      pathname: '/login',
      state: { from: { pathname: '/devices', search: '?x=1' } },
    });
    expect(screen.getByText('devices page ?x=1')).toBeInTheDocument();
  });
});
