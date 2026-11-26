import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type Attempt,
  type Begin,
  acquireCheck,
  beginAttempt,
  LoginGuard,
  resetProxyWarning,
} from './login-guard';

// One `warn` spy shared by every logger, so a test can read what was warned.
const warn = vi.hoisted(() => vi.fn());
vi.mock('../logger', () => ({
  logger: () => ({ debug: vi.fn(), info: vi.fn(), warn, error: vi.fn() }),
}));

const MIN = 60_000;

function attemptOf(b: Begin): Attempt {
  if (!('attempt' in b)) throw new Error(`expected an attempt, got ${JSON.stringify(b)}`);
  return b.attempt;
}

describe('LoginGuard', () => {
  function fail(g: LoginGuard, kind: 'secret' | 'setupCode', client: string, t: number): Begin {
    const b = g.begin(kind, client, t);
    if ('attempt' in b) g.finish(b.attempt, false, t);
    return b;
  }

  it('locks a client after 5 failures for 15 min', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) fail(g, 'secret', 'a', t);
    expect(g.begin('secret', 'a', t)).toEqual({ refused: 'locked', retryAfterS: 900 });
    expect(g.begin('secret', 'a', t + 900_000)).toHaveProperty('attempt');
  });

  it('failures older than 15 min fall out of the window', () => {
    const g = new LoginGuard();
    const t0 = 1_000_000;
    for (let i = 0; i < 4; i++) fail(g, 'secret', 'a', t0);
    fail(g, 'secret', 'a', t0 + 15 * MIN + 1);
    expect(g.begin('secret', 'a', t0 + 15 * MIN + 1)).toHaveProperty('attempt');
  });

  it('a success clears the client', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    for (let i = 0; i < 4; i++) fail(g, 'secret', 'a', t);
    g.finish(attemptOf(g.begin('secret', 'a', t)), true, t);
    for (let i = 0; i < 4; i++) fail(g, 'secret', 'a', t);
    // 4 failures since the success do not lock; the 5th does
    fail(g, 'secret', 'a', t);
    expect(g.begin('secret', 'a', t)).toMatchObject({ refused: 'locked' });
  });

  it('kinds share one client bucket', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    for (let i = 0; i < 3; i++) fail(g, 'secret', 'a', t);
    for (let i = 0; i < 2; i++) fail(g, 'setupCode', 'a', t);
    expect(g.begin('secret', 'a', t)).toMatchObject({ refused: 'locked' });
  });

  it('other clients are unaffected by a client lock', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) fail(g, 'secret', 'a', t);
    expect(g.begin('secret', 'a', t)).toMatchObject({ refused: 'locked' });
    expect(g.begin('secret', 'b', t)).toHaveProperty('attempt');
  });

  it('global cap locks setupCode only', () => {
    const g = new LoginGuard();
    const t0 = 1_000_000;
    for (let i = 0; i < 50; i++) fail(g, 'setupCode', `c${i}`, t0 + i);
    const tNow = t0 + 100;
    const locked = g.begin('setupCode', 'fresh', tNow);
    expect(locked).toMatchObject({ refused: 'locked' });
    expect(g.begin('secret', 'fresh', tNow)).toHaveProperty('attempt');
    // lifts 60 min after the oldest of the 50 failures
    expect(g.begin('setupCode', 'fresh', t0 + 60 * MIN - 1)).toMatchObject({ refused: 'locked' });
    expect(g.begin('setupCode', 'fresh', t0 + 60 * MIN)).toHaveProperty('attempt');
  });

  it('a setup-code success removes its global timestamp', () => {
    const g = new LoginGuard();
    const t0 = 1_000_000;
    for (let i = 0; i < 49; i++) fail(g, 'setupCode', `c${i}`, t0 + i);
    const ok = attemptOf(g.begin('setupCode', 'good', t0 + 100));
    g.finish(ok, true, t0 + 100);
    // 49 failures remain, not 50: a fresh client is not locked
    expect(g.begin('setupCode', 'fresh', t0 + 200)).toHaveProperty('attempt');
  });

  it('logs each lock that one setup-code failure begins', () => {
    warn.mockClear();
    const g = new LoginGuard();
    const t0 = 1_000_000;
    // 45 failures from other clients, then 5 from one: its 5th trips both locks
    for (let i = 0; i < 45; i++) fail(g, 'setupCode', `c${i}`, t0 + i);
    for (let i = 0; i < 5; i++) fail(g, 'setupCode', 'x', t0 + 100);
    const lines = warn.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('Client x locked'))).toBe(true);
    expect(lines.some((l) => l.includes('for everyone'))).toBe(true);
  });

  it('a concurrent burst trips the lock', () => {
    const g = new LoginGuard({ maxChecking: 10 });
    const t = 1_000_000;
    for (let i = 0; i < 5; i++) expect(g.begin('secret', 'a', t)).toHaveProperty('attempt');
    expect(g.begin('secret', 'a', t)).toMatchObject({ refused: 'locked' });
  });

  it('third check in flight is busy and not counted', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    const a1 = attemptOf(g.begin('secret', 'a', t));
    const a2 = attemptOf(g.begin('secret', 'a', t));
    expect(g.begin('secret', 'a', t)).toEqual({ refused: 'busy', retryAfterS: 60 });
    g.finish(a1, false, t);
    g.finish(a2, false, t);
    // 2 failures recorded, not 3: two more do not lock, a third does
    fail(g, 'secret', 'a', t);
    fail(g, 'secret', 'a', t);
    expect(g.begin('secret', 'a', t)).toHaveProperty('attempt');
  });

  it('third failure after busy refusal still needs 3 more to lock', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    const a1 = attemptOf(g.begin('secret', 'a', t));
    const a2 = attemptOf(g.begin('secret', 'a', t));
    g.begin('secret', 'a', t); // busy
    g.finish(a1, false, t);
    g.finish(a2, false, t);
    for (let i = 0; i < 3; i++) fail(g, 'secret', 'a', t);
    expect(g.begin('secret', 'a', t)).toMatchObject({ refused: 'locked' });
  });

  it('tryCheck shares the cap', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    attemptOf(g.begin('secret', 'a', t));
    const release = g.tryCheck();
    expect(release).not.toBeNull();
    expect(g.begin('secret', 'b', t)).toEqual({ refused: 'busy', retryAfterS: 60 });
    expect(g.tryCheck()).toBeNull();
    release!();
    release!();
    // exactly one slot freed
    const again = g.tryCheck();
    expect(again).not.toBeNull();
    expect(g.tryCheck()).toBeNull();
  });

  it('finish is idempotent and always frees the slot', () => {
    const g = new LoginGuard();
    const t = 1_000_000;
    const a = attemptOf(g.begin('secret', 'a', t));
    g.finish(a, false, t);
    g.finish(a, false, t);
    attemptOf(g.begin('secret', 'b', t));
    attemptOf(g.begin('secret', 'c', t));
    expect(g.begin('secret', 'd', t)).toMatchObject({ refused: 'busy' });
  });

  it('sweeps expired clients past 256 entries', () => {
    const g = new LoginGuard();
    const t0 = 1_000_000;
    for (let i = 0; i < 300; i++) fail(g, 'secret', `c${i}`, t0);
    expect(g.size()).toBe(300);
    g.begin('secret', 'late', t0 + 30 * MIN);
    expect(g.size()).toBeLessThanOrEqual(1);
  });
});

describe('proxy misconfiguration warning', () => {
  const reqWith = (headers: Record<string, string>): Request =>
    ({ headers, socket: { remoteAddress: '10.0.0.1' } }) as unknown as Request;
  const res = {
    set: vi.fn().mockReturnThis(),
    status: vi.fn().mockReturnThis(),
    json: vi.fn().mockReturnThis(),
  } as unknown as Response;
  const proxyWarnings = () =>
    warn.mock.calls.filter((c) => String(c[0]).includes('TRUST_PROXY_HOPS'));

  beforeEach(() => {
    warn.mockClear();
    resetProxyWarning();
  });

  it('warns once across requests carrying X-Forwarded-For with hops 0', () => {
    const g = new LoginGuard();
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4' });
    g.finish(beginAttempt(g, req, res, 'secret', 0, 1_000_000)!, true, 1_000_000);
    g.finish(beginAttempt(g, req, res, 'secret', 0, 1_000_001)!, true, 1_000_001);
    acquireCheck(g, req, res, 0)?.();
    expect(proxyWarnings()).toHaveLength(1);
  });

  it('never warns when hops > 0', () => {
    const g = new LoginGuard();
    const req = reqWith({ 'x-forwarded-for': '1.2.3.4' });
    g.finish(beginAttempt(g, req, res, 'secret', 1, 1_000_000)!, true, 1_000_000);
    expect(proxyWarnings()).toHaveLength(0);
  });

  it('never warns without the header', () => {
    const g = new LoginGuard();
    g.finish(beginAttempt(g, reqWith({}), res, 'secret', 0, 1_000_000)!, true, 1_000_000);
    expect(proxyWarnings()).toHaveLength(0);
  });
});
