import { act, render, screen, waitFor } from '@testing-library/react';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { makeJwt } from '~/lib/test-jwt';
import { getToken, setToken } from '~/lib/token';

import { useAuth } from './hook';
import { AuthProvider } from './provider';

const ownerToken = () => makeJwt({ owner: true, iat: 1, exp: Math.floor(Date.now() / 1000) + 900 });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

// The latest context value, for the test to call signIn/signOut on.
const latest: { auth?: ReturnType<typeof useAuth> } = {};
const Probe = () => {
  const value = useAuth();
  useEffect(() => {
    latest.auth = value;
  });
  return <div data-testid="state">{value.loading ? 'loading' : value.signedIn ? 'in' : 'out'}</div>;
};
const auth = () => latest.auth!;
const renderProbe = () =>
  render(
    <AuthProvider>
      <Probe />
    </AuthProvider>
  );
const state = () => screen.getByTestId('state').textContent;

describe('AuthProvider', () => {
  it('is signed in at once with a valid stored token, and makes no request', () => {
    setToken(ownerToken());
    renderProbe();
    expect(state()).toBe('in');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('with no token, tries one silent refresh through the cookie and adopts its token', async () => {
    const fresh = ownerToken();
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ accessToken: fresh }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      })
    );
    renderProbe();
    expect(state()).toBe('loading');
    await waitFor(() => expect(state()).toBe('in'));
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/v1/session/refresh',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    );
    expect(getToken()).toBe(fresh);
  });

  it('with no token and a refused refresh, settles signed out', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    renderProbe();
    await waitFor(() => expect(state()).toBe('out'));
  });

  it('signIn stores the token and signs in; signOut logs out server-side and clears it', async () => {
    fetchMock.mockResolvedValueOnce(new Response(null, { status: 401 }));
    renderProbe();
    await waitFor(() => expect(state()).toBe('out'));

    const token = ownerToken();
    act(() => auth().signIn(token));
    expect(state()).toBe('in');
    expect(getToken()).toBe(token);

    fetchMock.mockResolvedValueOnce(new Response(null, { status: 204 }));
    await act(() => auth().signOut());
    expect(state()).toBe('out');
    expect(getToken()).toBeNull();
    expect(fetchMock).toHaveBeenLastCalledWith(
      '/api/v1/session/logout',
      expect.objectContaining({ method: 'POST', credentials: 'same-origin' })
    );
  });

  it('signOut still signs out locally when the logout request fails', async () => {
    setToken(ownerToken());
    renderProbe();
    fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
    await act(() => auth().signOut());
    expect(state()).toBe('out');
    expect(getToken()).toBeNull();
  });
});
