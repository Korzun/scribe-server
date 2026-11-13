# Docker-First Vault Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the vault an ordinary container that Coolify builds from this repository and runs with environment variables and one volume, with first-run setup in the browser, while the Home Assistant add-on keeps working.

**Architecture:** The existing `node:24-alpine` image gains a health check, OCI labels and an in-process privilege drop; `config.ts` gains `SETUP_CODE`, empty-means-unset, and a `/data/blobs` default when no `options.json` exists. The server's create-library call makes the first device optional, the status endpoint exposes `publicUrl`, and the client gains a `/setup` page driven by a new `lib/setup.ts`. A deployable root compose file replaces the dev one (renamed), CI proves health and the setup gate both ways, and releases also publish a multi-arch `scribe-server` image.

**Tech Stack:** Node 24, TypeScript 7, Express 5, Prisma 7 + better-sqlite3, zod, vitest 4 + supertest; React 19, Vite 8, react-router 8, Testing Library; Docker multi-stage on `node:24-alpine`; GitHub Actions with `docker/build-push-action` and `home-assistant/builder`.

**Spec:** `docs/superpowers/specs/2026-11-13-docker-first-vault-design.md` (a delta to `docs/superpowers/specs/2026-11-05-scribe-home-assistant-design.md`, whose §3 crypto, §9 copy voice and testing rules still bind).

## Global Constraints

- Precedence for every knob: environment variable, then `options.json`, then default. An environment variable set to the empty string (after trim) counts as unset.
- Variables and defaults, exactly: `DATA_DIR`=`/data`; `BLOBS_DIR`=`<DATA_DIR>/blobs` when no `options.json`, else `/media/<library_dir>/blobs`; `PORT`=`3000`; `PUBLIC_URL` none; `TRUST_PROXY_HOPS`=`0`; `SETUP_CODE` none; `LOG_LEVEL`=`info`.
- A setup code shorter than 12 characters is treated as unset from either source (existing `MIN_SETUP_CODE_LENGTH`).
- A misconfigured value never stops the boot: bad `PUBLIC_URL` → none with a warning; bad hop count → `0`; short setup code → unset.
- The container starts as root, chowns only `DATA_DIR` and `BLOBS_DIR` themselves (not recursively) to uid/gid 1000, then drops to uid/gid 1000. Not root → do nothing. The process never needs root after that.
- `HEALTHCHECK`: interval 30 s, timeout 5 s, retries 3, start period 10 s; runs `node` against `GET /api/v1/status` on the container's own `PORT`; passes only on a 200 with a JSON body. No `curl` or `wget` added to the image.
- `run.sh` only execs `node`.
- `POST /api/v1/library` accepts a body with or without `device`; without it, no device row is created and the 201 body is exactly `{ libraryId }`. The one-transaction guarantee and the setup-code check are unchanged.
- `GET /api/v1/status` returns `{ libraryExists, version, publicUrl }`, `publicUrl` being `config.publicUrl` (`null` when unset).
- Setup page route is `/setup`, unprotected. With a library present it redirects to `/login`; the login page, finding no library, redirects to `/setup`.
- Setup needs WebCrypto; outside a secure context the page shows the existing message: `This browser cannot derive your keys here — open the vault over HTTPS`.
- The kit download is plain text and contains: the vault URL (`publicUrl` if set, else `window.location.origin`), the Secret Key, the ten codes, and one paragraph on what each is for.
- The create button on the setup page is disabled until the checkbox *I have saved my Secret Key and recovery codes somewhere safe.* is ticked.
- Published image name: `ghcr.io/korzun/scribe-server`. Pre-release: tags `<version>` and `beta`. Stable: `<version>`, `latest`, `beta`.
- Nothing Coolify-specific is committed. `CHANGELOG.md` is owned by the release workflow; do not edit it.
- Copy follows the original design's §9 voice: plain, short, says what is irreversible. No em-dash rule applies to code comments; UI copy may use the existing style.
- Tests: TDD per task; no test asserts on a mock of the unit under test; the server suite runs with `npx vitest run <file>` from inside `app/server`, the client suite from inside `app/client`.

## Review Focus

1. A Coolify redeploy with `SETUP_CODE` removed must leave an existing library fully usable and refuse creation and reset with 403. (Task 1 config tests: unset env + no options.json → `readSetupCode` null; Task 2 server tests: 403 on create and on reset.)
2. A bind mount owned by root and the container run as root must end with the server writing `db.sqlite` as uid 1000. (Task 3 unit test of `dropPrivileges` ordering; Task 4 smoke test runs with a root-owned host directory mounted at `/data` and asserts the file's owner.)
3. The setup page must survive a 403 (wrong setup code) without discarding the generated kit, so the owner can fix the code and retry with the same Secret Key. (Task 7 test.)
4. Two people racing to set up the same fresh vault: the second gets a 409 and is sent to sign in, never shown a kit for a library that is not theirs. (Task 7 test.)
5. A `.env` written from `.env.example` with values left blank must produce the defaults, not empty strings. (Task 1 tests for empty `BLOBS_DIR`, `PUBLIC_URL`, `SETUP_CODE`, `TRUST_PROXY_HOPS`, `LOG_LEVEL`; Task 5 `docker compose config` check.)

---

### Task 1: Configuration — `SETUP_CODE`, empty-means-unset, one-volume default

**Files:**
- Modify: `app/server/config.ts`
- Modify: `app/server/types.ts` (doc comment on `blobsDir` only)
- Modify: `app/server/routes/library.ts:97-105` (the short-code warning text)
- Test: `app/server/config.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces: `loadConfig(): AppConfig` unchanged in shape. `readSetupCode(dataDir: string): string | null` unchanged in signature; now returns `process.env.SETUP_CODE` (trimmed) when non-empty, else the `options.json` value as today.

- [ ] **Step 1: Write the failing tests**

Add to `app/server/config.test.ts`. The `beforeEach` already resets `process.env` and sets `DATA_DIR`; add `delete process.env.SETUP_CODE` and `delete process.env.LOG_LEVEL` to it.

```ts
describe('loadConfig', () => {
  it('defaults blobsDir to <DATA_DIR>/blobs when there is no options.json', () => {
    expect(loadConfig().blobsDir).toBe(path.join(dataDir, 'blobs'));
  });

  it('treats an empty BLOBS_DIR as unset', () => {
    process.env.BLOBS_DIR = '   ';
    writeOptions({ library_dir: 'scribe' });
    expect(loadConfig().blobsDir).toBe('/media/scribe/blobs');
  });

  it('treats empty PUBLIC_URL, TRUST_PROXY_HOPS and LOG_LEVEL as unset', () => {
    process.env.PUBLIC_URL = '';
    process.env.TRUST_PROXY_HOPS = '';
    process.env.LOG_LEVEL = '';
    writeOptions({ public_url: 'https://vault.example.com', trust_proxy_hops: 2, log_level: 'warn' });
    const config = loadConfig();
    expect(config.publicUrl).toBe('https://vault.example.com');
    expect(config.trustProxyHops).toBe(2);
    expect(config.logLevel).toBe('warn');
  });

  it('falls back to defaults when env is empty and options.json is absent', () => {
    process.env.LOG_LEVEL = '';
    process.env.TRUST_PROXY_HOPS = '';
    const config = loadConfig();
    expect(config.logLevel).toBe('info');
    expect(config.trustProxyHops).toBe(0);
    expect(config.publicUrl).toBeNull();
  });
});

describe('readSetupCode', () => {
  it('prefers SETUP_CODE from the environment over options.json', () => {
    writeOptions({ setup_code: 'from-options-json' });
    process.env.SETUP_CODE = ' from-environment ';
    expect(readSetupCode(dataDir)).toBe('from-environment');
  });

  it('treats an empty SETUP_CODE as unset and reads options.json', () => {
    process.env.SETUP_CODE = '';
    writeOptions({ setup_code: 'from-options-json' });
    expect(readSetupCode(dataDir)).toBe('from-options-json');
  });

  it('returns null when SETUP_CODE is empty and options.json is absent', () => {
    process.env.SETUP_CODE = '';
    expect(readSetupCode(dataDir)).toBeNull();
  });
});
```

`writeOptions` is the existing helper at the top of the file (it takes the options object). Keep the existing tests; the one named "resolves blobsDir under /media/<library_dir>/blobs" still writes `options.json` and still passes.

- [ ] **Step 2: Run the file to verify the new tests fail**

Run (from `app/server`): `npx vitest run config.test.ts`
Expected: the seven new tests FAIL (blobs default is `/media/scribe/blobs`; empty env strings are used as-is; `SETUP_CODE` is ignored).

- [ ] **Step 3: Implement**

In `app/server/config.ts`:

- Add `function env(name: string): string | undefined` returning `undefined` when the variable is missing or blank after trim, else the trimmed value. Use it for every `process.env.X` read in `loadConfig` and `readSetupCode`.
- Track whether `options.json` was read (`let hasOptions = false`, set true on a successful parse). `blobsDir` becomes `env('BLOBS_DIR') ?? (hasOptions ? resolveBlobsDir(options.library_dir) : path.join(dataDir, 'blobs'))`.
- `readSetupCode(dataDir)`: `const fromEnv = env('SETUP_CODE'); if (fromEnv !== undefined) return fromEnv;` then the existing file logic.
- Update the `readSetupCode` doc comment: environment first (fixed for the container's life; change it and redeploy), then `options.json` live.

In `app/server/types.ts`, change the `blobsDir` comment to: `Where encrypted blobs live: BLOBS_DIR, else /media/<library_dir>/blobs under the add-on, else <dataDir>/blobs.`

In `app/server/routes/library.ts`, change the warning text to end with `set a longer one in SETUP_CODE or the add-on configuration`.

- [ ] **Step 4: Run the file to verify it passes**

Run: `npx vitest run config.test.ts`
Expected: PASS, all tests.

- [ ] **Step 5: Run the server suite and lint**

Run: `npx vitest run` (from `app/server`) and `npm run lint` (from the root).
Expected: all pass; lint reports only the pre-existing client warnings.

- [ ] **Step 6: Commit**

```bash
git add app/server/config.ts app/server/config.test.ts app/server/types.ts app/server/routes/library.ts
git commit -m "feat(server): SETUP_CODE from the environment, empty env means unset, blobs default under DATA_DIR"
```

---

### Task 2: Library creation without a device, and `publicUrl` on status

**Files:**
- Modify: `app/server/services/library.ts:16-25, 57-121`
- Modify: `app/server/routes/library.ts:63-72, 176-224`
- Modify: `app/server/routes/status.ts`
- Modify: `app/server/server.ts:66`
- Test: `app/server/routes/library.test.ts`, `app/server/routes/status.test.ts`

**Interfaces:**
- Produces: `CreateLibraryInput.device?: { name: string }`; `createLibrary(...)` returns `{ libraryId: string; deviceId?: string; token?: string }`; `createStatusRouter({ prisma, version, publicUrl })` where `publicUrl: string | null`.
- Consumes: `buildLibraryRequest({ setupCode, name? })` and `writeSetupCode(dataDir, code)` from `app/server/test-support/vault-client.ts`.

- [ ] **Step 1: Write the failing tests**

In `app/server/routes/library.test.ts`, inside the existing `POST /api/v1/library` describe (it already uses a harness `h` and writes the setup code):

```ts
it('creates the library without a device when none is given', async () => {
  writeSetupCode(h.dataDir, 'browser-setup-code-123');
  const { body } = buildLibraryRequest({ setupCode: 'browser-setup-code-123' });
  delete (body as { device?: unknown }).device;

  const res = await request(h.app).post('/api/v1/library').send(body);

  expect(res.status).toBe(201);
  expect(res.body).toEqual({ libraryId: body.libraryId });
  expect(await h.prisma.device.count()).toBe(0);
  expect(await h.prisma.recoveryCode.count()).toBe(10);
});

it('refuses creation and reset with 403 when SETUP_CODE is empty and options.json is absent', async () => {
  process.env.SETUP_CODE = '';
  writeSetupCode(h.dataDir, null);
  const { body } = buildLibraryRequest({ setupCode: 'anything-at-all-12' });

  const created = await request(h.app).post('/api/v1/library').send(body);
  expect(created.status).toBe(403);
  expect(created.body).toEqual({ error: 'Setup code required' });

  const reset = await request(h.app)
    .delete('/api/v1/library')
    .send({ setupCode: 'anything-at-all-12', confirm: 'DELETE' });
  expect(reset.status).toBe(403);
});
```

Add `delete process.env.SETUP_CODE` in the file's `afterEach`. Check how `buildLibraryRequest` returns its body (it may return the body directly rather than `{ body }`); match its real shape.

In `app/server/routes/status.test.ts`:

```ts
it('reports the configured public URL, or null', async () => {
  const unset = await request(h.app).get('/api/v1/status');
  expect(unset.body).toEqual({ libraryExists: false, version: expect.any(String), publicUrl: null });

  h.config.publicUrl = 'https://vault.example.com';
  const set = await request(h.app).get('/api/v1/status');
  expect(set.body.publicUrl).toBe('https://vault.example.com');
});
```

If `createServer` copies `config` rather than holding a reference, build a second harness instead of mutating; `createHarness` has no config argument today, so if needed add an optional `overrides?: Partial<AppConfig>` parameter to it. Update the existing status test's `toEqual` to include `publicUrl: null`.

- [ ] **Step 2: Run the two files to verify they fail**

Run: `npx vitest run routes/library.test.ts routes/status.test.ts`
Expected: FAIL — 400 on the device-less body (zod requires `device`), status body lacks `publicUrl`.

- [ ] **Step 3: Implement**

- `services/library.ts`: `device?: { name: string }` on `CreateLibraryInput`; in `createLibrary`, mint the token and id and insert the device row only when `input.device` is present; return `deviceId`/`token` only then; log `first device <id>` only then.
- `routes/library.ts`: `device: z.object({...}).optional()` in `createLibraryBody`; the 201 body is `{ libraryId }` when `created.deviceId` is undefined, else the existing three fields.
- `routes/status.ts`: add `publicUrl: string | null` to `StatusRouterDeps` and to the JSON.
- `server.ts:66`: pass `publicUrl: config.publicUrl`.

- [ ] **Step 4: Run the two files to verify they pass**

Run: `npx vitest run routes/library.test.ts routes/status.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the server suite (the CLI and e2e tests still send a device)**

Run: `npx vitest run`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/server/services/library.ts app/server/routes/library.ts app/server/routes/library.test.ts app/server/routes/status.ts app/server/routes/status.test.ts app/server/server.ts app/server/test-support/harness.ts
git commit -m "feat(server): library creation without a first device; status reports publicUrl"
```

---

### Task 3: Privilege drop in the server process

**Files:**
- Create: `app/server/utils/drop-privileges.ts`
- Create: `app/server/utils/drop-privileges.test.ts`
- Modify: `app/server/index.ts:28-29`

**Interfaces:**
- Produces:
  ```ts
  export type PrivilegeOps = {
    getuid: () => number;
    mkdirSync: (dir: string) => void;          // recursive
    chownSync: (dir: string, uid: number, gid: number) => void;
    setgid: (gid: number) => void;
    setuid: (uid: number) => void;
  };
  export const VAULT_UID = 1000;
  export const VAULT_GID = 1000;
  /** Returns true when privileges were dropped, false when not root (nothing done). */
  export function dropPrivileges(dirs: string[], ops: PrivilegeOps): boolean;
  export function defaultPrivilegeOps(): PrivilegeOps | null; // null on platforms without getuid/setuid (Windows)
  ```

- [ ] **Step 1: Write the failing tests**

```ts
import { describe, expect, it, vi } from 'vitest';
import { dropPrivileges, VAULT_GID, VAULT_UID, type PrivilegeOps } from './drop-privileges';

const fakeOps = (uid: number): PrivilegeOps & { calls: string[] } => {
  const calls: string[] = [];
  return {
    calls,
    getuid: () => uid,
    mkdirSync: (dir) => void calls.push(`mkdir ${dir}`),
    chownSync: (dir, u, g) => void calls.push(`chown ${dir} ${u}:${g}`),
    setgid: (g) => void calls.push(`setgid ${g}`),
    setuid: (u) => void calls.push(`setuid ${u}`),
  };
};

describe('dropPrivileges', () => {
  it('as root: creates and chowns each directory, then sets gid before uid', () => {
    const ops = fakeOps(0);
    expect(dropPrivileges(['/data', '/data/blobs'], ops)).toBe(true);
    expect(ops.calls).toEqual([
      'mkdir /data',
      `chown /data ${VAULT_UID}:${VAULT_GID}`,
      'mkdir /data/blobs',
      `chown /data/blobs ${VAULT_UID}:${VAULT_GID}`,
      `setgid ${VAULT_GID}`,
      `setuid ${VAULT_UID}`,
    ]);
  });

  it('not root: touches nothing and returns false', () => {
    const ops = fakeOps(1000);
    expect(dropPrivileges(['/data'], ops)).toBe(false);
    expect(ops.calls).toEqual([]);
  });

  it('a chown failure propagates (a mount the vault cannot own is a real error)', () => {
    const ops = fakeOps(0);
    ops.chownSync = () => { throw new Error('EPERM'); };
    expect(() => dropPrivileges(['/data'], ops)).toThrow('EPERM');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run utils/drop-privileges.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

`dropPrivileges`: if `ops.getuid() !== 0` return false; for each dir in order: `mkdirSync`, `chownSync(dir, VAULT_UID, VAULT_GID)`; then `setgid`, then `setuid`; return true. `defaultPrivilegeOps()` returns `null` when `process.getuid`/`process.setuid`/`process.setgid` are not functions; otherwise wraps `fs.mkdirSync(dir, { recursive: true })`, `fs.chownSync`, `process.setgid`, `process.setuid`, `process.getuid`.

`index.ts`: replace the two `mkdirSync` lines with:

```ts
const ops = defaultPrivilegeOps();
if (ops !== null && dropPrivileges([config.dataDir, config.blobsDir], ops)) {
  log.info('Dropped privileges to uid 1000');
} else {
  fs.mkdirSync(config.dataDir, { recursive: true });
  fs.mkdirSync(config.blobsDir, { recursive: true });
}
```

This runs before Prisma opens the database and before any file is created, so everything the vault writes is owned by uid 1000.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run utils/drop-privileges.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/server/utils/drop-privileges.ts app/server/utils/drop-privileges.test.ts app/server/index.ts
git commit -m "feat(server): start as root only to own the data directories, then drop to uid 1000"
```

---

### Task 4: Image — health check, labels, `.dockerignore`; CI smoke test proves health, ownership and the setup gate both ways

**Files:**
- Modify: `Dockerfile` (runtime stage)
- Modify: `.dockerignore`
- Modify: `.github/workflows/ci.yml` (job `docker-smoke-test`)
- Modify: `.github/workflows/release-publish.yml` (job `docker-smoke-test`: same wait-for-healthy loop, nothing else)

**Interfaces:** none.

- [ ] **Step 1: Dockerfile runtime stage**

After `EXPOSE 3000` and before `CMD`, add:

```dockerfile
LABEL org.opencontainers.image.title="Scribe vault" \
      org.opencontainers.image.description="Encrypted vault for Scribe meeting libraries" \
      org.opencontainers.image.source="https://github.com/Korzun/scribe-server" \
      org.opencontainers.image.licenses="MIT"
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/v1/status').then(r=>r.ok?r.json():Promise.reject(r.status)).then(()=>process.exit(0),()=>process.exit(1))"
```

Check the licence name in `README.md`'s License section and use that SPDX id. Do not add a `USER` line: the process drops privileges itself (Task 3). Add `ARG VERSION=dev` and `org.opencontainers.image.version="${VERSION}"` to the label set; CI and release pass `--build-arg VERSION=...` later (Task 6) and the default is fine elsewhere.

- [ ] **Step 2: `.dockerignore`**

Append `.git`, `docs`, `.github`, `*.md`, `.env`, `.env.*`, `!.env.example`.

- [ ] **Step 3: Build locally and verify**

Run: `docker build -t scribe:local .` then `docker run -d --name scribe-local -p 3100:3000 scribe:local` then, after ~15 s, `docker inspect --format '{{.State.Health.Status}}' scribe-local`.
Expected: `healthy`. Then `docker exec scribe-local stat -c '%u' /data/db.sqlite` → `1000`, and `docker exec scribe-local ps -o user,comm` shows `node` running as `node`. Clean up with `docker rm -f scribe-local`.

- [ ] **Step 4: CI smoke test**

In `.github/workflows/ci.yml`'s `docker-smoke-test` job, replace the "Run and verify startup" step with three steps:

1. **Fresh container, no setup code.** Run `scribe:smoke` with a root-owned host directory mounted at `/data` (`mkdir smoke-data && sudo chown root:root smoke-data`, `-v "$PWD/smoke-data:/data"`). Replace the 15-tries curl loop with a loop on `docker inspect --format '{{.State.Health.Status}}'` until `healthy` (up to 60 s, 2 s apart), printing logs and failing otherwise. Keep the existing status check (`libraryExists:false`), the existing well-formed-body 403 check, and the 401 check. Add: `stat -c '%u' smoke-data/db.sqlite` must print `1000`.
2. **Setup gate open.** Start a second container from the same image with `-e SETUP_CODE=smoke-setup-code-123` and a fresh directory; wait for healthy; POST the same well-formed body with `setupCode: "smoke-setup-code-123"` and no `device` field; expect `201` and a body containing `"libraryId"`. Then POST it again and expect `409`.
3. **Cleanup** both containers (`docker rm -f`), also on failure (`if: always()`).

Keep the body-building `node -e` snippet; move it into a reusable shell variable at the top of the job or repeat it, whichever reads better in YAML. In `release-publish.yml`'s `docker-smoke-test`, only swap the curl loop for the same health loop.

- [ ] **Step 5: Validate the workflows**

Run: `actionlint .github/workflows/ci.yml .github/workflows/release-publish.yml` (install with `brew install actionlint` if missing).
Expected: no findings.

- [ ] **Step 6: Commit**

```bash
git add Dockerfile .dockerignore .github/workflows/ci.yml .github/workflows/release-publish.yml
git commit -m "build: health check and OCI labels on the image; smoke test proves health, ownership and the setup gate"
```

---

### Task 5: Compose — rename the dev stack, add the deployable file and `.env.example`

**Files:**
- Rename: `docker-compose.yml` → `docker-compose.dev.yml`
- Create: `docker-compose.yml`
- Create: `.env.example`
- Modify: `scripts/dev-compose.mjs:76`, `Makefile` (`dev-clean`, `dev`, `dev-down` targets), `.gitignore` (add `.env`)
- Modify: `.github/workflows/ci.yml` (job `lint`)
- Test: `scripts/dev-compose.test.mjs` if it asserts the compose arguments; otherwise none beyond the CI check.

**Interfaces:** none.

- [ ] **Step 1: Rename and repoint the dev stack**

`git mv docker-compose.yml docker-compose.dev.yml`. In `scripts/dev-compose.mjs`, spawn `docker compose -f docker-compose.dev.yml ...args`. In the Makefile, `dev-clean` becomes `docker compose -f docker-compose.dev.yml down --rmi all -v`. Update the one README sentence that names `docker-compose.yml` in the Development section to `docker-compose.dev.yml` (the rest of the README is Task 8).

- [ ] **Step 2: Write the deployable `docker-compose.yml`**

```yaml
services:
  scribe:
    build: .
    image: ghcr.io/korzun/scribe-server:latest
    restart: unless-stopped
    ports:
      - "${PORT:-3000}:3000"
    environment:
      PUBLIC_URL: ${PUBLIC_URL:-}
      TRUST_PROXY_HOPS: ${TRUST_PROXY_HOPS:-0}
      SETUP_CODE: ${SETUP_CODE:-}
      LOG_LEVEL: ${LOG_LEVEL:-info}
    volumes:
      - scribe-data:/data

volumes:
  scribe-data:
```

No `DATA_DIR` or `BLOBS_DIR` in the environment block: the volume is at the default. A comment above `volumes:` says how to split blobs (`BLOBS_DIR=/blobs` plus a second mount). No `healthcheck:` block (the image carries it). No `user:`.

- [ ] **Step 3: Write `.env.example`**

One line per variable above with the default and a one-line comment each, matching the spec's §2 table: `PORT`, `PUBLIC_URL`, `TRUST_PROXY_HOPS`, `SETUP_CODE`, `LOG_LEVEL`. The `SETUP_CODE` comment says: at least 12 characters; remove it once the library exists and run `docker compose up -d` again. Add `.env` to `.gitignore`.

- [ ] **Step 4: Verify locally**

Run: `cp .env.example .env && docker compose config` then `rm .env`.
Expected: renders with `SETUP_CODE: ""`, `TRUST_PROXY_HOPS: "0"`, the volume, and no errors. Then `make dev` still starts the dev stack (`make dev-down` after).

- [ ] **Step 5: CI**

In `ci.yml`'s `lint` job, add a step after `npm run lint`: `docker compose -f docker-compose.yml config --quiet` and `docker compose -f docker-compose.dev.yml config --quiet`. Run `actionlint` again.

- [ ] **Step 6: Commit**

```bash
git add docker-compose.yml docker-compose.dev.yml .env.example .gitignore scripts/dev-compose.mjs Makefile README.md .github/workflows/ci.yml
git commit -m "build: deployable docker-compose.yml with .env.example; dev stack moves to docker-compose.dev.yml"
```

---

### Task 6: Release — publish a multi-arch `scribe-server` image

**Files:**
- Modify: `.github/workflows/release-publish.yml` (job `build`)

**Interfaces:** none.

- [ ] **Step 1: Add the publish step**

In the `build` job, after the existing home-assistant/builder step, add:

1. `docker/setup-qemu-action@v4` and `docker/setup-buildx-action@v4`.
2. A shell step `id: tags` that writes `tags=` to `$GITHUB_OUTPUT`: for `needs.resolve.outputs.is_prerelease == 'true'`, `ghcr.io/korzun/scribe-server:<version>,ghcr.io/korzun/scribe-server:beta`; otherwise `:<version>,:latest,:beta`. Use `${{ github.repository_owner }}` lowercased (`tr '[:upper:]' '[:lower:]'`) instead of a literal `korzun`.
3. `docker/build-push-action@v7` with `context: .`, `platforms: linux/amd64,linux/arm64`, `push: true`, `tags: ${{ steps.tags.outputs.tags }}`, `build-args: VERSION=${{ needs.resolve.outputs.version }}`, and `labels` left to the Dockerfile.

The job already logs in to GHCR. `build-beta-sync` is unchanged (stable already pushes `:beta` above).

- [ ] **Step 2: Validate**

Run: `actionlint .github/workflows/release-publish.yml`.
Expected: no findings.

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release-publish.yml
git commit -m "ci: publish a multi-arch scribe-server image on release"
```

---

### Task 7: Client — `lib/setup.ts`, the `/setup` page, and login routing

**Files:**
- Create: `app/client/src/lib/setup.ts`, `app/client/src/lib/setup.test.ts`
- Create: `app/client/src/page/setup/index.tsx`, `app/client/src/page/setup/style.ts`, `app/client/src/page/setup/index.test.tsx`
- Modify: `app/client/src/page/index.ts`, `app/client/src/router/path-internal.ts`, `app/client/src/router/component.tsx`
- Modify: `app/client/src/page/login/index.tsx:18, 185-191`, `app/client/src/page/login/index.test.tsx:86-95`

**Interfaces:**
- Consumes: `generateSecretKey(): Uint8Array`, `formatSecretKey`, `generateRecoveryCode`, `formatRecoveryCode` (`lib/codes`); `deriveAccountKeys({ secret, secretKey, salt })` → `{ kek, authKey, ... }`, `passwordBytes` (`lib/kdf`); `seal(key, bytes, aad)`, `keyWrapAad(libraryId, 'password' | 'recovery')` (`lib/seal`); `toBase64` (`lib/bytes`); `api<T>(path, init)` → `ApiResult<T>` (`lib/api`); `extractAccessToken` (`lib/token`); `rememberSecretKey` (`lib/secret-key-store`); `useAuth().signIn(accessToken)`; `CodesSheet` is not reused (the kit stays on the page, not in a modal).
- Produces, in `lib/setup.ts`:
  ```ts
  export type CreateLibraryRequest = {
    libraryId: string; passwordSalt: string; recoverySalt: string; authKey: string;
    passwordWrap: string; recoveryCodes: Array<{ authKey: string; wrap: string }>;
  };
  export type Kit = { libraryId: string; secretKey: string; recoveryCodes: string[]; authKey: string; request: CreateLibraryRequest };
  /** Generates LK, SK, ten codes; derives and wraps per spec §3. Throws outside a secure context. */
  export async function prepareLibrary(password: string): Promise<Kit>;
  export function createLibrary(kit: Kit, setupCode: string): Promise<ApiResult<{ libraryId: string }>>;
  export function kitFileText(kit: Kit, vaultUrl: string): string;
  export const KIT_FILE_NAME = 'scribe-kit.txt';
  ```
  Route: `path.setup()` → `'/setup'`.

- [ ] **Step 1: Write the failing `lib/setup.test.ts`**

Use the real crypto libs (the recover and account tests already do). Mock `fetch` as `account.test.ts` does.

```ts
describe('prepareLibrary', () => {
  it('produces a kit whose wraps open with the derived keys', async () => {
    const kit = await prepareLibrary('correct horse battery staple');
    expect(kit.libraryId).toMatch(/^[0-9a-f-]{36}$/);
    expect(parseSecretKey(kit.secretKey)).not.toBeNull();
    expect(kit.recoveryCodes).toHaveLength(10);
    expect(new Set(kit.recoveryCodes).size).toBe(10);
    expect(kit.request.recoveryCodes).toHaveLength(10);
    // The password wrap opens under the password-derived kek.
    const sk = parseSecretKey(kit.secretKey)!;
    const { kek, authKey } = await deriveAccountKeys({
      secret: passwordBytes('correct horse battery staple'), secretKey: sk,
      salt: fromBase64(kit.request.passwordSalt),
    });
    expect(toBase64(authKey)).toBe(kit.authKey);
    const lk = await open(kek, fromBase64(kit.request.passwordWrap), keyWrapAad(kit.libraryId, 'password'));
    expect(lk).toHaveLength(32);
    // And the first recovery code's wrap opens to the same Library Key.
    const code = parseRecoveryCode(kit.recoveryCodes[0])!;
    const rc = await deriveAccountKeys({ secret: code, secretKey: sk, salt: fromBase64(kit.request.recoverySalt) });
    expect(toBase64(rc.authKey)).toBe(kit.request.recoveryCodes[0].authKey);
    expect(await open(rc.kek, fromBase64(kit.request.recoveryCodes[0].wrap), keyWrapAad(kit.libraryId, 'recovery'))).toEqual(lk);
  });
});

describe('createLibrary', () => {
  it('posts the request with the setup code and no device, and returns the library id', async () => {
    const kit = await prepareLibrary('pw');
    // fetch mock: 201 { libraryId: kit.libraryId }
    const result = await createLibrary(kit, 'a-long-setup-code');
    expect(result).toEqual({ ok: true, status: 201, body: { libraryId: kit.libraryId } });
    const sent = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(sent).toEqual({ setupCode: 'a-long-setup-code', ...kit.request });
    expect(sent.device).toBeUndefined();
  });
  it('passes a 403 through unchanged', async () => { /* fetch mock: 403 { error: 'Wrong setup code' } → result.ok false, status 403, error 'Wrong setup code' */ });
});

describe('kitFileText', () => {
  it('contains the URL, the Secret Key, every code, and the explanation', () => {
    const text = kitFileText(kit, 'https://vault.example.com');
    expect(text).toContain('https://vault.example.com');
    expect(text).toContain(kit.secretKey);
    for (const code of kit.recoveryCodes) expect(text).toContain(code);
    expect(text).toContain('Your password is not on this page');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run (from `app/client`): `npx vitest run src/lib/setup.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `lib/setup.ts`**

`prepareLibrary`: `libraryId = crypto.randomUUID()`; `libraryKey = crypto.getRandomValues(new Uint8Array(32))`; `secretKey = generateSecretKey()`; `passwordSalt`, `recoverySalt` 16 random bytes each; derive password keys with `deriveAccountKeys({ secret: passwordBytes(password), secretKey, salt: passwordSalt })`; `passwordWrap = seal(kek, libraryKey, keyWrapAad(libraryId, 'password'))`; ten `generateRecoveryCode()`s each derived with `recoverySalt` and wrapped with `keyWrapAad(libraryId, 'recovery')` (sequentially or `Promise.all`, as `regenerateRecoveryCodes` does). Return formatted key and codes plus the base64 request. `createLibrary`: `api('/api/v1/library', { method: 'POST', body: JSON.stringify({ setupCode, ...kit.request }) })`. `kitFileText`: a heading `Scribe vault kit`, the URL, `Secret Key:` line, `Recovery codes:` and the ten lines, then one paragraph: *The Secret Key and your password together unlock the library. A recovery code replaces a forgotten password, once, and needs the Secret Key too. Your password is not on this page. Without the Secret Key nothing can recover this library.*

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/setup.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing page tests**

`page/setup/index.test.tsx`, following `page/login/index.test.tsx`'s harness (fetch routes, `renderWithProviders`, `useNavigate` mock). Mock `~/lib/setup`'s `prepareLibrary` to return a fixed kit (the real one costs two PBKDF2 runs per test) but keep `createLibrary` and `kitFileText` real. Also mock `~/provider/auth`'s `useAuth` to capture `signIn`, as the login test does if it does; otherwise assert on the token store.

```ts
it('redirects to sign-in when a library already exists', ...)         // status libraryExists:true → navigate(path.login())
it('step 1 refuses mismatched passwords and a short setup code', ...)   // shows "The passwords don't match"; create stays unreachable
it('step 2 shows the Secret Key and ten codes, with Create disabled until the checkbox is ticked', ...)
it('Download kit saves a text file containing the Secret Key', ...)   // spy on URL.createObjectURL / anchor click as codes-sheet's test does
it('creates the library, signs in, remembers the Secret Key, and lands home', ...)
   // POST /api/v1/library → 201; POST /api/v1/session → { accessToken }; expect localStorage['scribe:secret-key'] === kit.secretKey; signIn called with the token
it('a 403 keeps the kit on screen and lets the owner retry with a corrected code', ...)
   // first POST → 403 { error: 'Wrong setup code' }; error shown; the same Secret Key still on screen; second POST with the new code → 201
it('a 409 sends the owner to sign in', ...)                            // navigate(path.login()) and a toast "A library already exists here — sign in"
it('shows the HTTPS message when key derivation is unavailable', ...)   // prepareLibrary rejects → the NO_CRYPTO text
```

Login test: change `shows the create-from-Scribe message when no library exists` to `redirects to setup when no library exists` asserting `navigate` was called with `/setup` and no form is rendered.

- [ ] **Step 6: Run to verify they fail**

Run: `npx vitest run src/page/setup src/page/login`
Expected: FAIL.

- [ ] **Step 7: Implement the page and routing**

- `router/path-internal.ts`: `export const setup = () => '/setup';` with a one-line comment. `router/component.tsx`: add `<Route path={path.setup()} element={<SetupPage />} />` under `UnprotectedRoute`. `page/index.ts`: export `SetupPage`.
- `page/login/index.tsx`: in the effect that reads status, when `libraryExists` is false, `navigate(path.setup(), { replace: true })`; delete the `NO_LIBRARY` constant and the `EmptyState` branch (keep the `EmptyState` import only if still used).
- `page/setup/index.tsx`: one `Card` on `Page type="minimal"`, local state `step: 'details' | 'kit'`, `kit: Kit | null`, `saved: boolean`. Step `details`: password, confirm password, setup code fields; a short line of copy: *Choose a password. It is never sent to the vault and cannot be recovered without the kit on the next step.* Continue calls `prepareLibrary(password)` (toast the `NO_CRYPTO` message on throw). Step `kit`: the Secret Key in a monospace block, the ten codes as a list, buttons **Download kit** (Blob + object URL + anchor click, file name `KIT_FILE_NAME`, text from `kitFileText(kit, vaultUrl)` where `vaultUrl` is `status.publicUrl ?? window.location.origin`) and **Copy** as in `CodesSheet`; the checkbox; **Create library** disabled until ticked. On create: `createLibrary(kit, setupCode)`; 201 → `api('/api/v1/session', POST { authKey: kit.authKey })`, `rememberSecretKey(kit.secretKey)`, `signIn(token)`; 403 → toast the server's error and stay on the kit step; 409 → toast `A library already exists here — sign in` and navigate to login; 429 and network errors as the login page handles them. Reads `GET /api/v1/status` on mount and redirects to login when `libraryExists`.
- `page/setup/style.ts`: react-jss as the other pages; reuse the login page's spacing values.

- [ ] **Step 8: Run to verify they pass, then the client suite and lint**

Run: `npx vitest run src/page/setup src/page/login`, then `npx vitest run`, then `npm run lint` from the root.
Expected: PASS; lint warnings unchanged in count.

- [ ] **Step 9: Commit**

```bash
git add app/client/src/lib/setup.ts app/client/src/lib/setup.test.ts app/client/src/page/setup app/client/src/page/index.ts app/client/src/router app/client/src/page/login
git commit -m "feat(client): create the library from the browser on first run"
```

---

### Task 8: README

**Files:**
- Modify: `README.md`

**Interfaces:** none.

- [ ] **Step 1: Reorder and rewrite per spec §10**

Sections in this order, keeping existing text where the spec says so:

1. Intro: first sentence becomes *A self-hosted, encrypted vault for Scribe, the macOS meeting recorder, also packaged as a Home Assistant add-on.* Keep the rest.
2. **Quick start with Docker Compose**: clone, `cp .env.example .env`, set `SETUP_CODE` and `PUBLIC_URL`, `docker compose up -d`, open the URL, create the library, remove `SETUP_CODE`, `docker compose up -d` again. Mention `ghcr.io/korzun/scribe-server` for image-based deploys and that the package must be public on GHCR for that to work.
3. **Deploying on Coolify**: the seven steps from spec §6 verbatim.
4. **Configuration**: the spec §2 table (variable, default, add-on option, purpose), then the precedence rule and the empty-means-unset rule, then the existing `setup_code` guidance rewritten for both sources.
5. **First run**: what the setup page does from the owner's side, in four sentences, and the HTTPS/localhost rule.
6. **What the vault stores and what it can read**: unchanged.
7. **Usage** → **The admin page** and **Connect from Scribe on your Mac**: unchanged except removing any "create from Scribe" phrasing.
8. **Recovery**: unchanged, but the keys-lost reset paragraph says the setup code comes from `SETUP_CODE` or the add-on option.
9. **Backups**: spec §4's last paragraph, plus one line on the running-as-uid-1000 ownership rule for bind mounts.
10. **Home Assistant add-on**: the current Installation and add-on options text, moved here.
11. **Ports**, **Development** (with `docker-compose.dev.yml`), **Release channels**, **License**: unchanged apart from Task 5's rename and a line in "Cutting a release" that the `scribe-server` image is published too.

Run the formatter on the file: `npx oxfmt README.md`.

- [ ] **Step 2: Check every link and command in the file by reading it once top to bottom**

Expected: no reference to `/media` as the default outside the add-on section; no "Cloudflare"; no command that no longer exists.

- [ ] **Step 3: Commit**

```bash
git add README.md
git commit -m "docs: Docker and Coolify first; Home Assistant as a section"
```

---

### Task 9: Acceptance against Coolify (manual, owner-run)

Not an agent task. After merge, the owner deploys per the README's Coolify section, creates the library in the browser through the tunnel, then from a Mac:

```bash
export SCRIBE_PASSWORD='…' SCRIBE_SECRET_KEY='A1-…'
npm run vault -- --url https://<domain> enrol --name laptop
U=$(uuidgen | tr A-Z a-z)
npm run vault -- put "$U" manifest some.json
npm run vault -- get "$U" manifest out.json && cmp some.json out.json
```

Expected: identical files, and the dashboard shows the device.
