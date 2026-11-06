import {
  clearToken,
  decodeClaims,
  extractAccessToken,
  getToken,
  isExpired,
  setToken,
} from './token';

/**
 * The client's one door to the vault's JSON API. Plain TypeScript, no React,
 * so library code (`lib/account.ts` and friends) can be tested without
 * rendering anything.
 */

export type ApiResult<T> =
  | { ok: true; status: number; body: T }
  | {
      ok: false;
      /** The HTTP status, or 0 when the request never got an answer (network failure). */
      status: number;
      error: string;
      /** Only on a 429 with a usable `Retry-After` header. */
      retryAfterSeconds?: number;
    };

const SESSION_PATH = '/api/v1/session';
const REFRESH_PATH = `${SESSION_PATH}/refresh`;
const REFRESH_LOCK = 'scribe:auth-refresh';

let refreshInFlight: Promise<boolean> | null = null;

const isUsableToken = (token: string | null): token is string => {
  if (!token) return false;
  const claims = decodeClaims(token);
  return claims !== null && !isExpired(claims);
};

/**
 * Runs `fn` while holding a browser-wide lock so at most one tab refreshes at
 * a time. Falls back to running directly where the Web Locks API is missing
 * (older browsers, insecure contexts) — degrading to per-tab behaviour rather
 * than failing.
 */
const withRefreshLock = async <T>(fn: () => Promise<T>): Promise<T> => {
  if (typeof navigator === 'undefined' || !navigator.locks) return fn();
  return navigator.locks.request(REFRESH_LOCK, fn);
};

/**
 * The actual network refresh. Assumes the caller holds the refresh lock. An
 * explicit rejection (401/403) clears the stored access token (signs out);
 * transient failures (network errors, 5xx) leave it in place, since the
 * proactive timer calls this while the current token is still valid and a
 * brief outage must not sign the owner out.
 */
const performRefresh = async (): Promise<boolean> => {
  try {
    const response = await fetch(REFRESH_PATH, { method: 'POST', credentials: 'same-origin' });
    if (response.status === 401 || response.status === 403) {
      clearToken();
      return false;
    }
    if (!response.ok) return false;
    const accessToken = extractAccessToken(await response.json());
    if (!accessToken) return false;
    setToken(accessToken);
    return true;
  } catch {
    return false;
  }
};

/**
 * Calls POST /api/v1/session/refresh (the refresh token rides the httpOnly
 * cookie scoped to /api/v1/session).
 *
 * Coordinated two ways so concurrent callers never double-spend the rotating
 * refresh token:
 *  - within a tab, single-flight: concurrent callers share one promise;
 *  - across tabs, a Web Lock serializes refreshes browser-wide. Whichever tab
 *    runs second finds the token a sibling just stored and adopts it, instead
 *    of presenting its now rotated-out refresh token.
 */
export const refreshAccessToken = (): Promise<boolean> => {
  refreshInFlight ??= (async () => {
    const tokenBefore = getToken();
    try {
      return await withRefreshLock(async () => {
        const current = getToken();
        if (current !== tokenBefore && isUsableToken(current)) return true;
        return performRefresh();
      });
    } finally {
      refreshInFlight = null;
    }
  })();
  return refreshInFlight;
};

const send = (path: string, init: RequestInit | undefined, token: string | null) => {
  const headers = new Headers(init?.headers);
  if (token) headers.set('Authorization', `Bearer ${token}`);
  if (typeof init?.body === 'string' && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }
  // same-origin, always: the refresh cookie must travel with session calls.
  return fetch(path, { ...init, headers, credentials: 'same-origin' });
};

const toResult = async <T>(response: Response): Promise<ApiResult<T>> => {
  const isJson = (response.headers.get('Content-Type') ?? '').includes('application/json');
  let body: unknown;
  try {
    body = isJson ? await response.json() : undefined;
  } catch {
    body = undefined;
  }
  if (response.ok) return { ok: true, status: response.status, body: body as T };
  const message =
    typeof body === 'object' &&
    body !== null &&
    typeof (body as { error?: unknown }).error === 'string'
      ? (body as { error: string }).error
      : `HTTP ${response.status}`;
  const result: Extract<ApiResult<T>, { ok: false }> = {
    ok: false,
    status: response.status,
    error: message,
  };
  if (response.status === 429) {
    const retryAfter = Number(response.headers.get('Retry-After'));
    if (Number.isFinite(retryAfter) && retryAfter > 0) result.retryAfterSeconds = retryAfter;
  }
  return result;
};

/**
 * `fetch` for the vault API: attaches the stored bearer, decodes JSON, and
 * folds every outcome into an `ApiResult` (a network failure is status 0).
 *
 * A 401 on a request that carried a token gets exactly one
 * `POST /api/v1/session/refresh` and one retry; a 401 on the retry clears the
 * token, which signs the owner out (AuthProvider and the route guards follow
 * the token). A 401 with no token attached, or from the session routes
 * themselves (wrong credentials on sign-in, even with a stale token still
 * stored), is returned as is.
 */
export async function api<T>(path: string, init?: RequestInit): Promise<ApiResult<T>> {
  try {
    const token = getToken();
    const response = await send(path, init, token);
    if (response.status !== 401 || token === null || path.startsWith(SESSION_PATH)) {
      return await toResult<T>(response);
    }

    if (!(await refreshAccessToken())) return await toResult<T>(response);
    const retried = await send(path, init, getToken());
    if (retried.status === 401) clearToken();
    return await toResult<T>(retried);
  } catch {
    return { ok: false, status: 0, error: 'Network error' };
  }
}
