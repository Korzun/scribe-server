import { afterEach, describe, expect, it, vi } from 'vitest';

import { makeJwt } from './test-jwt';
import {
  TOKEN_CHANGED_EVENT,
  clearToken,
  currentIdentity,
  decodeClaims,
  extractAccessToken,
  getToken,
  isExpired,
  setToken,
} from './token';

afterEach(() => {
  localStorage.clear();
});

describe('get/set/clearToken', () => {
  it('round-trips through localStorage', () => {
    expect(getToken()).toBeNull();
    setToken('abc');
    expect(getToken()).toBe('abc');
    clearToken();
    expect(getToken()).toBeNull();
  });

  it('dispatches a change event on set and clear', () => {
    const listener = vi.fn();
    window.addEventListener(TOKEN_CHANGED_EVENT, listener);
    setToken('abc');
    clearToken();
    window.removeEventListener(TOKEN_CHANGED_EVENT, listener);
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('decodeClaims', () => {
  it('decodes the owner token the vault mints', () => {
    expect(decodeClaims(makeJwt({ owner: true, iat: 1760000000, exp: 1760000900 }))).toEqual({
      owner: true,
      exp: 1760000900,
    });
  });

  it('returns null for malformed input', () => {
    expect(decodeClaims('')).toBeNull();
    expect(decodeClaims('one.two')).toBeNull();
    expect(decodeClaims('a.%%%.c')).toBeNull();
    expect(decodeClaims(`x.${btoa('"not an object"')}.y`)).toBeNull();
    expect(decodeClaims(makeJwt({ owner: true }))).toBeNull(); // no exp
  });

  it('returns null for a token that is not the owner (a device token)', () => {
    expect(decodeClaims(makeJwt({ exp: 1760000900 }))).toBeNull();
    expect(decodeClaims(makeJwt({ owner: 'yes', exp: 1760000900 }))).toBeNull();
    expect(decodeClaims(makeJwt({ deviceId: 'd1', exp: 1760000900 }))).toBeNull();
  });
});

describe('extractAccessToken', () => {
  it('returns the string for a well-shaped body', () => {
    expect(extractAccessToken({ accessToken: 'a.b.c' })).toBe('a.b.c');
  });

  it('returns null for malformed bodies', () => {
    expect(extractAccessToken({})).toBeNull();
    expect(extractAccessToken(null)).toBeNull();
    expect(extractAccessToken('x')).toBeNull();
    expect(extractAccessToken({ accessToken: 42 })).toBeNull();
    expect(extractAccessToken({ accessToken: '' })).toBeNull();
  });
});

describe('isExpired', () => {
  it('is false before exp and true after', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(isExpired({ owner: true, exp: now + 60 })).toBe(false);
    expect(isExpired({ owner: true, exp: now - 60 })).toBe(true);
  });
});

describe('currentIdentity', () => {
  it('is null when logged out or the token is malformed', () => {
    expect(currentIdentity()).toBeNull();
    setToken('not-a-jwt');
    expect(currentIdentity()).toBeNull();
  });

  it('is the owner when an owner token is stored', () => {
    setToken(makeJwt({ owner: true, exp: 9999999999 }));
    expect(currentIdentity()).toBe('owner');
  });
});
