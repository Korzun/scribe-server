import type { Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';

import { createIpRateLimit } from './rate-limit';

vi.mock('../logger');

// Ported from Bookplate's `createIpRateLimit` unit tests (routes/ui.test.ts).
describe('createIpRateLimit (unit-level, direct calls with a fake clock)', () => {
  const options = { max: 10, windowMs: 60_000, trustProxyHops: 0 };

  function mockRes(): {
    res: Response;
    state: { status?: number; headers: Record<string, string>; body?: unknown };
  } {
    const state: { status?: number; headers: Record<string, string>; body?: unknown } = {
      headers: {},
    };
    const res = {
      status(code: number) {
        state.status = code;
        return res;
      },
      set(name: string, value: string) {
        state.headers[name] = value;
        return res;
      },
      json(payload: unknown) {
        state.body = payload;
        return res;
      },
    } as unknown as Response;
    return { res, state };
  }

  // The limiter reads `req.socket.remoteAddress` and `req.headers['x-forwarded-for']`
  // directly — never Express's own `req.ip` — so the fake request needs both.
  function fakeReq(remoteAddress: string, forwardedFor?: string): Request {
    return {
      socket: { remoteAddress },
      headers: forwardedFor !== undefined ? { 'x-forwarded-for': forwardedFor } : {},
    } as unknown as Request;
  }

  it('allows the first 10 attempts for one IP, denies the 11th with 429 + Retry-After', () => {
    const limiter = createIpRateLimit({ ...options, now: () => 1_000 });
    for (let i = 0; i < 10; i++) {
      const next = vi.fn();
      const { res, state } = mockRes();
      limiter(fakeReq('1.2.3.4'), res, next);
      expect(next).toHaveBeenCalledTimes(1);
      expect(state.status).toBeUndefined();
    }

    const next = vi.fn();
    const { res, state } = mockRes();
    limiter(fakeReq('1.2.3.4'), res, next);
    expect(next).not.toHaveBeenCalled();
    expect(state.status).toBe(429);
    expect(state.headers['Retry-After']).toBeDefined();
    expect(state.body).toEqual({ error: 'Too many requests. Please try again later.' });
  });

  it('a different IP is unaffected by another IP’s exhausted window', () => {
    const limiter = createIpRateLimit({ ...options, now: () => 1_000 });
    for (let i = 0; i < 11; i++) {
      const { res } = mockRes();
      limiter(fakeReq('1.2.3.4'), res, vi.fn());
    }
    const next = vi.fn();
    const { res, state } = mockRes();
    limiter(fakeReq('5.6.7.8'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBeUndefined();
  });

  it('admits again once the window has expired, via the injected clock alone', () => {
    let now = 0;
    const limiter = createIpRateLimit({ ...options, now: () => now });
    for (let i = 0; i < 11; i++) {
      const { res } = mockRes();
      limiter(fakeReq('9.9.9.9'), res, vi.fn());
    }
    const deniedNext = vi.fn();
    const { res: deniedRes, state: deniedState } = mockRes();
    limiter(fakeReq('9.9.9.9'), deniedRes, deniedNext);
    expect(deniedNext).not.toHaveBeenCalled();
    expect(deniedState.status).toBe(429);

    now = 60_001;
    const next = vi.fn();
    const { res, state } = mockRes();
    limiter(fakeReq('9.9.9.9'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBeUndefined();
  });

  // `>=` means `now === windowStart + windowMs` is already a NEW window (admitted).
  it('at exactly the window boundary (now === windowStart + 60000), a fresh window has already started', () => {
    let now = 0;
    const limiter = createIpRateLimit({ ...options, now: () => now });
    for (let i = 0; i < 11; i++) {
      const { res } = mockRes();
      limiter(fakeReq('4.4.4.4'), res, vi.fn());
    }
    now = 60_000;
    const next = vi.fn();
    const { res, state } = mockRes();
    limiter(fakeReq('4.4.4.4'), res, next);
    expect(next).toHaveBeenCalledTimes(1);
    expect(state.status).toBeUndefined();
  });

  // The Map must not grow without bound: assert directly on its size via `.size()`.
  it('sweeps expired entries out of the Map once past the size threshold, bounding memory', () => {
    let now = 0;
    const limiter = createIpRateLimit({ ...options, now: () => now });
    const seedCount = 300; // > the sweep threshold (256)

    for (let i = 0; i < seedCount; i++) {
      const { res } = mockRes();
      limiter(fakeReq(`10.0.${Math.floor(i / 256)}.${i % 256}`), res, vi.fn());
    }
    expect(limiter.size()).toBe(seedCount);

    now = 60_001;
    const { res } = mockRes();
    limiter(fakeReq('255.255.255.255'), res, vi.fn());
    expect(limiter.size()).toBe(1);
  });

  // Below the threshold the O(n) sweep must NOT run on every call.
  it('does not sweep below the size threshold, even with stale entries present', () => {
    let now = 0;
    const limiter = createIpRateLimit({ ...options, now: () => now });
    const seedCount = 50;

    for (let i = 0; i < seedCount; i++) {
      const { res } = mockRes();
      limiter(fakeReq(`10.1.0.${i}`), res, vi.fn());
    }
    expect(limiter.size()).toBe(seedCount);

    now = 60_001;
    const { res } = mockRes();
    limiter(fakeReq('255.255.255.255'), res, vi.fn());
    expect(limiter.size()).toBe(seedCount + 1);
  });

  describe('client IP resolution / trustProxyHops', () => {
    it('with trustProxyHops 0 the TCP peer is used even if a header is present', () => {
      const limiter = createIpRateLimit({ ...options, now: () => 1_000 });
      for (let i = 0; i < 10; i++) {
        const { res } = mockRes();
        limiter(fakeReq('203.0.113.9', 'attacker-forged-value'), res, vi.fn());
      }
      const next = vi.fn();
      const { res, state } = mockRes();
      limiter(fakeReq('203.0.113.9', 'different-forged-value'), res, next);
      expect(next).not.toHaveBeenCalled();
      expect(state.status).toBe(429);
    });

    it('with trustProxyHops=1, two distinct clients behind the same one trusted proxy are limited INDEPENDENTLY', () => {
      const limiter = createIpRateLimit({ ...options, now: () => 1_000, trustProxyHops: 1 });
      const proxyAddress = '10.10.10.10';
      for (let i = 0; i < 10; i++) {
        const { res } = mockRes();
        limiter(fakeReq(proxyAddress, '198.51.100.1'), res, vi.fn());
      }
      const { res: aRes, state: aState } = mockRes();
      limiter(fakeReq(proxyAddress, '198.51.100.1'), aRes, vi.fn());
      expect(aState.status).toBe(429);
      const { res: bRes, state: bState } = mockRes();
      limiter(fakeReq(proxyAddress, '198.51.100.2'), bRes, vi.fn());
      expect(bState.status).toBeUndefined();
    });

    it('with trustProxyHops=1, a missing X-Forwarded-For falls back to the direct peer (fail-safe, not a crash)', () => {
      const limiter = createIpRateLimit({ ...options, now: () => 1_000, trustProxyHops: 1 });
      const { res, state } = mockRes();
      limiter(fakeReq('10.10.10.10'), res, vi.fn());
      expect(state.status).toBeUndefined();
      expect(limiter.size()).toBe(1);
    });

    it('with trustProxyHops=2 and a one-entry header, falls back to the direct peer rather than a client-forged entry', () => {
      const limiter = createIpRateLimit({ ...options, now: () => 1_000, trustProxyHops: 2 });
      for (let i = 0; i < 11; i++) {
        const { res } = mockRes();
        limiter(fakeReq('10.10.10.10', `forged-${i}`), res, vi.fn());
      }
      expect(limiter.size()).toBe(1);
    });
  });
});
