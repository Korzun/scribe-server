import type { NextFunction, Request, Response } from 'express';

import { logger } from '../logger';

const log = logger('RateLimit');

// Below this size, sweeping on every call is cheap enough not to matter;
// gating the O(n) walk behind it means the common case (a handful of active
// windows) never pays a per-request Map scan at all — see `createIpRateLimit`'s
// doc comment for the full trade-off. Shared by every instance the factory
// produces.
const SWEEP_THRESHOLD = 256;

type RateLimitWindow = { count: number; windowStart: number };

/**
 * Resolves the client IP the limiter should key on — used ONLY here, never as
 * Express's own `req.ip`/`trust proxy` setting (that setting also changes
 * `req.secure`/cookie semantics app-wide, a strictly bigger change than this
 * one control needs).
 *
 * `trustProxyHops` (see `AppConfig.trustProxyHops`'s doc comment, `types.ts`):
 * `0` (the conservative default) returns `req.socket.remoteAddress`
 * unconditionally, ignoring `X-Forwarded-For` entirely — a spoofed header
 * cannot influence the key. `N > 0` trusts the last `N` hops: build the chain
 * `[client, proxy1, ..., proxyK]` from the header (left-to-right,
 * closest-to-client first — the standard `X-Forwarded-For` convention), then
 * walk back `N` positions from the end to find the address the Nth trusted hop
 * added — the same algorithm Express's own numeric `trust proxy: n` mode uses
 * (`proxy-addr`), computed by hand so it affects only this function.
 *
 * The two deliberately DIVERGE when the header is shorter than `N` (a
 * misconfigured `trustProxyHops`, or a proxy that isn't appending as
 * expected): `proxy-addr` falls through to the leftmost (client-writable)
 * entry, which a client can forge to mint an arbitrary bucket; this function
 * falls back to the direct peer instead — under-trusting fails safe.
 * Over-trusting (`trustProxyHops` higher than the real hop count) is an
 * operator error no implementation can detect from inside one request, which
 * is why `AppConfig.trustProxyHops` warns against it.
 */
function resolveClientIp(req: Request, trustProxyHops: number): string {
  const direct = req.socket.remoteAddress ?? 'unknown';
  if (trustProxyHops <= 0) return direct;

  const header = req.headers['x-forwarded-for'];
  const raw = Array.isArray(header) ? header[0] : header;
  if (typeof raw !== 'string' || raw.trim() === '') return direct;

  const chain = raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const clientIndex = chain.length - trustProxyHops;
  return clientIndex >= 0 ? chain[clientIndex] : direct;
}

export type IpRateLimitOptions = {
  /** Requests allowed per IP per window; the (max + 1)th is answered 429. */
  max: number;
  windowMs: number;
  /** See `resolveClientIp`; tests pass `0`. */
  trustProxyHops: number;
  /** Clock in epoch ms; tests inject a fake one, production omits it (`Date.now`). */
  now?: () => number;
};

/**
 * Fixed-window IP rate limiter: each instance allows `max` requests per
 * `windowMs` per IP, then answers 429 + `Retry-After`. Extracted from
 * Bookplate's login limiter; the spec (§4) puts it on the unauthenticated
 * library routes so the setup code cannot be guessed at speed.
 *
 * The Map is swept of aged-out windows (a 500k-distinct-IP probe once retained
 * 48MB that was never reclaimed, so a per-key reset alone is not enough), but
 * the O(n) walk only RUNS once `windows.size` exceeds `SWEEP_THRESHOLD`:
 * ordinary traffic never pays a Map scan per request. THIS ip's own window
 * staleness is still checked separately, at O(1), because the gated sweep may
 * not have run — sweep's job is purely bulk memory reclamation for OTHER ips,
 * never this ip's own correctness. `size()` is exposed so a test can pin the
 * sweep by observing the Map directly.
 *
 * `now` is injected as a `() => number`, so "window expiry admits again" needs
 * no fake timers. A successful request does NOT reset the counter: one code
 * path for every attempt, and a leaked secret being tried successfully many
 * times in a minute is exactly the pattern worth throttling too.
 *
 * Factory shape: called once per router build, so each test's fresh router has
 * its own isolated Map — no state leaks between tests.
 */
export function createIpRateLimit(options: IpRateLimitOptions) {
  const now = options.now ?? Date.now;
  const { max, windowMs, trustProxyHops } = options;
  const windows = new Map<string, RateLimitWindow>();

  function sweep(current: number): void {
    for (const [ip, window] of windows) {
      if (current - window.windowStart >= windowMs) {
        windows.delete(ip);
      }
    }
  }

  function ipRateLimit(req: Request, res: Response, next: NextFunction): void {
    const current = now();
    if (windows.size > SWEEP_THRESHOLD) sweep(current);
    const ip = resolveClientIp(req, trustProxyHops);

    let window = windows.get(ip);
    if (window === undefined || current - window.windowStart >= windowMs) {
      window = { count: 0, windowStart: current };
      windows.set(ip, window);
    }
    window.count += 1;

    if (window.count > max) {
      const retryAfterSeconds = Math.ceil((window.windowStart + windowMs - current) / 1000);
      log.warn(`Rate limit exceeded for ${ip}`);
      res
        .status(429)
        .set('Retry-After', String(Math.max(retryAfterSeconds, 1)))
        .json({ error: 'Too many requests. Please try again later.' });
      return;
    }
    next();
  }

  ipRateLimit.size = (): number => windows.size;
  return ipRateLimit;
}
