import { screen } from '@testing-library/react';
import { Routes, Route, useLocation } from 'react-router';
import { describe, expect, it } from 'vitest';

import { renderWithProviders } from '~/test-utils';

import { ProtectedRoute } from './protected-route';

const LoginProbe = () => {
  const location = useLocation();
  const from = (location.state as { from?: { pathname: string } } | null)?.from;
  return <div>login page from {from?.pathname}</div>;
};

const renderAt = (signedIn: boolean, loading = false) =>
  renderWithProviders(
    <Routes>
      <Route element={<ProtectedRoute />}>
        <Route path="/" element={<div>dashboard</div>} />
      </Route>
      <Route path="/login" element={<LoginProbe />} />
    </Routes>,
    { auth: { signedIn, loading }, initialEntries: ['/'] }
  );

describe('ProtectedRoute', () => {
  it('renders the route when signed in', () => {
    renderAt(true);
    expect(screen.getByText('dashboard')).toBeInTheDocument();
  });

  it('shows the loading page while signed out and the silent refresh is in flight', () => {
    renderAt(false, true);
    expect(screen.getByRole('status', { name: 'Loading' })).toBeInTheDocument();
  });

  it('redirects to /login when signed out, remembering where it came from', () => {
    renderAt(false);
    expect(screen.getByText('login page from /')).toBeInTheDocument();
  });
});
