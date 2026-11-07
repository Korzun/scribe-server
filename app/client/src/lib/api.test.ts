import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { api } from './api';
import { makeJwt } from './test-jwt';
import { getToken, setToken } from './token';

const future = () => Math.floor(Date.now() / 1000) + 900;
const tokenA = makeJwt({ owner: true, iat: 1, exp: future() });
const tokenB = makeJwt({ owner: true, iat: 2, exp: future() });

const json = (status: number, body: unknown, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...headers },
  });

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
});

const call = (n: number) => {
  const [url, init] = fetchMock.mock.calls[n] as [string, RequestInit];
  return {
    url,
    method: init.method ?? 'GET',
    credentials: init.credentials,
    authorization: new Headers(init.headers).get('Authorization'),
  };
};

describe('api', () => {
  it('attaches the bearer and returns the JSON body', async () => {
    setToken(tokenA);
    fetchMock.mockResolvedValueOnce(json(200, { devices: [] }));

    const result = await api<{ devices: unknown[] }>('/api/v1/devices');

    expect(result).toEqual({ ok: true, status: 200, body: { devices: [] } });
    expect(call(0)).toEqual({
      url: '/api/v1/devices',
      method: 'GET',
      credentials: 'same-origin',
      authorization: `Bearer ${tokenA}`,
    });
  });

  it('a 401 triggers one refresh and a retry, a second 401 signs out', async () => {
    setToken(tokenA);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(json(200, { accessToken: tokenB }))
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    const result = await api('/api/v1/devices');

    expect(result).toEqual({ ok: false, status: 401, error: 'Unauthorized' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(call(1)).toMatchObject({
      url: '/api/v1/session/refresh',
      method: 'POST',
      credentials: 'same-origin',
    });
    expect(call(2)).toMatchObject({ url: '/api/v1/devices', authorization: `Bearer ${tokenB}` });
    expect(getToken()).toBeNull();
  });

  it('a 401 then a good refresh retries and succeeds, keeping the new token', async () => {
    setToken(tokenA);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(json(200, { accessToken: tokenB }))
      .mockResolvedValueOnce(json(200, { ok: 1 }));

    expect(await api('/api/v1/devices')).toEqual({ ok: true, status: 200, body: { ok: 1 } });
    expect(getToken()).toBe(tokenB);
  });

  it('a rejected refresh signs out without retrying', async () => {
    setToken(tokenA);
    fetchMock
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }))
      .mockResolvedValueOnce(json(401, { error: 'Unauthorized' }));

    expect(await api('/api/v1/devices')).toMatchObject({ ok: false, status: 401 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(getToken()).toBeNull();
  });

  it('a 401 while signed out is passed through without a refresh (wrong credentials)', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Invalid credentials' }));

    const result = await api('/api/v1/session', { method: 'POST', body: '{}' });

    expect(result).toEqual({ ok: false, status: 401, error: 'Invalid credentials' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(call(0).authorization).toBeNull();
  });

  it('a 401 from the session routes is never refreshed, even with a stale token stored', async () => {
    setToken(tokenA);
    fetchMock.mockResolvedValueOnce(json(401, { error: 'Invalid credentials' }));

    expect(await api('/api/v1/session', { method: 'POST', body: '{}' })).toMatchObject({
      ok: false,
      status: 401,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('reports Retry-After on a 429, a network failure as status 0, and a 204 as no body', async () => {
    fetchMock
      .mockResolvedValueOnce(json(429, { error: 'Too many attempts' }, { 'Retry-After': '42' }))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));

    expect(await api('/api/v1/session', { method: 'POST' })).toEqual({
      ok: false,
      status: 429,
      error: 'Too many attempts',
      retryAfterSeconds: 42,
    });
    expect(await api('/api/v1/status')).toEqual({ ok: false, status: 0, error: 'Network error' });
    expect(await api('/api/v1/session/logout', { method: 'POST' })).toEqual({
      ok: true,
      status: 204,
      body: undefined,
    });
  });
});
