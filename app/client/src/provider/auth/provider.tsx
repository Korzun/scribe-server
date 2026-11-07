import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { api, refreshAccessToken } from '../../lib/api';
import {
  TOKEN_CHANGED_EVENT,
  TOKEN_KEY,
  clearToken,
  decodeClaims,
  getToken,
  isExpired,
  setToken,
} from '../../lib/token';
import { Context, type AuthContext } from './context';

const hasValidToken = (token: string | null): boolean => {
  if (!token) return false;
  const claims = decodeClaims(token);
  return claims !== null && !isExpired(claims);
};

export type AuthProviderProps = { children: ReactNode };
export const AuthProvider = ({ children }: AuthProviderProps) => {
  const [token, setTokenState] = useState<string | null>(() => getToken());
  // Loading is only meaningful for the mount-time silent refresh: if a valid
  // token is already present at mount there is nothing to wait for, so start
  // false. Otherwise stay true until the bootstrap refresh attempt resolves.
  const [loading, setLoading] = useState(!hasValidToken(token));

  // Keep state in sync with localStorage writes from lib/token (sign-in,
  // sign-out, api refreshes). TOKEN_CHANGED_EVENT covers writes from this tab;
  // the native storage event covers writes from other tabs, so a tab that
  // didn't perform a refresh still adopts the freshly-stored token (and reacts
  // to a sign-out in a sibling tab).
  useEffect(() => {
    const onChange = () => setTokenState(getToken());
    const onStorage = (e: StorageEvent) => {
      // key === null fires on localStorage.clear(); TOKEN_KEY on set/remove.
      if (e.key === null || e.key === TOKEN_KEY) onChange();
    };
    window.addEventListener(TOKEN_CHANGED_EVENT, onChange);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(TOKEN_CHANGED_EVENT, onChange);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  const claims = useMemo(() => (token ? decodeClaims(token) : null), [token]);
  const valid = claims !== null && !isExpired(claims);

  // With no valid token, silently try one refresh — the httpOnly refresh
  // cookie may still be good (keeps the owner signed in across reloads). Runs
  // once per loss of the token via the ref guard; setLoading only fires in the
  // async .finally, never synchronously in the effect body.
  const bootstrapped = useRef(false);
  // Latched by signOut and cleared once a session exists again. Its
  // server-side cookie clear may have failed, in which case the refresh
  // cookie is still live and the refresh below would silently sign the owner
  // back in on the /login page they were just sent to. A ref rather than a
  // one-shot read, so <StrictMode>'s setup -> cleanup -> setup double-invoke
  // asks the same question twice and gets the same answer.
  const signedOut = useRef(false);
  useEffect(() => {
    if (valid) {
      signedOut.current = false;
      return;
    }
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    if (signedOut.current) {
      setLoading(false);
      return () => {
        bootstrapped.current = false;
      };
    }

    let cancelled = false;
    void refreshAccessToken().finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => {
      cancelled = true;
      bootstrapped.current = false;
    };
  }, [valid]);

  // Proactive refresh one minute before expiry; each new token re-arms it.
  useEffect(() => {
    if (!valid || !claims) return;
    const delay = Math.max(claims.exp * 1000 - Date.now() - 60_000, 0);
    const timer = setTimeout(() => {
      if (isExpired(claims)) {
        // Woke past expiry (tab sleep): mask the expired window as loading so
        // route guards don't bounce to /login while the refresh is in flight.
        setLoading(true);
      }
      void refreshAccessToken().finally(() => setLoading(false));
    }, delay);
    return () => clearTimeout(timer);
  }, [claims, valid]);

  const signIn = useCallback((accessToken: string) => setToken(accessToken), []);

  // Best effort: a failed server-side cookie clear must not strand the owner
  // in a session they asked to end; the `signedOut` latch covers the cookie.
  const signOut = useCallback(async () => {
    signedOut.current = true;
    await api('/api/v1/session/logout', { method: 'POST' });
    clearToken();
  }, []);

  const state = useMemo<AuthContext>(
    () => ({ signedIn: valid, loading, signIn, signOut }),
    [valid, loading, signIn, signOut]
  );

  return <Context.Provider value={state}>{children}</Context.Provider>;
};
