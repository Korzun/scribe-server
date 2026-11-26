import type { Request, Response } from 'express';

import { logger } from '../logger';
import { resolveClientIp } from './rate-limit';

const log = logger('LoginGuard');

/** Failures within this window count toward a client's lock. */
export const WINDOW_MS = 15 * 60_000;
export const MAX_FAILS = 5;
export const LOCK_MS = 15 * 60_000;
/** Window for the setup-code failures counted across all clients. */
export const GLOBAL_WINDOW_MS = 60 * 60_000;
export const GLOBAL_MAX = 50;
/** Secret checks allowed to run at once, across every kind. */
export const MAX_CHECKING = 2;
/** What an attempt refused for being busy is told to wait. */
export const BUSY_WAIT_S = 60;

// Same gate as rate-limit.ts: only walk the whole Map once it has grown.
const SWEEP_THRESHOLD = 256;

/** `secret` is any owner-secret check; `setupCode` is the library setup-code door. */
export type GuardKind = 'secret' | 'setupCode';

/** Which locks one failure newly set: its client's, and/or the global setup-code one. */
type LockScope = { client: boolean; global: boolean };

/** A check let through by `begin`, already counted as a failure. Opaque to callers. */
export type Attempt = {
  readonly kind: GuardKind;
  readonly client: string;
  readonly at: number;
  /** The locks this attempt's provisional failure set, if any. */
  readonly locked: LockScope | null;
  done: boolean;
};

export type Begin =
  | { attempt: Attempt }
  | { refused: 'locked'; retryAfterS: number }
  | { refused: 'busy'; retryAfterS: 60 };

type ClientState = { fails: number[]; lockedUntil: number };

/**
 * In-memory login guard, ported from Aviary's `LoginLimiter`. All times are
 * epoch milliseconds, injected by the caller so tests need no fake timers.
 *
 * `begin` runs before a secret is checked: it refuses when the client (or, for
 * `setupCode`, everyone) is locked, or when too many checks are already
 * running (a busy refusal is not counted). Otherwise it takes a check slot and
 * records a provisional failure, so a burst of concurrent guesses trips the
 * lock before any of them finishes. `finish` frees the slot and, on success,
 * takes the failure back and clears the client. Every attempt must be passed
 * to `finish` exactly once its check is over (extra calls are no-ops).
 *
 * Failures are per client across kinds (one bucket); only `setupCode`
 * failures also feed the global count. The client Map is swept of idle
 * entries once it exceeds `SWEEP_THRESHOLD`, like `createIpRateLimit`.
 */
export class LoginGuard {
  private readonly clients = new Map<string, ClientState>();
  /** Setup-code failure times across all clients, oldest first. */
  private globalFails: number[] = [];
  private checking = 0;
  private readonly maxChecking: number;

  constructor(opts: { maxChecking?: number } = {}) {
    this.maxChecking = opts.maxChecking ?? MAX_CHECKING;
  }

  /** Number of client entries held (exposed for the sweep test). */
  size(): number {
    return this.clients.size;
  }

  begin(kind: GuardKind, client: string, nowMs: number): Begin {
    if (this.clients.size > SWEEP_THRESHOLD) this.sweep(nowMs);
    const waitMs = this.lockedForMs(kind, client, nowMs);
    if (waitMs > 0) return { refused: 'locked', retryAfterS: Math.ceil(waitMs / 1000) };
    if (this.checking >= this.maxChecking) {
      log.warn(`Login check refused as busy for ${client}`);
      return { refused: 'busy', retryAfterS: BUSY_WAIT_S };
    }
    this.checking++;
    const locked = this.recordFailure(kind, client, nowMs);
    return { attempt: { kind, client, at: nowMs, locked, done: false } };
  }

  finish(attempt: Attempt, ok: boolean, nowMs: number): void {
    if (attempt.done) return;
    attempt.done = true;
    this.checking--;
    if (ok) {
      this.clients.delete(attempt.client);
      if (attempt.kind === 'setupCode') {
        const i = this.globalFails.lastIndexOf(attempt.at);
        if (i >= 0) this.globalFails.splice(i, 1);
      }
      return;
    }
    if (attempt.locked !== null && this.lockedForMs(attempt.kind, attempt.client, nowMs) > 0) {
      const { client } = attempt;
      if (attempt.locked.global) {
        log.warn(`Setup-code attempts locked for everyone after failures, latest from ${client}`);
      }
      if (attempt.locked.client) {
        log.warn(`Client ${client} locked after repeated failed attempts`);
      }
    }
  }

  /**
   * Cap only, for routes that already authenticated the owner: takes a check
   * slot without recording anything. Returns an idempotent release function,
   * or null when the cap is full.
   */
  tryCheck(): (() => void) | null {
    if (this.checking >= this.maxChecking) return null;
    this.checking++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.checking--;
    };
  }

  /** Milliseconds this client must wait, or 0 if it may try now. */
  private lockedForMs(kind: GuardKind, client: string, nowMs: number): number {
    const until = Math.max(
      this.clientState(client, nowMs)?.lockedUntil ?? 0,
      kind === 'setupCode' ? this.globalUntil(nowMs) : 0
    );
    return until > nowMs ? until - nowMs : 0;
  }

  /** When the global setup-code lock ends, or 0 if it is not locked. */
  private globalUntil(nowMs: number): number {
    const cutoff = nowMs - GLOBAL_WINDOW_MS;
    let i = 0;
    while (i < this.globalFails.length && this.globalFails[i] <= cutoff) i++;
    if (i > 0) this.globalFails.splice(0, i);
    const n = this.globalFails.length;
    return n < GLOBAL_MAX ? 0 : this.globalFails[n - GLOBAL_MAX] + GLOBAL_WINDOW_MS;
  }

  private clientState(client: string, nowMs: number): ClientState | undefined {
    const st = this.clients.get(client);
    if (!st) return undefined;
    st.fails = st.fails.filter((t) => t > nowMs - WINDOW_MS);
    if (st.lockedUntil <= nowMs && st.fails.length === 0) {
      this.clients.delete(client);
      return undefined;
    }
    return st;
  }

  /** Records one failure; returns the locks it newly set, if any. */
  private recordFailure(kind: GuardKind, client: string, nowMs: number): LockScope | null {
    const locked: LockScope = { client: false, global: false };
    const st = this.clientState(client, nowMs) ?? { fails: [], lockedUntil: 0 };
    st.fails.push(nowMs);
    if (st.fails.length >= MAX_FAILS) {
      st.lockedUntil = nowMs + LOCK_MS;
      st.fails = [];
      locked.client = true;
    }
    this.clients.set(client, st);

    if (kind === 'setupCode') {
      this.globalFails.push(nowMs);
      if (this.globalFails.length === GLOBAL_MAX && this.globalUntil(nowMs) > nowMs)
        locked.global = true;
    }
    return locked.client || locked.global ? locked : null;
  }

  private sweep(nowMs: number): void {
    for (const client of [...this.clients.keys()]) this.clientState(client, nowMs);
  }
}

let proxyWarned = false;

/** Test hook: lets the once-per-process proxy warning fire again. */
export function resetProxyWarning(): void {
  proxyWarned = false;
}

/**
 * With no trusted hops every client resolves to the proxy's own address, so
 * all of them share one lockout bucket. Warns once per process when a request
 * shows it is being proxied anyway.
 */
function warnIfUnconfiguredProxy(req: Request, trustProxyHops: number): void {
  if (proxyWarned || trustProxyHops > 0 || req.headers['x-forwarded-for'] === undefined) return;
  proxyWarned = true;
  log.warn(
    'Requests arrive through a proxy (X-Forwarded-For) but TRUST_PROXY_HOPS is 0: every client shares one lockout bucket. Set TRUST_PROXY_HOPS to your proxy hop count.'
  );
}

const minutes = (seconds: number): number => Math.max(1, Math.ceil(seconds / 60));

/**
 * Starts a guarded credential check for this request's client. When refused,
 * sends the 429 itself (locked or busy, with `Retry-After`) and returns null.
 * Otherwise the caller owns the attempt and must `guard.finish` it in a
 * `finally`, or the check slot leaks.
 */
export function beginAttempt(
  guard: LoginGuard,
  req: Request,
  res: Response,
  kind: GuardKind,
  trustProxyHops: number,
  nowMs: number
): Attempt | null {
  warnIfUnconfiguredProxy(req, trustProxyHops);
  const begun = guard.begin(kind, resolveClientIp(req, trustProxyHops), nowMs);
  if ('attempt' in begun) return begun.attempt;
  res.set('Retry-After', String(begun.retryAfterS));
  res.status(429).json({
    error:
      begun.refused === 'busy'
        ? 'Too busy. Try again in a minute.'
        : `Too many attempts. Try again in ${minutes(begun.retryAfterS)} min.`,
  });
  return null;
}

/**
 * The check cap alone, for routes that already authenticated the owner. Sends
 * the busy 429 and returns null when full; otherwise returns the release
 * function, to call in a `finally`.
 */
export function acquireCheck(
  guard: LoginGuard,
  req: Request,
  res: Response,
  trustProxyHops: number
): (() => void) | null {
  warnIfUnconfiguredProxy(req, trustProxyHops);
  const release = guard.tryCheck();
  if (release !== null) return release;
  log.warn(`Account check refused as busy for ${resolveClientIp(req, trustProxyHops)}`);
  res.set('Retry-After', String(BUSY_WAIT_S));
  res.status(429).json({ error: 'Too busy. Try again in a minute.' });
  return null;
}
