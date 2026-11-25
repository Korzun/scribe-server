# Login Protections Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Per-client failure lockout, a global cap on the setup-code routes, a cap of two argon2 checks in flight, and security headers on every response.

**Architecture:** One in-memory `LoginGuard` (ported from aviary-server's `server/src/auth/limiter.ts`) owned by `createServer` and passed to the four routers that check credentials; thin Express helpers send the 429s. A `securityHeaders()` middleware (ported from aviary-server's `server/src/http/headers.ts`) is the first `server.use`.

**Tech Stack:** Node 24, Express 5, TypeScript, vitest + supertest, Playwright CLI for the CSP check.

**Spec:** `docs/superpowers/specs/2026-11-25-login-protections-design.md`

## Global Constraints

- Lockout: 5 failures in 15 min (`15 * 60_000` ms) per client locks it for 15 min.
- Global cap: 50 setup-code failures in 60 min across all clients locks `POST /library` and `DELETE /library` for everyone; it never affects any other route.
- Check cap: `MAX_CHECKING = 2`; a refused-for-busy attempt is not counted and gets `Retry-After: 60`.
- Locked body: `{ error: 'Too many attempts. Try again in N min.' }` (N = ceil of seconds left / 60, at least 1), `Retry-After` = seconds left. Busy body: `{ error: 'Too busy. Try again in a minute.' }`. Both status 429.
- Client identity: `resolveClientIp(req, config.trustProxyHops)` from `middleware/rate-limit.ts`.
- Existing fixed-window limiters stay, unchanged, in front.
- Counters in memory only. A success clears that client's failures and lock.
- Log lines: one `warn` when a client lock begins, one when the global lock begins, one per busy refusal. Interpolate only the client address; `log-safety.test.ts` denies identifiers containing words such as `code`, `key`, `auth`, `password` (so name the variable `client`, not `setupCodeClient`).
- CSP, verbatim: `default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'`. Plus `X-Content-Type-Options: nosniff`, `Referrer-Policy: same-origin`, `X-Frame-Options: DENY`, no `X-Powered-By`.
- Commands: `npm test`, `npm run lint`, `npm run test:scripts`, all from the repo root.

## Review Focus

1. **A thrown error during a check leaks a slot.** Two leaks and every login is "Too busy" forever. Every `beginAttempt` and `acquireCheck` must be paired with a `finally`. Pinned by the guard test "finish is idempotent and always frees the slot", plus a review of each route.
2. **Behind the tunnel, every client looks like the proxy.** With `trustProxyHops: 1`, locking one `X-Forwarded-For` client must not lock another. Pinned in Task 2.
3. **The Macs and Claude while an address is locked.** Device-token and session-token routes must keep working from a locked address. Pinned in Task 2.
4. **Memory under a spray from many addresses.** The guard's client Map is swept like `rate-limit.ts` (`SWEEP_THRESHOLD = 256`). Pinned in Task 1.
5. **The CSP breaking the admin page.** Styles, the kit download and the `/connect` redirect must still work. Pinned by the Playwright console check in Task 3.

---

### Task 1: `LoginGuard`

**Files:**
- Create: `app/server/middleware/login-guard.ts`
- Test: `app/server/middleware/login-guard.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type GuardKind = 'secret' | 'setupCode';
  export type Attempt; // opaque to callers
  export type Begin =
    | { attempt: Attempt }
    | { refused: 'locked'; retryAfterS: number }
    | { refused: 'busy'; retryAfterS: 60 };
  export class LoginGuard {
    constructor(opts?: { maxChecking?: number });
    begin(kind: GuardKind, client: string, nowMs: number): Begin;
    finish(attempt: Attempt, ok: boolean, nowMs: number): void; // idempotent
    tryCheck(): (() => void) | null; // cap only, for owner-authenticated routes; the release fn is idempotent
    size(): number; // client entries, for the sweep test
  }
  // plus the constants named in Global Constraints, exported
  ```
- Semantics, ported from Aviary's `LoginLimiter.begin/finish/failed/succeeded`, with "public door" replaced by `kind === 'setupCode'`. `begin` checks the lock (client lock, and the global lock when kind is `setupCode`), then the cap, then takes a slot and records a provisional failure. That failure is client-wide; it also counts toward the global count when kind is `setupCode`. `finish(ok=true)` deletes the client entry and removes this attempt's global timestamp. `finish` logs the lock it set when the attempt failed and the lock still holds. `begin` logs busy refusals.

- [ ] **Step 1: Write the failing tests** (`vi.mock('../logger')`, plain `nowMs` numbers)
  - `locks a client after 5 failures for 15 min`: 5× begin+finish(false) → 6th `begin('secret','a',t)` is `{ refused: 'locked', retryAfterS: 900 }`; at `t + 900_000` it returns `{ attempt }`.
  - `failures older than 15 min fall out of the window`: 4 failures at t0, 1 at `t0 + 15*60_000 + 1` → not locked.
  - `a success clears the client`: 4 failures, then 1 success → 5 more failures are needed to lock.
  - `kinds share one client bucket`: 3 `secret` failures plus 2 `setupCode` failures lock `secret` for that client.
  - `other clients are unaffected by a client lock`: after `a` locks, `begin('secret','b')` → attempt.
  - `global cap locks setupCode only`: 50 `setupCode` failures from clients `c0..c49` → `begin('setupCode','fresh')` is locked; `begin('secret','fresh')` → attempt. The lock lifts 60 min after the oldest of those 50 failures.
  - `a concurrent burst trips the lock`: 6 `begin`s with no `finish` and `maxChecking: 10` → the 6th is locked.
  - `third check in flight is busy and not counted`: 2 open attempts → 3rd `begin` is `{ refused: 'busy', retryAfterS: 60 }`. After both `finish(false)`, the client has 2 failures, not 3 (3 more failures lock it, 2 do not).
  - `tryCheck shares the cap`: one open attempt plus one `tryCheck()` → the next `begin` is busy and the next `tryCheck()` is `null`; calling the release fn twice frees just one slot.
  - `finish is idempotent and always frees the slot`: `finish` twice on one attempt → `checking` drops by one (2 new begins succeed, a 3rd is busy).
  - `sweeps expired clients past 256 entries`: 300 clients fail once at t0; one `begin` at `t0 + 30*60_000` → `size()` ≤ 1.

- [ ] **Step 2: Run** `cd app/server && npx vitest run middleware/login-guard.test.ts`. Expected: FAIL (module not found).

- [ ] **Step 3: Implement `LoginGuard`** in `app/server/middleware/login-guard.ts`. Use `logger('LoginGuard')` and the Map sweep pattern from `rate-limit.ts`. The log wording is the implementer's choice; interpolate `client` only.

- [ ] **Step 4: Run** the same command. Expected: PASS.

- [ ] **Step 5: Commit** `feat(server): login guard: per-client lockout, setup-code global cap, check cap`

---

### Task 2: Wire the guard into the credential routes

**Files:**
- Modify: `app/server/middleware/login-guard.ts` (Express helpers)
- Modify: `app/server/server.ts` (`CreateServerDeps.loginGuard?: LoginGuard`, default `new LoginGuard()`, passed to the routers below)
- Modify: `app/server/routes/session.ts`, `routes/devices.ts`, `routes/recovery.ts`, `routes/library.ts` (each `*RouterDeps` gains `loginGuard: LoginGuard`)
- Modify: `app/server/test-support/harness.ts` (create the guard, pass it to `createServer`, expose it as `Harness.loginGuard`)
- Test: `routes/session.test.ts`, `routes/devices.test.ts`, `routes/recovery.test.ts`, `routes/library.test.ts`

**Interfaces:**
- Consumes: `LoginGuard`, `GuardKind` from Task 1.
- Produces (in `login-guard.ts`):
  ```ts
  /** Sends the 429 (locked or busy body per Global Constraints) and returns null when refused. */
  export function beginAttempt(guard: LoginGuard, req: Request, res: Response,
    kind: GuardKind, trustProxyHops: number, nowMs: number): Attempt | null;
  /** Cap only. Sends the busy 429 and returns null when full; otherwise returns the release fn. */
  export function acquireCheck(guard: LoginGuard, res: Response): (() => void) | null;
  ```
- Per route: call `beginAttempt` after the body parses and after any "No library" 404. Then `let ok = false; try { …; ok = <credential passed>; … } finally { guard.finish(attempt, ok, now()) }`.

| Route | kind | `ok` is |
|---|---|---|
| `POST /session` | secret | `verifyOwner` true (tokens issued inside the try) |
| `POST /devices` | secret | `verifyOwner` true |
| `POST /recovery` | secret | `findRecoveryCode` non-null |
| `POST /recovery/:id/password` | secret | outcome `!== 'rejected'` (`'not_found'` is a failure too: an unknown id is a probe) |
| `POST /library` | setupCode | `checkSetupCode` returned null. The 409 and the `createLibrary` hashing stay inside the slot. |
| `DELETE /library` | setupCode | `checkSetupCode` returned null; `resetLibrary` runs inside the slot. |
| `PUT /library/password`, `PUT /library/recovery-codes` | — | `acquireCheck` after the parse; release in `finally` |

- [ ] **Step 1: Repoint the existing fixed-window tests at non-failures.** The tests at `session.test.ts:94` ("rate limited to 10 attempts a minute"), `recovery.test.ts:154`, `library.test.ts:213` and `library.test.ts:597` send wrong credentials, which now lock at 5. Make them send malformed bodies (`{}`, so 400; the window limiter runs before parsing). Keep their 10th-OK / 11th-429 assertions (5/6 for reset). Where a file shares one harness across tests and uses `freshWindow()` with a 10-min step, raise the step to 30 min so wrong-credential tests don't add up toward a lock.

- [ ] **Step 2: Write the failing route tests**
  - In each of `session.test.ts`, `devices.test.ts`, `recovery.test.ts` (both routes): `locks the client after 5 wrong attempts`: 5× wrong → 401. The 6th, using the **right** credential where the test has one, → 429 with `Retry-After: 900` and the body `{ error: 'Too many attempts. Try again in 15 min.' }`. At `h.now.value += 15 * 60_000` the right credential → success.
  - `library.test.ts`: the same for `POST /library` and `DELETE /library` with a wrong setup code (403 ×5, then 429).
  - `library.test.ts`: `the setup-code global cap spares sign-in`: a harness with `trustProxyHops: 1`; 50 wrong-code creates, each with its own `X-Forwarded-For: 10.0.0.<i>` → a create from `10.0.1.1` gets 429. With an owner set up beforehand, `POST /session` from `10.0.1.1` with the right credential → 200.
  - `session.test.ts`: `lockout keys on the forwarded client`: a `trustProxyHops: 1` harness; client `10.0.0.1` locked → `10.0.0.2` signs in (200).
  - `session.test.ts`: `a locked address keeps its tokens`: after the locking attempts, the same client's existing session `GET /api/v1/devices` with the access token → 200. A device token from the same address → 200 as well.
  - `session.test.ts`: `busy when two checks are in flight`: `const r1 = h.loginGuard.tryCheck()!, r2 = …` → sign-in gets 429 with `Retry-After: 60` and the busy body. After `r1()` it → 200.
  - `library.test.ts`: `password change is busy when two checks are in flight`: same setup, `PUT /library/password` → 429 busy.

- [ ] **Step 3: Run** `cd app/server && npx vitest run routes/`. Expected: the new tests FAIL; the repointed ones PASS.

- [ ] **Step 4: Implement** the helpers, the `createServer` and harness wiring, and the per-route changes in the table. Update each router's doc comment where it says the route is "rate limited per IP" so it also mentions the lockout.

- [ ] **Step 5: Run** `npm test` and `npm run lint` from the repo root. Expected: all pass, including `log-safety.test.ts`.

- [ ] **Step 6: Commit** `feat(server): lock out repeated credential failures and cap concurrent argon2 checks`

---

### Task 3: Security headers, CSP check, docs

**Files:**
- Create: `app/server/middleware/security-headers.ts`
- Test: `app/server/middleware/security-headers.test.ts`
- Modify: `app/server/server.ts` (`server.disable('x-powered-by')`; `server.use(securityHeaders())` before `requestTimeout`)
- Modify: `README.md` (a short "Sign-in protection" paragraph next to the `TRUST_PROXY_HOPS` row or the security section: the lockout numbers, the setup-code cap, the headers, and that a restart clears counters)
- Modify: `CHANGELOG.md` (an Unreleased entry, in the file's existing style)

**Interfaces:**
- Produces: `export function securityHeaders(): RequestHandler`. It sets the four headers from Global Constraints and `Cache-Control: no-store` on every response before `next()`. `express.static` and `res.sendFile` overwrite Cache-Control with their own, so the SPA and its assets keep theirs; API and MCP responses get `no-store`.

- [ ] **Step 1: Write the failing tests** (through `createHarness`, with a temp `clientDist` the way `server.test.ts` does it)
  - `API responses carry the headers and no-store`: `GET /api/v1/status` → the CSP string exactly, `nosniff`, `same-origin`, `DENY`, `cache-control: no-store`, and no `x-powered-by`.
  - `the SPA shell carries the headers and keeps its own caching`: `GET /` → the CSP is present; `cache-control` is not `no-store`.
  - `MCP paths carry the headers`: with `publicUrl: 'https://vault.example'`, `GET /.well-known/oauth-authorization-server` → CSP and `no-store`. With MCP disabled, `GET /mcp` (JSON 404) → CSP.

- [ ] **Step 2: Run** `cd app/server && npx vitest run middleware/security-headers.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `securityHeaders()` and the two `server.ts` lines.

- [ ] **Step 4: Run** the same command, then `npm test` and `npm run lint` from the root. Expected: PASS.

- [ ] **Step 5: Check the admin page under the CSP.** Build the client (`npm run build` from the root, or the workspace script the Makefile uses). Start the server against a scratch `DATA_DIR`, with `SETUP_CODE` set and `PUBLIC_URL=http://localhost:3000`. Use a short Playwright script (`npx playwright` or the global CLI) that opens `http://localhost:3000/`, collects `console` and `pageerror` events, and screenshots the page. Expected: no message containing `Content Security Policy`, and the Create-your-library page renders styled. Then create a library through the page and click **Download kit**. Expected: the download fires and the console still shows no CSP violation.

- [ ] **Step 6: Write the README and CHANGELOG entries.**

- [ ] **Step 7: Commit** `feat(server): security headers and CSP on every response`
