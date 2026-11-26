# Login protections: lockout, check cap, security headers

Status: approved by Simon (2026-11-25).

## Intent

Bring the login protections just added to aviary-server (its 2026-11-24 public-access design)
to scribe-server, for consistency between the two servers. Not prompted by an incident.

## What exists today

- Per-IP fixed-window limiters (`middleware/rate-limit.ts`, proxy-aware `resolveClientIp`) on
  every unauthenticated route: sign-in, enrolment, recovery, create (10/min), reset (5/h),
  salts (60/min), and the MCP OAuth endpoints.
- Bearer tokens for the API; the one cookie (refresh) is httpOnly, SameSite=strict, path-scoped.
  So Aviary's Origin/CSRF check adds little here and is out of scope.
- No security headers at all.

## Goals

1. **Failure lockout** per client, Aviary's numbers: 5 failures in 15 min locks that client for
   15 min (`429`, `Retry-After`, `{ error: 'Too many attempts. Try again in N min.' }`).
2. **Global cap on the setup-code routes only**: 50 failures per hour across all clients locks
   `POST /library` and `DELETE /library` for everyone until the hour rolls off.
3. **Concurrency cap on argon2 checks**: at most 2 credential checks in flight process-wide;
   a request beyond that gets `429`, `Retry-After: 60`, without hashing and without counting.
4. **Security headers** on every response.
5. One `warn` log line per lockout (when it begins, not per refused request) and per busy
   refusal; no secrets, client address only. Visible in Coolify's logs.

## Non-goals

- An event log or admin-page view of failed sign-ins (Coolify logs are enough).
- Aviary's two doors, LAN address guard, Cloudflare-header guard: scribe has one public door.
- Origin/CSRF checks (bearer auth already covers it).
- Persisting counters: in memory, a restart clears them, as in Aviary.

## Anti-goals

- A global lock on sign-in, enrolment or recovery: with one door, anyone spraying from many
  addresses could lock the owner out of the admin page. Those secrets (password + 128-bit Secret
  Key, 80-bit recovery codes) are unguessable online, so a global cap there buys nothing.
- Anything that touches device-token or MCP-token traffic: Macs and Claude must be unaffected.
- A CSP that breaks the admin page (react-jss styles, the kit download, the `/connect`
  redirect via `window.location.assign`).

## Approaches considered (for the global cap)

- **(a) Global cap on setup-code routes only (chosen).** The only guessable secret; the owner
  almost never uses those routes, so a lock there costs nothing in practice.
- **(b) Global cap everywhere, like Aviary's public door.** Strict parity, but without a LAN
  door that never locks, it hands anyone a way to lock the owner out for up to an hour.

Simon picked (a). Headers: port Aviary's hand-written `headers.ts` rather than add `helmet`
(no dependency, matches Aviary).

## Design

### Which routes count failures

| Route | Failure = | Per-client lockout | Global cap | Check cap |
|---|---|---|---|---|
| `POST /session` (sign-in) | 401 invalid credentials | yes | no | yes |
| `POST /devices` (enrol) | 401 invalid credentials | yes | no | yes |
| `POST /recovery` | 401 invalid credentials | yes | no | yes |
| `POST /recovery/:id/password` | rejected | yes | no | yes |
| `POST /library` (create) | wrong setup code | yes | yes | yes (hash) |
| `DELETE /library` (reset) | wrong setup code | yes | yes | — |
| `PUT /library/password`, `PUT /library/recovery-codes` | — (owner-authenticated) | no | no | yes |

All lockout routes share one per-client failure count (one bucket per client address, as
resolved by `resolveClientIp` with `TRUST_PROXY_HOPS`). A 400 (malformed body) and a 404
(no library) are not failures.

### Counting (ported from Aviary's `LoginLimiter`)

- Each attempt let through is recorded as a failure *before* the check runs and is taken back
  on success, so a concurrent burst trips the lock instead of all being checked.
- A success clears that client's failure count, as in Aviary (the secrets are unguessable, so
  a success is never part of a guessing run).
- The existing fixed-window limiters stay in front, unchanged.
- Times in ms against the injected `now`, so tests need no fake timers.

### Check cap

One shared semaphore (`MAX_CHECKING = 2`) passed to the routers that run argon2. Acquired
after the lockout check and before the provisional failure is recorded; released in `finally`.
`findRecoveryCode` verifies up to ten codes sequentially; that is one slot.

### Headers

On every response (API, SPA, static, MCP):

- `Content-Security-Policy: default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`
- `X-Content-Type-Options: nosniff`
- `Referrer-Policy: same-origin`
- `X-Frame-Options: DENY`
- `X-Powered-By` removed (`server.disable('x-powered-by')`).
- `/api/*` and the MCP/OAuth paths also get `Cache-Control: no-store` (unless the route
  already sets its own, e.g. blob downloads — builder checks and keeps existing ones).

### Tests

Limiter unit tests (lock after 5, unlock after 15 min, provisional count under a burst, global
cap only for setup-code routes, busy refusal not counted); one route test per protected route
showing the 429 after 5 wrong attempts; headers present on an API, SPA and MCP response; the
client build still loads under the CSP (screenshot the admin page via Playwright against a
dev server, check the console for CSP violations).

## Left to the builder

- Module layout (`middleware/login-limiter.ts` next to `rate-limit.ts` is the natural home)
  and how the limiter and semaphore are threaded through `createServer`'s deps.
- Exact log wording.
