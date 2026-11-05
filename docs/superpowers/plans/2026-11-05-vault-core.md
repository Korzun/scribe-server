# Vault Core — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Home Assistant add-on that stores a Scribe library as client-encrypted blobs, authenticates Macs as devices and the owner in a browser, keeps a change log, accepts resumable chunked uploads, and ships through the same CI and release pipeline as Bookplate — usable from a small test client before Scribe knows it exists.

**Architecture:** An Express 5 service over Prisma 7 on SQLite (`/data/db.sqlite`) with content-addressed ciphertext files under `/media/<library_dir>/blobs`. One REST surface at `/api/v1` serves both the Macs (device bearer tokens) and the admin SPA (JWT + refresh cookie). Every write to a blob appends a row to one library-wide change log. The server never derives, unwraps or sees a key: it stores salts, argon2 verifiers and wrapped Library Keys, and compares hashes. The admin SPA does the owner's key derivation in WebCrypto.

**Tech Stack:** Node 24, TypeScript 7, Express 5, Prisma 7 + `@prisma/adapter-better-sqlite3`, argon2, jsonwebtoken, React 19 + Vite 8 + react-jss + react-router 8, vitest 4 + supertest + Testing Library, oxlint + oxfmt, Docker multi-stage on `node:24-alpine`, `home-assistant/builder`.

**Spec:** `docs/superpowers/specs/2026-11-05-scribe-home-assistant-design.md` (§3 keys and blobs, §4 vault, §5 devices, §6 library and change log, §7 uploads, §9 kit and recovery, §13 testing, §14 build order). Plans 2–4 build on this one; §8 jobs and §10 MCP are **not** in this plan.

## Global Constraints

- **Bookplate is the template** (spec §1). Where this plan says "copy from Bookplate", copy the file from `/Users/korzun/Code/bookplate` verbatim, then substitute names (`bookplate`→`scribe`, `Bookplate`→`Scribe`) and delete what the vault has no use for. Keep Bookplate's comments where they still apply.
- Repository layout: npm workspaces `app/server` and `app/client`; root `package.json` scripts `build`, `start`, `dev`, `dev:client`, `test`, `lint`, `lint:fix`, `test:scripts` exactly as Bookplate's root `package.json`.
- Tooling verbatim from Bookplate: root `.oxfmtrc.json`; `app/server/.oxlintrc.json`; `app/server/tsconfig.json` (CommonJS, test files excluded) and `tsconfig.test.json`; `app/server/vite.config.ts` minus the `graphql` alias; `app/client/tsconfig.json`, `vite.config.ts` (proxy `/api` only), `src/setup.ts`. `npm run lint` at the root must run oxlint, oxfmt `--check`, and `tsc --noEmit` for both workspaces.
- Node `>=24` in every `engines`. Express `^5`, Prisma `^7` with the better-sqlite3 adapter, argon2 `^0.44`, vitest `^4`, React `^19.2`, Vite `^8`.
- Files and folders kebab-case; SQLite columns snake_case via `@map`; factories `createXRouter`/`createXStore` taking a typed `XDeps` object with an injectable `now: () => number` wherever time matters.
- Logger: `logger('Namespace')` with Bookplate's `[ISO] LEVEL [ns] msg` format. **No log line may contain a request body, a blob, a token, a key, a salt, a verifier, or a setup code.** Log ids, kinds, sizes, statuses and durations only (spec anti-goals).
- Crypto constants (spec §3): PBKDF2-HMAC-SHA256, **650 000** iterations, 32-byte output; HKDF-SHA256 info strings `scribe/v1/secret-key`, `scribe/v1/kek`, `scribe/v1/auth`; AES-256-GCM, 12-byte nonce, 16-byte tag; blob header `"SCRB"` + version byte `1`; AAD strings `/`-joined UTF-8. Secret Key: 16 random bytes, shown `A1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX` (26 base32 chars, RFC 4648 alphabet, no padding). Recovery code: 10 random bytes shown as 16 base32 chars.
- Limits (spec §4, §6, §7): direct blob `PUT` body ≤ **32 MiB**; upload part size default **16 MiB**, maximum 64 MiB; change-log page `limit` default 500, max 1000; grace period for tombstoned meetings and abandoned uploads **7 days**; access JWT **15 min**, refresh token **30 days**; login-class routes rate-limited at **10 per minute per IP**, keys-lost deletion at **5 per hour per IP**.
- Blob kinds (spec §6): meeting kinds `manifest`, `transcript`, `diarization`, `labels`, `inferences`, `summary`, `tags`, `markdown`, `audio-mic`, `audio-system`; library kinds `tag-list` and `voice/<uuid>`.
- JSON binary fields are **base64** strings; hashes are lowercase hex; ids are UUIDs (meetings, library, voices) or 21-char nanoid (devices, uploads, recovery codes).
- Add-on arches: `aarch64`, `amd64`. Image `ghcr.io/korzun/scribe-{arch}`, slug `scribe`, port 3000.
- Commits: Conventional Commits with scopes `server`, `client`, `build`, `ci`, `docs`; lower-case behavioural subjects; prose body saying why.
- Comments: heavy, in Bookplate's register. Doc comments say why and cite the spec section.

## Review Focus

Inputs the spec implies but names no test for, most likely to bite first. Each has a test pinned in the owning task.

1. **A body that is not what its header claims.** A `PUT` whose bytes do not hash to `X-Scribe-Sha256`, or whose first five bytes are not `SCRB\x01`, must be refused with 400 and leave no file, row or change behind. (Task 8)
2. **A proxy's HTML error page arriving as a request body.** HTML where JSON was expected must be a 400, never a 500 or a crash. Bookplate's error handler already does this; the test proves the vault kept it. (Task 2)
3. **A path-shaped library kind.** `voice/../x`, `voice/not-a-uuid`, an empty kind, or a meeting id that is not a UUID must be 400/404 and must never touch the filesystem. (Task 9)
4. **Two writers, one revision.** Two concurrent `PUT`s to the same kind with the same `If-Match` must yield exactly one 200 and one 409, one blob row, one change row. (Task 8)
5. **A revoked device mid-flight.** A device revoked while it has an open upload session must get 401 on its next part and on `complete`, and the session must not produce a blob. (Task 10)

---

### Task 1: Workspace scaffold, config and logger

**Files:**
- Create: `package.json`, `.gitignore`, `.oxfmtrc.json`, `app/server/package.json`, `app/server/tsconfig.json`, `app/server/tsconfig.test.json`, `app/server/.oxlintrc.json`, `app/server/vite.config.ts`, `app/server/logger.ts`, `app/server/__mocks__/logger.ts`, `app/server/config.ts`, `app/server/types.ts`
- Test: `app/server/config.test.ts`, `app/server/logger.test.ts`

**Interfaces:**
- Produces: `loadConfig(): AppConfig` with `AppConfig = { dataDir: string; blobsDir: string; port: number; publicUrl: string | null; trustProxyHops: number; logLevel: string }`; `readSetupCode(dataDir: string): string | null` — re-reads `options.json` **on every call**, returns the trimmed `setup_code` or `null` when missing/blank (spec §4: live, never cached); `logger(ns)` as Bookplate.

- [ ] **Step 1: Scaffold the workspaces.** Copy Bookplate's root `package.json` (drop `sharp`, `overrides`, `allowScripts` entries for sharp/esbuild/fsevents; keep argon2, better-sqlite3, prisma ones), `.oxfmtrc.json`, `.gitignore`; `app/server/package.json` with only: express, cookie-parser, argon2, better-sqlite3, @prisma/client, @prisma/adapter-better-sqlite3, jsonwebtoken, nanoid, zod and the matching dev deps (types, nodemon, tsx, prisma, supertest, vitest, oxlint, oxfmt, typescript). Scripts as Bookplate's minus the graphql ones. Run `npm install` at the root.
- [ ] **Step 2: Copy `logger.ts`, `__mocks__/logger.ts`, `logger.test.ts`** from Bookplate unchanged.
- [ ] **Step 3: Write `config.test.ts`** — `describe('loadConfig')`: `resolves blobsDir under /media/<library_dir>/blobs` (options `{library_dir:'scribe'}` → `/media/scribe/blobs`); `falls back to /media/scribe/blobs when library_dir escapes /media` (`'../etc'`); `env BLOBS_DIR overrides options.json`; `publicUrl is null unless an absolute http(s) origin` (reuse Bookplate's `parsePublicUrl` cases). `describe('readSetupCode')`: `returns null when options.json is absent`; `returns null when setup_code is blank`; `reflects a change to options.json on the next call without restart` (write file, call, rewrite, call again).
- [ ] **Step 4: Run** `npx vitest run config.test.ts -w app/server` → FAIL (module not found).
- [ ] **Step 5: Implement `config.ts`** following Bookplate's `loadConfig` shape (defaults, `options.json` overlay at `${DATA_DIR ?? '/data'}/options.json`, env overrides `DATA_DIR`, `BLOBS_DIR`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY_HOPS`, `LOG_LEVEL`). Options type: `{ library_dir: string; public_url: string; trust_proxy_hops: number; setup_code: string; log_level: string }`. Copy `parseTrustProxyHops` and `parsePublicUrl` verbatim. `readSetupCode` is a separate exported function that opens the file each time.
- [ ] **Step 6: Run the tests** → PASS. Run `npm run lint` → clean.
- [ ] **Step 7: Commit** `build: scaffold the server workspace with config and logger`.

### Task 2: Database, migrations, server skeleton and status

**Files:**
- Create: `app/server/db/client.ts`, `app/server/db/migrate.ts`, `app/server/prisma/schema.prisma`, `app/server/prisma.config.ts`, `app/server/prisma/migrations/0000_baseline/migration.sql`, `app/server/server.ts`, `app/server/startup.ts`, `app/server/index.ts`, `app/server/middleware/request-log.ts`, `app/server/middleware/timeout.ts`, `app/server/routes/status.ts`, `app/server/utils/app-version.ts`, `app/server/utils/server-root.ts`, `app/server/test-support/harness.ts`
- Test: `app/server/routes/status.test.ts`, `app/server/startup.test.ts`, `app/server/server.test.ts`

**Interfaces:**
- Produces: `createPrismaClient(url)`, `runMigrations(prisma)` (Bookplate's SQL runner with the EPUB-specific data migrations removed); `createServer(deps: CreateServerDeps): express.Express` with `CreateServerDeps = { config: AppConfig; prisma: PrismaClient; jwtSecret: Buffer; now?: () => number }` (Task 8 adds `blobStore`, Task 10 adds `uploads`; each later task lists what it adds); `startVault(deps)`; `createHarness(): Promise<Harness>` with `Harness = { app: express.Express; prisma: PrismaClient; config: AppConfig; dataDir: string; blobsDir: string; now: { value: number }; close(): Promise<void> }` — real temp dirs via `mkdtempSync`, a real migrated SQLite file, `now` a mutable fake clock every dep reads.
- Schema at this task: `Setting { key @id, value }`, `RefreshToken { tokenHash @id, expiresAt Float }` with `@@map("settings")`, `@@map("refresh_tokens")`.

- [ ] **Step 1: Write `status.test.ts`** — `GET /api/v1/status returns libraryExists:false and the app version on a fresh database` (`expect(res.body).toEqual({ libraryExists: false, version: expect.any(String) })`); `server.test.ts`: `an HTML body on a JSON route is a 400, not a 500` (POST `/api/v1/status` with `Content-Type: application/json` and body `<html>error</html>` → 400, body `{ error: 'Invalid request body' }`) — Review Focus 2; `an unknown /api path is a JSON 404` (`{ error: 'Not found' }`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Copy from Bookplate** `db/client.ts`, `db/migrate.ts` (keep `applyPendingMigrations` and `runDataMigration`; delete every book/user data migration and their imports), `prisma.config.ts`, `middleware/request-log.ts`, `middleware/timeout.ts`, `utils/server-root.ts`, `utils/app-version.ts`. Write `schema.prisma` and the baseline SQL by hand (two tables).
- [ ] **Step 4: Implement `server.ts`** in Bookplate's order: `requestTimeout(90_000)`, `requestLog()`, `express.json()`, `express.urlencoded`, `cookieParser()`, `/api/v1/status` router, a JSON 404 for `/api/{*splat}`, then Bookplate's error handler verbatim. (The SPA catch-all comes in Task 12.) `routes/status.ts`: `createStatusRouter({ prisma, version })` answering `{ libraryExists: (await prisma.library.count()) > 0, version }` — until Task 4 adds the `library` table, answer `false` from a `settings` lookup of key `library_id`; Task 4 replaces it.
- [ ] **Step 5: Implement `startup.ts`/`index.ts`** as Bookplate's minus books: mkdir `dataDir` and `blobsDir`, migrate, `getOrCreateJwtSecret` (Task 6 supplies it; stub a `Buffer` here), SIGTERM/SIGINT shutdown, `listen` with the error callback, startup log `Scribe vault v… starting — port, blobsDir, dataDir`. `startup.test.ts`: `listen failure logs and exits 1` as Bookplate's.
- [ ] **Step 6: Implement `test-support/harness.ts`.**
- [ ] **Step 7: Run all tests** → PASS. Commit `feat(server): boot the vault with a migrated database and a status route`.

### Task 3: Crypto primitives and the shared test vectors

**Files:**
- Create: `app/server/crypto/seal.ts`, `app/server/crypto/kdf.ts`, `app/server/crypto/codes.ts`, `scripts/generate-vectors.mjs`, `test/vectors/scribe-crypto-v1.json`
- Test: `app/server/crypto/seal.test.ts`, `app/server/crypto/kdf.test.ts`, `app/server/crypto/codes.test.ts`, `scripts/generate-vectors.test.mjs`

**Interfaces:**
- Produces (Node, used by tests, the CLI, and plan 2's MCP decryption):
  - `seal(key: Buffer, plaintext: Buffer, aad: string, nonce?: Buffer): Buffer` → `SCRB` `0x01` nonce(12) ciphertext tag(16); `open(key, blob, aad): Buffer` throws `SealError('bad_magic' | 'bad_version' | 'auth_failed')`; `isSealed(bytes: Buffer): boolean` checks the first five bytes only; `SEAL_HEADER_LENGTH = 17`.
  - `deriveAccountKeys({ secret: Buffer /* password or recovery code bytes */, secretKey: Buffer, salt: Buffer }): { auk: Buffer; kek: Buffer; authKey: Buffer }` per spec §3; `PBKDF2_ITERATIONS = 650_000`.
  - `formatSecretKey(bytes16: Buffer): string`, `parseSecretKey(text: string): Buffer | null` (accepts any dash/space placement, any case; requires the `A1` version); `generateSecretKey(): Buffer`; `formatRecoveryCode(bytes10)`, `parseRecoveryCode(text)`, `generateRecoveryCode()`.
  - `keyWrapAad(libraryId: string, slot: 'password' | 'recovery'): string` = `` `${libraryId}/keys/${slot}` ``; `blobAad(libraryId, scope: string /* meetingId or 'library' */, kind: string, revision: number): string`.
- The vectors file is the contract with Scribe's Swift tests and plan 2's browser code.

- [ ] **Step 1: Write `seal.test.ts`**: `round-trips with a random nonce`; `rejects a flipped ciphertext byte with auth_failed`; `rejects the right key under a different aad`; `rejects bad magic and a version other than 1`; `isSealed is true for sealed output and false for JSON text`. `kdf.test.ts`: `two different secret keys give different authKey for the same password and salt`; `authKey and kek differ`. `codes.test.ts`: `formatSecretKey produces A1- and 26 base32 chars in 5-5-5-5-6 groups`; `parseSecretKey accepts lowercase and no dashes`; `parseSecretKey rejects a wrong version prefix and a wrong length`; `recovery code is 16 base32 chars and round-trips`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** with `node:crypto` (`pbkdf2Sync`, `hkdfSync`, `createCipheriv('aes-256-gcm')`). **Step 4: Run** → PASS.
- [ ] **Step 5: Write `scripts/generate-vectors.mjs`** (plain Node, imports nothing from `app/`): fixed inputs — password `correct horse battery staple`, secret key bytes `00112233445566778899aabbccddeeff`, password salt 16 bytes `0x01..0x10`, recovery salt `0x11..0x20`, recovery code bytes `0x21..0x2a`, library id `3f2b1c4e-9d8a-4f6b-8c7d-5e4f3a2b1c0d`, library key `0x40..0x5f`, nonce `0x60..0x6b`, a 64-byte plaintext `0x00..0x3f`. Output: every intermediate (`kPw`, `kSk`, `auk`, `kek`, `authKey`) for password and for the recovery code, the password wrap and recovery wrap of the library key under their AADs, a sealed blob under `blobAad(libraryId, meetingId, 'transcript', 1)` with `meetingId = 7a1e…`, the formatted secret key and recovery code. Hex everywhere, `version: 1`, `iterations: 650000`.
- [ ] **Step 6: Write `generate-vectors.test.mjs`** (node:test): `the committed vectors file equals a fresh generation` (so a drift in either fails CI). Add `kdf.test.ts` case `matches the committed vectors` asserting every intermediate against `test/vectors/scribe-crypto-v1.json`, and `seal.test.ts` case `seals the vector plaintext to the vector ciphertext with the fixed nonce`.
- [ ] **Step 7: Generate the file, run all** → PASS. Commit `feat(server): seal, key derivation and the shared crypto vectors`.

### Task 4: Library creation, setup code, devices and the device auth

**Files:**
- Create: `app/server/prisma/migrations/0001_library_devices/migration.sql`, `app/server/services/library.ts`, `app/server/services/device.ts`, `app/server/middleware/device-auth.ts`, `app/server/middleware/rate-limit.ts`, `app/server/routes/library.ts`, `app/server/test-support/vault-client.ts`
- Modify: `schema.prisma`, `server.ts`, `routes/status.ts`
- Test: `services/library.test.ts`, `services/device.test.ts`, `routes/library.test.ts`, `middleware/rate-limit.test.ts`

**Interfaces:**
- Schema: `Library { id String @id; createdAt Float; passwordSalt Bytes; recoverySalt Bytes; authVerifier String; passwordWrap Bytes }` (`libraries`); `RecoveryCode { id @id; libraryId; authVerifier String; wrap Bytes; usedAt Float? }` (`recovery_codes`); `Device { id @id; libraryId; name; tokenHash @unique; createdAt Float; lastSeenAt Float?; revokedAt Float? }` (`devices`).
- Produces: `createLibrary(prisma, input: CreateLibraryInput): Promise<{ libraryId }>` where `CreateLibraryInput = { libraryId: string; passwordSalt: Buffer; recoverySalt: Buffer; authKey: Buffer; passwordWrap: Buffer; recoveryCodes: Array<{ authKey: Buffer; wrap: Buffer }> }` — argon2id-hashes each `authKey`, refuses (`LibraryExistsError`) when a row exists, all in one transaction; `getLibrary(prisma)`; `verifyOwner(prisma, authKey): Promise<boolean>`. `issueDeviceToken(prisma, { libraryId, name, now }): Promise<{ deviceId, token }>` (32 random bytes base64url, sha256 stored); `authenticateDevice(prisma, token, now): Promise<{ deviceId } | null>` (null when unknown or revoked; bumps `lastSeenAt` at most once per 60 s); `deviceAuth(deps)` middleware setting `req.device = { id }`; `createIpRateLimit({ max, windowMs, trustProxyHops, now })` extracted from Bookplate's `routes/ui.ts` factory.
- Routes (`createLibraryRouter({ prisma, config, now })`):
  - `GET /api/v1/library/salts` → `{ passwordSalt, recoverySalt }` or 404 `{ error: 'No library' }`; rate 60/min.
  - `POST /api/v1/library` body `{ setupCode, libraryId, passwordSalt, recoverySalt, authKey, passwordWrap, recoveryCodes: [{authKey, wrap}], device: { name } }` → 201 `{ libraryId, deviceId, deviceToken }`; 403 `{ error: 'Setup code required' }` when `readSetupCode()` is null, 403 `{ error: 'Wrong setup code' }` on mismatch (timing-safe compare), 409 `{ error: 'Library exists' }`, 400 on shape (zod). Rate 10/min.
- `VaultClient` (test-support, grows each task): `new VaultClient(app)`; `status()`, `salts()`, `createLibrary(input)`, each returning `{ status, body }`; a helper `createOwner(client, { setupCode })` that generates real keys with `crypto/` and returns `{ libraryId, secretKey, password, libraryKey, deviceToken }` — every later route test starts here.

- [ ] **Step 1: Write `routes/library.test.ts`**: `creating a library without setup_code configured is 403`; `creating with the wrong setup code is 403 and stores nothing`; `creating with the right code returns a device token and status flips to libraryExists:true`; `a second creation is 409`; `salts are readable without auth once a library exists`; `the setup code is re-read: changing options.json between two attempts changes the outcome`. `services/device.test.ts`: `a revoked device token no longer authenticates`; `lastSeenAt is bumped on use but not more than once a minute` (fake clock). `rate-limit.test.ts`: port Bookplate's limiter tests (window expiry admits again; sweep bounded).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** the migration, services, middleware, router; mount under `/api/v1` in `server.ts`; make `routes/status.ts` read `prisma.library.count()`. **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(server): create the library behind the setup code and issue the first device token`.

### Task 5: Enrolling and managing devices

**Files:**
- Create: `app/server/routes/devices.ts`, `app/server/middleware/owner-auth.ts`
- Modify: `services/device.ts`, `test-support/vault-client.ts`, `server.ts`
- Test: `routes/devices.test.ts`

**Interfaces:**
- Routes (`createDevicesRouter({ prisma, config, now })`):
  - `POST /api/v1/devices` body `{ authKey, name }` (no auth; rate 10/min) → 201 `{ deviceId, deviceToken, libraryId, passwordSalt, passwordWrap }`; 401 `{ error: 'Invalid credentials' }`.
  - `GET /api/v1/devices` (owner auth — device **or** session; until Task 6 only device) → `{ devices: [{ id, name, createdAt, lastSeenAt, revokedAt, isCurrent }] }`.
  - `PATCH /api/v1/devices/:id` body `{ name }` → 200; `DELETE /api/v1/devices/:id` → 204 sets `revokedAt` (idempotent; a device may revoke itself).
- `ownerAuth(deps)` middleware in `middleware/owner-auth.ts`: accepts a device bearer; Task 6 teaches it JWTs. Sets `req.owner = { via: 'device', deviceId } | { via: 'session' }`.
- `VaultClient.enrol({ password, secretKey, name })` derives `authKey` from `salts()` and returns the device token; `devices()`, `renameDevice`, `revokeDevice`.

- [ ] **Step 1: Write `routes/devices.test.ts`**: `enrolling with the right password and secret key returns the wrapped library key the first Mac stored` (unwrap it with `kek` in the test and compare to the owner's `libraryKey`); `a wrong secret key with the right password is 401`; `the device list marks the caller as current`; `a revoked device is listed with revokedAt and its token is 401 on the next call`; `enrolment is rate limited at the eleventh attempt in a minute`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(server): enrol further Macs and manage devices`.

### Task 6: Browser sessions

**Files:**
- Create: `app/server/services/jwt.ts`, `app/server/services/token.ts`, `app/server/routes/session.ts`
- Modify: `middleware/owner-auth.ts`, `startup.ts`/`index.ts` (real `getOrCreateJwtSecret`), `vault-client.ts`
- Test: `routes/session.test.ts`, `services/token.test.ts`

**Interfaces:**
- Copy Bookplate's `services/jwt.ts` and `services/token.ts`, reducing `AuthUser` to `{ owner: true }` and `RefreshIdentity` to `{}`; keep `hashToken`, `createRefreshToken`, `consumeRefreshToken` (atomic `DELETE … RETURNING`), `deleteExpired`, `ACCESS_TOKEN_TTL_SECONDS = 15*60`, `REFRESH_TOKEN_TTL_MS = 30 days`.
- Routes (`createSessionRouter({ prisma, jwtSecret, config, now })`): `POST /api/v1/session` body `{ authKey }` (rate 10/min) → `{ accessToken }` + `refresh_token` httpOnly SameSite=strict cookie scoped to `/api/v1/session`; `POST /api/v1/session/refresh`; `POST /api/v1/session/logout`. Copy Bookplate's `issueTokens`/`clearRefreshCookie` shape.
- `ownerAuth` now: a bearer containing a `.` is verified as a JWT; otherwise as a device token.
- `VaultClient.login({ password, secretKey })` keeps the access token and cookie jar for subsequent calls via `asSession()`.

- [ ] **Step 1: Write tests**: `login with the right authKey returns an access token and sets the refresh cookie`; `a wrong authKey is 401`; `refresh rotates: the old refresh token is rejected on reuse`; `the device list is readable with a session token`; `an expired access token is 401` (fake clock + jwt `exp`).
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(server): sign the owner in from a browser`.

### Task 7: Library info, password change, recovery codes and recovery

**Files:**
- Modify: `services/library.ts`, `routes/library.ts`, `vault-client.ts`
- Create: `app/server/routes/recovery.ts`
- Test: `routes/library.test.ts` (extend), `routes/recovery.test.ts`

**Interfaces:**
- `GET /api/v1/library` (owner) → `{ id, createdAt, passwordSalt, recoverySalt, passwordWrap, recoveryCodesRemaining, storage: { blobBytes: 0, blobCount: 0, meetingCount: 0, deletedMeetingCount: 0 } }` (storage filled by Task 9).
- `PUT /api/v1/library/password` (owner) body `{ authKey, newPasswordSalt, newAuthKey, newPasswordWrap }` → 204; 401 on a wrong current `authKey`. Swaps salt, verifier and wrap in one transaction. **Does not touch devices or refresh tokens** (spec §3: the password guards the key, the token guards the door).
- `PUT /api/v1/library/recovery-codes` (owner) body `{ authKey, recoverySalt, codes: [{ authKey, wrap }] }` → `{ ids }`; replaces all existing codes in one transaction; exactly 10 required.
- `POST /api/v1/recovery` (no auth; rate 10/min) body `{ authKey }` → `{ recoveryId, wrap }` for the first unused code whose verifier matches; 401 otherwise. `POST /api/v1/recovery/:id/password` body `{ authKey, newPasswordSalt, newAuthKey, newPasswordWrap }` → 204; marks the code used, swaps the password material; 401 if the code is used or the key does not match.
- `VaultClient.libraryInfo()`, `changePassword(...)`, `regenerateRecoveryCodes(...)`, `recover({ code, secretKey, newPassword })`.

- [ ] **Step 1: Write tests**: `after a password change the old authKey is 401 and the new one logs in`; `after a password change the existing device token still works` (spec §3); `after a password change the new wrap unwraps to the same library key`; `a recovery code unwraps the library key and sets a new password`; `a used recovery code is 401 the second time`; `recovery leaves device tokens valid`; `regenerating replaces all ten codes and old codes stop working`; `regenerating with nine codes is 400`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(server): change the password, and recover it with a code`.

### Task 8: Blob store, meeting blobs and the change log

**Files:**
- Create: `app/server/prisma/migrations/0002_blobs_changes/migration.sql`, `app/server/services/blob-store.ts`, `app/server/services/blob-kinds.ts`, `app/server/services/keyed-lock.ts`, `app/server/services/change-log.ts`, `app/server/services/blobs.ts`, `app/server/routes/meetings.ts`, `app/server/routes/changes.ts`
- Modify: `schema.prisma`, `server.ts` (`CreateServerDeps` gains `blobStore: BlobStore`), `index.ts` (construct the blob store at `config.blobsDir`), `test-support/harness.ts` (a blob store on the temp dir), `vault-client.ts`
- Test: `services/blob-store.test.ts`, `services/blobs.test.ts`, `routes/meetings.test.ts`, `routes/changes.test.ts`

**Interfaces:**
- Schema: `Meeting { id @id; createdAt Float; deletedAt Float?; purgeAfter Float? }` (`meetings`); `Blob { scope String /* meeting id or 'library' */; kind String; revision Int; sha256 String; size Int; deviceId String?; updatedAt Float; @@id([scope, kind]) }` (`blobs`); `Change { seq Int @id @default(autoincrement()); meetingId String?; kind String; revision Int; sha256 String?; size Int?; deleted Boolean; deviceId String?; at Float }` (`changes`), index on `seq`.
- `createBlobStore({ root }): BlobStore` with `put(bytes: Buffer): Promise<{ sha256, size }>` (writes `<root>/<aa>/<sha>` via temp file + rename; idempotent), `putStream(source: Readable, expectedSha256): Promise<{ sha256, size }>` (hashes while writing; throws `HashMismatchError` and removes the temp), `createReadStream(sha256)`, `remove(sha256)`, `exists(sha256)`, `totalBytes()`.
- `blob-kinds.ts`: `MEETING_KINDS`, `isMeetingKind(s)`, `parseLibraryKind(s): { kind: 'tag-list' } | { kind: 'voice', voiceId } | null` (strict UUID, no other shapes), `isUuid(s)`.
- `keyed-lock.ts`: `withKeyLock<T>(key: string, fn: () => Promise<T>): Promise<T>` — in-process serialization per `scope/kind`.
- `services/blobs.ts`: `putBlob(deps, { scope, kind, bytes | stream, sha256, size, ifMatch: number | null /* null = If-None-Match: * */, deviceId }): Promise<PutResult>` where `PutResult = { ok: true; revision; seq; sha256 } | { ok: false; reason: 'conflict'; currentRevision } | { ok: false; reason: 'gone' }`; inside the key lock: check revision, store file, then one `$transaction([blob upsert, change create, meeting upsert])`; unlink the previous sha only if no other `Blob` row references it. `getBlob(deps, scope, kind): Promise<{ revision, sha256, size, stream } | null>`.
- `change-log.ts`: `appendChange(tx, row)`, `listChanges(prisma, { since, limit }): Promise<{ changes: ChangeRow[]; nextSince: number; hasMore: boolean }>` with `ChangeRow = { seq, meetingId: string|null, kind, revision, sha256: string|null, size: number|null, deleted: boolean, deviceId: string|null, at: string /* ISO */ }`.
- Routes (`createMeetingsRouter`, `createChangesRouter`, both owner auth):
  - `PUT /api/v1/meetings/:id/blobs/:kind` — `express.raw({ type: 'application/octet-stream', limit: '32mb' })`; headers `X-Scribe-Sha256` (required), `If-Match: <revision>` or `If-None-Match: *` (one required); 400 `{ error: 'Hash mismatch' }` / `{ error: 'Not a sealed blob' }` / unknown kind / bad UUID; 412 when neither precondition header is present; 409 `{ error: 'Revision conflict', currentRevision }`; 410 for a tombstoned meeting; 201/200 `{ revision, seq, sha256, size }`.
  - `GET /api/v1/meetings/:id/blobs/:kind` → bytes, `Content-Type: application/octet-stream`, `ETag: "<revision>"`, `X-Scribe-Sha256`; 304 on matching `If-None-Match`; 404.
  - `GET /api/v1/meetings?after=<id>&limit=` → `{ meetings: [{ id, createdAt, blobs: [{ kind, revision, sha256, size }] }], nextAfter }` (non-deleted only, ordered by id).
  - `GET /api/v1/meetings/:id` → one of the above or 404.
  - `GET /api/v1/changes?since=&limit=` → `listChanges` result.
- `VaultClient.putMeetingBlob({ meetingId, kind, bytes, ifMatch })` (computes the hash, seals nothing — tests pass already-sealed bytes made with `seal`), `getMeetingBlob`, `listMeetings`, `changes(since)`.

- [ ] **Step 1: Write tests.** `blob-store.test.ts`: `put is idempotent for identical bytes`; `putStream with a wrong expected hash leaves no file`. `routes/meetings.test.ts`: `first write needs If-None-Match and returns revision 1`; `second write with If-Match 1 returns revision 2 and a higher seq`; `stale If-Match is 409 with currentRevision`; `a body whose hash differs from X-Scribe-Sha256 is 400 and leaves no blob row, file or change` (Review Focus 1); `plaintext JSON is 400 Not a sealed blob`; `missing both precondition headers is 412`; `two concurrent PUTs with the same If-Match: one 200 and one 409, one change row` (Review Focus 4 — `Promise.all` of two supertest requests); `GET returns the bytes with ETag and 304 on If-None-Match`; `overwriting frees the old file unless another kind shares the hash`. `routes/changes.test.ts`: `changes page in seq order with nextSince and hasMore`; `limit above 1000 is clamped`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(server): store sealed meeting blobs and log every change`.

### Task 9: Library blobs, deletion, garbage collection and storage

**Files:**
- Create: `app/server/routes/library-blobs.ts`, `app/server/services/gc.ts`
- Modify: `services/blobs.ts`, `routes/meetings.ts`, `routes/library.ts` (storage + purge + keys-lost delete), `startup.ts`, `vault-client.ts`
- Test: `routes/library-blobs.test.ts`, `routes/meetings.test.ts` (extend), `services/gc.test.ts`, `routes/library.test.ts` (extend)

**Interfaces:**
- `PUT|GET /api/v1/library/blobs/{*kind}` with the same headers and codes as meeting blobs, scope `'library'`; `DELETE /api/v1/library/blobs/voice/:voiceId` → 204 and a `deleted: true` change row; `DELETE` of `tag-list` → 405.
- `DELETE /api/v1/meetings/:id` (owner) → 204; sets `deletedAt`, `purgeAfter = now + 7d`, appends one change `{ meetingId, kind: 'meeting', revision: 0, deleted: true }`; later `PUT`s → 410; `GET /api/v1/meetings` omits it; idempotent.
- `createGarbageCollector({ prisma, blobStore, uploads?, now, graceMs = 7 days })` with `sweep(): Promise<{ purgedMeetings, removedFiles, expiredUploads }>` — for each meeting past `purgeAfter`, delete its `Blob` rows and unreferenced files, keep the `Meeting` row (tombstone) and the change rows. `startVault` runs `sweep()` at boot and every hour; `stop()` on shutdown.
- `POST /api/v1/library/purge` (owner) → runs the sweep with `graceMs = 0` for deleted meetings → `{ purgedMeetings, removedFiles }`.
- `GET /api/v1/library` storage now real: `blobBytes` = sum of `Blob.size`, `blobCount`, `meetingCount` (not deleted), `deletedMeetingCount` (deleted, not yet purged).
- `DELETE /api/v1/library` (no auth; rate 5/hour) body `{ setupCode, confirm: 'DELETE' }` → 204: within one transaction deletes every row of every table except `settings`, then removes `blobsDir` contents; 403 on a missing/wrong setup code; 400 when `confirm` differs. Status returns `libraryExists: false` afterwards.
- `VaultClient.putLibraryBlob`, `getLibraryBlob`, `deleteVoice`, `deleteMeeting`, `purge`, `deleteLibrary({ setupCode })`.

- [ ] **Step 1: Write tests.** `library-blobs.test.ts`: `tag-list and voice/<uuid> round-trip with revisions`; `voice/../x, voice/not-a-uuid, and an empty kind are 400 and nothing is written under blobsDir` (Review Focus 3 — assert `readdirSync(blobsDir)` unchanged); `deleting a voice appends a deleted change and GET is 404`; `deleting tag-list is 405`. `meetings.test.ts`: `deleting a meeting tombstones it: one change row, PUT is 410, list omits it, delete again is 204`. `gc.test.ts`: `a meeting deleted six days ago keeps its files; seven days and one second later they are gone and the change rows remain`; `a file shared with a live blob survives the purge`. `library.test.ts`: `storage counts bytes, blobs, meetings and deleted meetings`; `keys-lost deletion needs the live setup code and the word DELETE, then status says no library`; `after deletion a new library can be created`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(server): library blobs, tombstones, purge and the keys-lost reset`.

### Task 10: Resumable chunked uploads

**Files:**
- Create: `app/server/prisma/migrations/0003_uploads/migration.sql`, `app/server/services/upload-session.ts`, `app/server/routes/uploads.ts`
- Modify: `schema.prisma`, `services/gc.ts`, `server.ts`, `vault-client.ts`
- Test: `services/upload-session.test.ts`, `routes/uploads.test.ts`

**Interfaces:**
- Schema: `Upload { id @id; deviceId; scope; kind; declaredSha256; declaredSize Int; partSize Int; ifMatch Int?; createdAt Float; expiresAt Float; completedAt Float? }` (`uploads`). Parts on disk at `<dataDir>/uploads/<id>/<n>`.
- `createUploadSessions({ prisma, dataDir, blobStore, now, ttlMs = 7 days })`: `begin({ deviceId, scope, kind, sha256, size, partSize? })`, `writePart(id, n, stream)` (refuses `n` beyond `ceil(size/partSize)`, refuses a part whose length is not `partSize` except the last), `inspect(id): { parts: number[], partSize, size, expiresAt }`, `complete(id): Promise<{ sha256, size, stream }>` (concatenates parts in order through `blobStore.putStream`, then `putBlob` with the session's precondition; removes the part dir on success; on hash mismatch returns 400 and keeps the parts), `abort(id)`, `expire(now)` called by `gc.sweep`.
- Routes (`createUploadsRouter`, owner auth, **device only** — a browser never uploads):
  - `POST /api/v1/uploads` body `{ meetingId: string | null, kind, size, sha256, partSize?, ifMatch: number | null }` → 201 `{ uploadId, partSize, expiresAt }`. Any size is accepted: a client may chunk a small blob too. 400 on an unknown kind, a non-UUID `meetingId`, or a `partSize` outside 1 MiB–64 MiB.
  - `PUT /api/v1/uploads/:id/parts/:n` raw body (limit `partSize`) → 204; `GET /api/v1/uploads/:id` → `inspect`; `POST /api/v1/uploads/:id/complete` → the `PutResult` codes of Task 8 (`201/200`, `409`, `410`, `400 Hash mismatch`, `400 Not a sealed blob`); `DELETE /api/v1/uploads/:id` → 204. 404 for another device's session.
- `VaultClient.upload({ meetingId, kind, bytes, partSize, ifMatch })` performing the whole dance, plus the low-level `beginUpload`, `putPart`, `inspectUpload`, `completeUpload`.

- [ ] **Step 1: Write tests**: `three parts out of order then complete yields one blob and one change`; `inspect lists the parts received so a client can resume`; `completing with a missing part is 409 Incomplete and lists the missing parts`; `completing with a wrong declared hash is 400, the parts remain, and no blob exists`; `the first five bytes are checked on complete: plaintext is 400 Not a sealed blob`; `a session older than seven days is removed by the sweep with its parts`; `a device revoked after begin gets 401 on the next part and on complete, and no blob exists` (Review Focus 5); `another device cannot see or complete the session`; `a session token is refused for upload routes`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(server): resumable chunked uploads that become blobs only when the hash agrees`.

### Task 11: Admin client scaffold, crypto in the browser, sign-in

**Files:**
- Create: `app/client/package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.tsx`, `src/App.tsx`, `src/setup.ts`, `src/test-utils.tsx`, `src/provider/{theme,toast,auth,index.ts}`, `src/component/{page,card,card-row,empty-state,index.ts}`, `src/control/{button,text-input,confirm-modal,switch,index.ts}`, `src/router/{index.ts,component.tsx,path.ts,path-internal.ts,protected-route.tsx,unprotected-route.tsx}`, `src/lib/{api.ts,token.ts,kdf.ts,seal.ts,codes.ts,secret-key-store.ts}`, `src/page/{login,loading,index.ts}`
- Modify: `app/server/server.ts` (serve `client/dist` with Bookplate's `serveSpa` and `express.static`, `/api` 404 before the catch-all)
- Test: `src/lib/kdf.test.ts`, `src/lib/seal.test.ts`, `src/lib/codes.test.ts`, `src/lib/api.test.ts`, `src/page/login/index.test.tsx`, `src/provider/auth/provider.test.tsx`, `app/server/server.test.ts` (extend: SPA catch-all)

**Interfaces:**
- Copy from Bookplate: `provider/theme` (whole folder), `provider/toast`, `provider/index.ts` (`buildProvidersTree`), `component/page`, `component/card`, `component/card-row`, `component/empty-state`, `control/button`, `control/text-input`, `control/confirm-modal`, `control/switch`, `lib/token.ts` (claims reduced to `{ owner: true; exp }`), `router/protected-route.tsx`, `router/unprotected-route.tsx`, `test-utils.tsx` (drop Apollo), `setup.ts` plus `globalThis.crypto = require('node:crypto').webcrypto` so WebCrypto exists under jsdom.
- `lib/api.ts`: `api<T>(path, init?): Promise<ApiResult<T>>` — attaches the bearer, on 401 calls `POST /api/v1/session/refresh` once and retries; `ApiResult<T> = { ok: true; status; body: T } | { ok: false; status; error: string }`.
- `lib/kdf.ts` (WebCrypto): `deriveAccountKeys({ secret: Uint8Array, secretKey: Uint8Array, salt: Uint8Array }): Promise<{ auk, kek, authKey }>` — same bytes as the server's. `lib/seal.ts`: `seal`, `open`, same format. `lib/codes.ts`: `parseSecretKey`, `formatSecretKey`, `generateSecretKey`, `generateRecoveryCode`, `formatRecoveryCode`, `parseRecoveryCode`, `keyWrapAad`. `lib/secret-key-store.ts`: `rememberSecretKey(text)`, `recallSecretKey(): string | null`, `forgetSecretKey()` over `localStorage['scribe:secret-key']` (spec §10: remembered per browser).
- `provider/auth`: `useAuth(): { signedIn: boolean; signIn(accessToken): void; signOut(): Promise<void> }` from `lib/token.ts` as Bookplate's.
- Pages: `LoginPage` — fields Password and Secret Key (pre-filled from the store, with "Forget this key on this browser"); derives `authKey` from `GET /api/v1/library/salts`; `POST /api/v1/session`; remembers the Secret Key on success. When `GET /api/v1/status` says `libraryExists: false`, the page shows "Nothing here yet — create your library from Scribe on your Mac" instead of the form. Links: "Forgot password" → `/recover`, "Lost everything" → `/reset` (pages in Task 13).
- Router paths: `login()`, `home()`, `recover()`, `reset()`.

- [ ] **Step 1: Write tests**: `kdf.test.ts` `matches the committed vectors` (same assertions as the server's); `seal.test.ts` `opens the vector blob and the vector password wrap`; `codes.test.ts` mirrors the server's; `api.test.ts` `a 401 triggers one refresh and a retry, a second 401 signs out`; `login/index.test.tsx`: `shows the create-from-Scribe message when no library exists`; `derives the auth key and posts it, remembering the secret key on success` (mock `fetch`; assert the posted `authKey` equals the vector `authKey` for the vector inputs); `a wrong secret key format shows an inline error and posts nothing`. `server.test.ts`: `GET / serves the SPA shell when client/dist exists and a 503 message when it does not`.
- [ ] **Step 2–4: FAIL → implement → PASS.** `npm run build` at the root must produce `app/client/dist`. **Step 5: Commit** `feat(client): the admin page signs the owner in with password and secret key`.

### Task 12: Dashboard — devices and storage

**Files:**
- Create: `src/page/dashboard`, `src/component/device-list`, `src/component/device-row`, `src/component/storage-card`, `src/lib/format.ts` (bytes, relative time)
- Modify: `src/router/component.tsx`, `src/page/index.ts`
- Test: `src/page/dashboard/index.test.tsx`, `src/component/device-list/index.test.tsx`, `src/component/storage-card/index.test.tsx`

**Interfaces:**
- `DashboardPage` (protected, `home()`): a `Page` with header "Scribe vault", a sign-out button, and three cards: **Storage** (`storage-card`: blob bytes humanised, blob count, meetings, deleted-awaiting-purge with an "Empty now" button → `POST /api/v1/library/purge` behind `ConfirmModal`), **Devices** (`device-list`: rows with name (editable inline → `PATCH`), enrolled date, last seen relative, a Revoke button behind `ConfirmModal` → `DELETE`; revoked rows greyed with "Revoked"), **Security** (placeholder card filled in Task 13). Data from `GET /api/v1/library` and `GET /api/v1/devices`, refetched after each mutation.

- [ ] **Step 1: Write tests**: `renders storage numbers and the device rows from the API`; `revoking asks for confirmation and calls DELETE then refetches`; `a revoked device cannot be renamed`; `Empty now is disabled when nothing awaits purge`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(client): a dashboard of storage and devices`.

### Task 13: Security card, recovery and reset pages

**Files:**
- Create: `src/component/security-card`, `src/control/password-prompt-modal`, `src/control/codes-sheet` (shows ten codes with Copy and Download `.txt`), `src/page/recover`, `src/page/reset`, `src/lib/account.ts`
- Modify: `src/page/dashboard`, `src/router/component.tsx`, `src/page/index.ts`
- Test: `src/lib/account.test.ts`, `src/component/security-card/index.test.tsx`, `src/page/recover/index.test.tsx`, `src/page/reset/index.test.tsx`

**Interfaces:**
- `lib/account.ts` — the browser-side flows, pure over `api` and the crypto libs so they test without React:
  - `changePassword({ currentPassword, newPassword, secretKey }): Promise<ApiResult<void>>` — salts → derive current → `GET /api/v1/library` → `open(kek, passwordWrap)` → new salt (16 random bytes) → derive new → `seal(newKek, libraryKey, keyWrapAad(id,'password'))` → `PUT /api/v1/library/password`.
  - `regenerateRecoveryCodes({ password, secretKey }): Promise<ApiResult<string[]>>` — unwrap as above, new recovery salt, ten codes, ten wraps under `keyWrapAad(id,'recovery')` → `PUT /api/v1/library/recovery-codes`; returns the formatted codes **once**.
  - `recover({ code, secretKey, newPassword }): Promise<ApiResult<void>>` — salts → derive from the code with `recoverySalt` → `POST /api/v1/recovery` → `open(kekRc, wrap)` → new password material → `POST /api/v1/recovery/:id/password`.
  - `resetLibrary({ setupCode }): Promise<ApiResult<void>>` → `DELETE /api/v1/library` with `confirm: 'DELETE'`.
- `security-card`: "Change password" (opens `password-prompt-modal` for current + new + confirm), "Recovery codes: N remaining · Regenerate" (prompts for the password, then shows `codes-sheet` with the warning that old codes stopped working), "Secret Key" row showing the remembered key masked with Reveal/Copy and "Forget on this browser".
- `RecoverPage` (unprotected, `/recover`): recovery code, Secret Key (pre-filled from the store), new password twice → `recover` → toast → `/login`. The page text includes, verbatim: "A recovery code needs your Secret Key. Without the Secret Key nothing can recover this library." (spec §9).
- `ResetPage` (unprotected, `/reset`): explains in the spec's words that the vault cannot help without the Secret Key; field for the setup code from Home Assistant; `ConfirmModal` requiring the word DELETE → `resetLibrary` → `/login` showing the create-from-Scribe state.

- [ ] **Step 1: Write tests**: `account.test.ts` against a mocked `fetch` that implements the five endpoints with the vector material: `changePassword posts a wrap that opens to the same library key under the new kek`; `regenerateRecoveryCodes posts ten wraps that each open to the library key under their code`; `recover unwraps with the code and posts new password material`; `a wrong secret key fails before any write is posted`. Component tests: `security-card regenerates and shows the codes once`; `recover page refuses mismatched passwords and never posts`; `reset page requires DELETE typed and the setup code`.
- [ ] **Step 2–4: FAIL → implement → PASS.** **Step 5: Commit** `feat(client): change the password, regenerate recovery codes, recover and reset`.

### Task 14: Packaging — add-on config, Docker, dev loop, README

**Files:**
- Create: `config.yaml`, `repository.yaml`, `run.sh`, `Dockerfile`, `Dockerfile.dev`, `app/client/Dockerfile.dev`, `docker-compose.yml`, `Makefile`, `scripts/dev-compose.mjs`, `scripts/dev-compose.test.mjs`, `.devcontainer/`, `.claude/settings.json`, `.claude/commands/run-tests.md`, `README.md`, `CHANGELOG.md`, `.github/dependabot.yml`

**Interfaces:**
- `config.yaml`: `name: "Scribe"`, `description: "Encrypted vault for Scribe meeting libraries — sync target, MCP endpoint"`, `version: "0.1.0"`, `slug: "scribe"`, `image: "ghcr.io/korzun/scribe-{arch}"`, `init: false`, `arch: [aarch64, amd64]`, `ports: { 3000/tcp: 3000 }`, `ports_description`, `map: [media:rw, data:rw]`, options `{ library_dir: scribe, public_url: "", trust_proxy_hops: 0, setup_code: "", log_level: info }`, schema `{ library_dir: str, public_url: "str?", trust_proxy_hops: int, setup_code: "password?", log_level: "list(debug|info|warn|error)" }`.
- `repository.yaml`: `name: Scribe`, `url: https://github.com/Korzun/scribe-homeassistant`, `maintainer: korzun`.
- `Dockerfile`: Bookplate's three stages (builder on `$BUILDPLATFORM`, cross-arch `prod-deps` with `ARGON2=1 npm_config_arch`, runtime) with paths renamed to `/scribe`; copies `app/server/dist`, `prisma/`, `.prisma`, `app/client/dist`, `run.sh`. `run.sh`: `exec node /scribe/app/server/dist/index.js`.
- `Makefile`, `docker-compose.yml`, `scripts/dev-compose.mjs` (+ its tests, `scribe-` prefix), `Dockerfile.dev`s: copy, substitute; the compose `server` service mounts `./dev-data:/data` and `./dev-media:/media`, env `SETUP_CODE` is **not** a thing — dev sets the code by writing `dev-data/options.json` (`make dev` creates it with `setup_code: dev-setup-code` if absent).
- `README.md` in Bookplate's structure: hero-less title, badges (aarch64/amd64), one paragraph on what the vault is and is not (spec §1), Installation, Configuration table (five options; `setup_code` explained as the key to creation and keys-lost reset), "What the vault stores and what it can read" (spec §3 plaintext list and §10's boundary in two short paragraphs), Usage (the admin page; "connect from Scribe on your Mac"), Recovery (kit, codes, the unrecoverable case), Development (dev loop, env vars `DATA_DIR`, `BLOBS_DIR`, `PORT`, `PUBLIC_URL`, `TRUST_PROXY_HOPS`, `LOG_LEVEL`), Release channels and Cutting a release (copied). `CHANGELOG.md`: `## 0.1.0` with one line "Initial release: encrypted library storage, devices, change log, uploads, admin page."

- [ ] **Step 1: Copy and adapt** every file above. **Step 2: Verify** `docker build -t scribe:dev .` succeeds and `docker run -p 3000:3000 -v $PWD/dev-data:/data scribe:dev` answers `curl localhost:3000/api/v1/status` with `{"libraryExists":false,…}`; `make dev` brings up both services and `http://localhost:5173/login` shows the create-from-Scribe state; `node --test scripts/*.test.mjs` passes.
- [ ] **Step 3: Commit** `build: package the vault as a Home Assistant add-on with the Bookplate dev loop`.

### Task 15: CI and release pipeline

**Files:**
- Create: `.github/workflows/ci.yml`, `.github/workflows/release-prepare.yml`, `.github/workflows/release-finalize.yml`, `.github/workflows/release-publish.yml`, `scripts/watch-release.mjs`, `scripts/watch-release.test.mjs`

**Interfaces:**
- `ci.yml`: Bookplate's jobs minus `test-cost-calibration`: lint, client tests, server tests, script tests, multi-arch build (`linux/amd64,linux/arm64`, no push), Docker smoke test. The smoke test: wait for `GET /login` 200; `GET /api/v1/status` body contains `"libraryExists":false`; `POST /api/v1/library` with an empty JSON body returns **403** (no setup code in the image — proves the gate is closed by default, not merely that validation ran); `GET /api/v1/changes` without a token is 401.
- Release workflows and `watch-release.mjs`: copied verbatim, `bookplate`→`scribe`; the `sed` on `config.yaml` and `npm version` unchanged. Same GitHub App variables (`RELEASE_APP_ID`, `RELEASE_APP_PRIVATE_KEY`).

- [ ] **Step 1: Copy and adapt.** **Step 2: Verify** with `actionlint` locally and by pushing a branch and watching CI go green. **Step 3: Commit** `ci: lint, test, build and smoke the add-on; release on rails`.

### Task 16: The test client as a CLI, and the end-to-end proof

**Files:**
- Create: `scripts/vault-cli.ts` (run with `tsx`), `app/server/e2e.test.ts`
- Modify: `app/server/package.json` (script `vault`: `tsx ../../scripts/vault-cli.ts`), `README.md` (a "Trying it without Scribe" section)

**Interfaces:**
- `vault-cli.ts` wraps `VaultClient` over `fetch` against a running vault (`--url`, credentials from env `SCRIBE_PASSWORD`, `SCRIBE_SECRET_KEY`, device token cached at `~/.scribe-vault-cli.json`): `create --setup-code`, `enrol --name`, `put <meetingId> <kind> <file>` (seals the file with the library key before upload; uses the upload session above 16 MiB), `get <meetingId> <kind> <out>` (opens), `changes --since`, `devices`, `delete <meetingId>`. Its purpose is a human proving the vault before Scribe exists and a developer reproducing a bug.
- `e2e.test.ts` (one test, against the harness): create → enrol a second device → put all eight artifact kinds for one meeting from device A → device B sees eight changes and fetches identical bytes → B renames a speaker (`labels` with `If-Match`) → A sees seq advance → A uploads a 40 MiB `audio-mic` in parts → B lists it → A deletes the meeting → B sees the tombstone → sweep at +8 days removes files, keeps rows → storage reads zero bytes.

- [ ] **Step 1: Write `e2e.test.ts`** → FAIL only if an earlier task left a gap; fix there. **Step 2: Write the CLI.** **Step 3: Run it** against `make run`: `create`, `put`, `get`, compare bytes with `cmp`. **Step 4: Commit** `feat(server): a command-line client that proves the vault end to end`.

---

## Self-review notes

- **Spec coverage.** §3 keys → Tasks 3, 4, 7, 11, 13; blob format and AAD → 3, 8; vectors → 3, 11. §4 options, blob layout, stack, surfaces → 1, 2, 8, 14. §5 creation, enrolment, tokens, revocation semantics → 4, 5. §6 kinds, change log, writes and conflicts, tombstones, seven-day grace, purge → 8, 9 (the `labels` three-way merge is the **Mac's** job in plan 3; the vault only returns 409 with `currentRevision`). §7 chunked, resumable, hash-verified uploads → 10. §9 password change, recovery codes, recovery, keys-lost deletion gated on the live setup code → 7, 9, 13. §13's vault list minus MCP and jobs → spread above; the "no log call receives a decrypted field" test is moot in this plan because the vault holds no decryptable field yet, and is assigned to plan 2. §14 "usable with a small test client" → 16. CI/release → 15.
- **Not in this plan, by the spec's build order:** jobs (§8), MCP and the token key chain (§10), the conformance exporter, any Scribe change.
- **Type consistency checked:** `PutResult`, `ChangeRow`, `VaultClient` method names, `ownerAuth` vs `deviceAuth`, `BlobStore` methods, `createGarbageCollector.sweep` are used with the same names across Tasks 8–10 and 16.
- **Proportion:** the plan is shorter than the spec and carries no function bodies.
