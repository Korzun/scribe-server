# Vault MCP and Jobs Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the vault its remote MCP endpoint (five read-only tools, OAuth 2.1 with a browser consent page that threads the Library Key through the tokens), its reprocessing job queue, and the admin page's view of both. Plan 2 of the four in the design spec's §14.

**Architecture:** A new `app/server/mcp/` package ports Bookplate's OAuth provider, token store and router to REST and Prisma 7, with one addition: every authorization code and token row carries the Library Key wrapped under a key derived from that secret, so the vault can decrypt for a client only while holding a secret the client presented. `POST /mcp` builds a per-request low-level MCP `Server` whose five tools read through a `LibraryReader` that decrypts blobs in memory for the duration of the call. The tool logic is a TypeScript port of Scribe's `ScribeMCP` queries, proven by a conformance fixture the Scribe repo exports. Jobs are one Prisma model and one service behind four routes. The SPA gains a `/connect` consent page and two dashboard cards.

**Tech Stack:** Node 24, TypeScript 7, Express 5, Prisma 7 + better-sqlite3, zod 4, `@modelcontextprotocol/sdk` 1.32 (Streamable HTTP, stateless), vitest 4 + supertest; React 19, react-router 8, react-jss, Testing Library. Swift 6 + swift-testing for the exporter in the Scribe repo.

**Spec:** `docs/superpowers/specs/2026-11-05-scribe-home-assistant-design.md` §2, §4, §8, §10, §13, §14, with the configuration rules of `docs/superpowers/specs/2026-11-13-docker-first-vault-design.md` (`PUBLIC_URL` is the MCP origin and OAuth issuer).

## Decisions taken in brainstorming

The owner listed three open questions. Each is settled here with a default; all three are cheap to change later and are flagged in the PR.

1. **Search cache: not in v1.** Every call decrypts what it needs and drops it. The `LibraryReader` interface is the seam a per-grant cache would wrap; nothing else would change. Measure on the Pi first.
2. **Enqueueing from an MCP client: owner-only now, shape left open.** `jobs.requested_by` records who asked (`device:<id>` or `session`); a later `grant:<id>` needs a column value and a route, nothing structural.
3. **Consent copy:** the spec's draft, verbatim, plus one line naming what is granted (read access to meetings through the five tools) and one saying why the password is asked again (the browser unwraps the Library Key for the assistant). Exact strings in Task 10.

Two further calls the spec left to the builder:

- **Lenient argument parsing and exact JSON schemas.** The remote server uses the SDK's low-level `Server` with `tools/list` and `tools/call` handlers rather than `McpServer.registerTool`, so the advertised JSON schemas are copied from `ToolCatalog.swift` byte for byte and the argument reader can coerce `"10"` to `10` exactly as the Swift `Arguments` type does. The conformance fixture compares `tools/list` too.
- **Meeting ids are lowercase on the remote door.** Swift's `UUID.uuidString` is uppercase and the stdio server emits that; the vault stores canonical lowercase ids and the remote server emits those. Both doors accept either case. Conformance compares ids case-insensitively, and this is the one listed divergence. Sort order is unaffected (hex digits order the same in either case).

## Global Constraints

- MCP is served only when `resolveMcpBaseUrl(config.publicUrl)` is non-null: an `https` origin, or `http://localhost` / `http://127.0.0.1` for development. The OAuth issuer is that origin, never the `Host` header. When MCP is off, `/mcp`, `/mcp/oauth/*` and `/.well-known/oauth-*` answer `404 {"error":"MCP is not enabled"}` as JSON, never the SPA shell.
- One scope, `library:read`. Dynamic client registration, PKCE S256, opaque 32-byte tokens stored as SHA-256 hashes, access tokens live one hour, refresh tokens thirty days, authorization codes ten minutes. Client secrets never expire. Everything else as Bookplate.
- The key chain (spec §10), binding: the browser mints the code (32 random bytes, wire form base64url), derives `k_code = HKDF-SHA256(ikm = code bytes, salt = empty, info = "scribe/v1/token-kek", 32)`, and sends `sha256(wire form)` and `seal(k_code, LK, aad)`. Tokens are the same shape with the same `info`. The wrap AAD is `tokenWrapAad(libraryId, kind, hash)` = `<libraryId>/mcp/<code|access|refresh>/<hash>`, so a wrap cannot be moved between rows. Exchange and refresh unwrap, rewrap under the new pair in one function, and zero the key. `POST /mcp` unwraps with the presented access token and zeroes the key when the response closes. No module-level variable ever holds a Library Key.
- Disconnect deletes the grant; codes and tokens cascade. The keys-lost reset deletes grants and jobs with the library.
- No log call site receives a decrypted field, a key, a token, a code or a hash of one. `mcp/queries/`, `mcp/library-reader.ts`, `mcp/tools.ts` import no logger at all. Task 8's grep test enforces both.
- Tool names, argument names, payload field names, the 25,000-character budget, truncation reasons and cursor semantics are Scribe's. Cursors are opaque per door and never compared.
- Jobs: `POST /api/v1/jobs` is owner auth; claim, heartbeat and complete are device auth. Lease 15 minutes, heartbeat interval 5 minutes (constants in the client file). A lapsed lease makes the job claimable again; after three lapses it is failed with outcome `lapsed`. At most one queued job per meeting: a second enqueue returns the existing one with 200.
- Writes go through `withVaultWriter(req.vaultEpoch, …)` like every other owner write.
- Tests: TDD per task; the server suite from `app/server` with `npx vitest run <file>`, the client suite from `app/client`; full server, client and script suites plus `npm run lint` green before each commit. CI's six jobs green on the PR. Nothing is pushed to `main`.
- The conformance test skips, with a visible reason, when `test/conformance/expected.json` is absent, so the vault suite is green before the Scribe exporter has been run. Once the fixture is committed the skip must never fire again.
- Copy follows spec §9's voice: plain, short, says what is irreversible. `CHANGELOG.md` is the release workflow's; do not edit it.

## Review Focus

1. A disconnected token must not decrypt. (Task 5 test: tokens minted, `withLibraryKey` succeeds; grant deleted; the same token is 401 on `POST /mcp` and `withLibraryKey` rejects. Also a deleted library.)
2. The vault's disk holds the Library Key only under keys it does not hold. (Task 4 tests inspect the tables: the only `Bytes` columns are wraps, and opening a wrap needs the raw code or token.)
3. A browser can never be bounced to an unregistered redirect URI. (Task 6: `POST /api/v1/mcp/authorize` re-validates the client and URI before answering, for Deny too.)
4. Two devices racing to claim one job get one job between them; a heartbeat from the device that lost its lease is 409. (Task 9.)
5. The port must not disagree with Scribe. (Task 7's query tests are translated from the Swift suite's load-bearing cases; Task 12's conformance test compares parsed payloads when the fixture exists.)

---

### Task 1: Scribe repo, test-only conformance exporter

**Repo:** `~/Code/scribe` (owner's Mac). Branch `mcp-conformance-export`, its own PR. Touch only `Tests/ScribeMCPTests/` and `Scripts/`.

**Files:**
- Create: `Tests/ScribeMCPTests/Conformance/Corpus.swift` (builds the corpus with `Fixture`)
- Create: `Tests/ScribeMCPTests/Conformance/script.json` (the fixed script, a test resource)
- Create: `Tests/ScribeMCPTests/ConformanceExportTests.swift` (the exporter, gated on `SCRIBE_CONFORMANCE_OUT`)
- Create: `Scripts/export-mcp-conformance.sh`
- Modify: `Package.swift` only to add `resources: [.copy("Conformance/script.json")]` to `ScribeMCPTests`

**Corpus** (deterministic ids and dates, so a re-export is a no-op diff when nothing changed):
- Five meetings across days 1 to 6; one unprocessed (manifest only); one legacy manifest (no per-stream durations); one with bleed windows above and below the 0.5 threshold; one with calendar fields (`titleOrigin: .calendar`, `scheduledStart/End`, `attendeeNames` with kinds, and one meeting with names but no kinds); two meetings starting at the same instant (cursor tiebreak).
- Speakers: one enrolled voice across three meetings with different labels over time; labels with `.human`, `.voiceprint(id:)` and `.inferred` origins; a refusal; an unattributed utterance (`cluster: nil`); overlapped lines; one line with tokens; one backchannel inside another's turn; one line shorter than 1.5 s.
- Inferences: a strong applied, a weak suggested, a dismissed.
- Summaries: one fresh, one stale (fingerprint mismatch), one with an old `summarizerVersion`.
- Tags: a saved list with a renamed starter tag plus one Topic; meetings with human and auto tags, a stale fingerprint, a suggestion; one meeting with no tags file.
- Text chosen so fuzzy search has an exact hit, an edit-distance hit (`evals` vs `evalves`), a phonetic hit, a pair-key hit (`QLoRA` vs `cue lura`), and a literal-only miss.

**Script** (`script.json`): an array of steps `{ "name": string, "arguments": object, "follow"?: "next_cursor" | "next_offset" }`. A `follow` step is run repeatedly, feeding the named field back as `cursor` (or `offset`), and records the array of pages. Steps cover every tool with and without filters, the budget cut (a `limit` that overruns 25,000 characters), each error message (`malformedMeetingID`, `unknownMeeting`, `conflictingWindow`, a missing required argument, an unreadable `limit`, a bad `detail`, a bad `match`), null arguments, string-typed numbers, and `tools/list`.

**Exporter:** a `@Test` that returns early unless `ProcessInfo.processInfo.environment["SCRIBE_CONFORMANCE_OUT"]` is set. It builds the corpus into a `Fixture`, copies `fixture.root` to `$OUT/store`, copies `script.json` to `$OUT/script.json`, runs every step through `ToolCatalog.call` (following cursors as described), parses each result's one text block as JSON (or records `{ "error": text }` for `isError`), and writes `$OUT/expected.json` as `{ "tools": [...catalog.tools encoded with ResponseBudget.encoder()...], "results": [...] }` with sorted keys. It also writes `$OUT/README.md` naming the commit it was exported from.

**Script:** `Scripts/export-mcp-conformance.sh [out-dir]` runs `SCRIBE_CONFORMANCE_OUT=<abs path> swift test --filter ConformanceExportTests` and prints the copy command for the vault repo (`test/conformance/`).

- [x] **Step 1:** Write `Corpus.swift` and `script.json`.
- [x] **Step 2:** Write the exporter test; `swift test --filter ConformanceExportTests` passes (early return) without the variable, writes the three files with it.
- [ ] **Step 3:** Run the script, copy the output into this repo's `test/conformance/`, commit in both repos.

> This machine has no Swift toolchain and no Scribe checkout under `~/Code`; the Swift files are written against the sources at `~/code/scribe` but are not compiled here. The owner runs Step 3 on the Mac. Task 12's test skips until the output lands.

---

### Task 2: Schema, token crypto and base URL

**Files:**
- Modify: `app/server/prisma/schema.prisma`
- Create: `app/server/prisma/migrations/0004_mcp_jobs/migration.sql`
- Create: `app/server/crypto/token-kek.ts` (+ test)
- Modify: `app/server/crypto/seal.ts` (`tokenWrapAad`), `app/client/src/lib/seal.ts` (twin), `app/client/src/lib/kdf.ts` (`deriveTokenKek`)
- Create: `test/vectors/scribe-mcp-token-v1.json`
- Create: `app/server/mcp/base-url.ts` (+ test)
- Modify: `app/server/services/library.ts` (`RESET_TABLES` gains the five new tables)

**Models:** `McpClient` (as Bookplate), `McpGrant { id, libraryId FK cascade, clientId FK cascade, scopes, createdAt, lastUsedAt }` unique on `(libraryId, clientId)`, `McpAuthorizationCode { codeHash @id, grantId, redirectUri, codeChallenge, resource?, wrap Bytes, expiresAt }`, `McpToken { tokenHash @id, grantId, kind, wrap Bytes, expiresAt, createdAt }`, `Job { id, meetingId, reason, requestedBy, status, attempts, leaseDeviceId?, leaseExpiresAt?, createdAt, startedAt?, finishedAt?, outcome?, note? }` with indexes on `status` and `createdAt`.

**Vectors:** one 32-byte secret in hex → base64url wire form → `sha256(wire)` hex → `k` hex. Both `token-kek.test.ts` and `lib/kdf.test.ts` pin it.

- [x] Tests first: `tokenWrapAad('L','code','h')` is `L/mcp/code/h`; `deriveTokenKek` matches the vector in Node and in WebCrypto; `resolveMcpBaseUrl` accepts `https://x`, `http://localhost:3000`, rejects `http://192.168.1.2`, `null`, garbage, and strips path/query.
- [x] Implement; `npx prisma generate`; the migration applies on a fresh harness.

---

### Task 3: Token store with wraps

**Files:** `app/server/mcp/tokens.ts` (+ `tokens.test.ts`)

Port of Bookplate's `tokens.ts` with these changes: `SCOPES = ['library:read']`; `upsertGrant` keys on `(libraryId, clientId)`; `createAuthorizationCode(prisma, { grantId, redirectUri, codeChallenge, resource, codeHash, wrap })` stores what the browser sent and mints nothing; `consumeAuthorizationCode` and `consumeRefreshToken` return the row's `wrap` in the same `DELETE … RETURNING`; `issueTokens(prisma, grantId, scopes, libraryKey, libraryId, now)` derives each token's kek, seals the key under it with the row's AAD, and stores both rows; `withLibraryKey(prisma, { libraryId, rawAccessToken, now }, fn)` looks the token up, opens the wrap, runs `fn(key)` and zeroes the buffer in `finally`; `sweepExpired` as Bookplate.

- [x] Tests: a code's wrap opens only with the code it was minted for (wrong code → `SealError`); issued tokens' wraps open with the raw tokens and not with each other; `withLibraryKey` yields the key and zeroes it afterwards (the buffer passed to `fn` is all zeros after the call); expired or unknown token rejects; a consumed refresh token cannot be consumed twice.

---

### Task 4: OAuth provider and metadata

**Files:** `app/server/mcp/oauth-provider.ts`, `app/server/mcp/oauth-metadata.ts` (+ tests)

As Bookplate, minus the user: `exchangeAuthorizationCode` consumes the code, derives `k_code` from the presented code, opens the wrap with the code's AAD (a failure is `invalid_grant`, not a 500), issues tokens under the opened key, zeroes it. `exchangeRefreshToken` likewise with the refresh wrap. `verifyAccessToken` returns `AuthInfo` with `extra: { grantId, libraryId }`. `authorize` redirects to `/connect` with the same parameters Bookplate forwards.

- [x] Tests (translated from Bookplate's `oauth-provider.test.ts`, with codes minted browser-side by a test helper `mintBrowserCode(libraryKey, libraryId)`): register; authorize redirects with every param; unregistered redirect refused; exchange succeeds and the reused code is refused; wrong verifier; wrong redirect; another client's code; refresh rotates and the old one is refused; **a code whose wrap was sealed under a different key is `invalid_grant`**; revoke; metadata documents name `PUBLIC_URL` as the issuer.

---

### Task 5: Router, handler, library reader, server mount

**Files:**
- Create: `app/server/mcp/index.ts` (router), `handler.ts`, `library-reader.ts` (+ tests), `disabled.ts` (the 404 router)
- Modify: `app/server/server.ts` (mount when enabled, else the disabled router), `app/server/routes/status.ts` (`mcp: boolean`), `app/server/middleware/rate-limit.ts` (export `resolveClientIp`), `app/server/test-support/harness.ts` (`publicUrl` override already exists; add `mcpBaseUrl` to the harness)
- Create: `app/server/mcp/test-support.ts` (mint a token straight into the tables from an `Owner`, connect an SDK `Client` over Streamable HTTP)

`LibraryReader`: `{ listMeetingIds(): Promise<string[]>; manifest(id) ; transcript(id); labels(id); inferences(id); summary(id); meetingTags(id); tagList() }`, each returning the parsed JSON or `null` when the blob is absent, reading `blobs` rows for `scope = id` (deleted meetings excluded), opening with `blobAad(libraryId, scope, kind, revision)`. A blob that fails to open is `null` (and counted nowhere): one bad file must not hide the corpus, as the Swift listing does.

Handler: bearer verified → `touchGrant` → `withLibraryKey(…, key => { reader = createLibraryReader({ prisma, blobStore, libraryId, key }); server = buildMcpServer({ reader, baseUrl }); transport = StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true }); await server.connect(transport); await transport.handleRequest(req, res, req.body) })`, closing server and transport on `res 'close'`.

- [x] Tests: metadata at the well-known paths (issuer `PUBLIC_URL`); `POST /mcp` without a token is 401 with `resource_metadata`; unknown token 401; `tools/list` through an SDK client names the five tools; **a token whose grant was deleted is 401 and `withLibraryKey` rejects**; with MCP off every MCP path is a JSON 404 and the SPA still serves `/`; `GET /api/v1/status` carries `mcp`.

---

### Task 6: Consent and grants REST routes

**Files:** `app/server/routes/mcp-admin.ts` (+ test), `app/server/test-support/http-vault-client.ts` (methods: `mcpClient`, `mcpAuthorize`, `mcpGrants`, `disconnectMcpGrant`)

- `GET /api/v1/mcp/clients/:clientId` (owner) → `{ clientId, clientName, clientUri }` or 404.
- `POST /api/v1/mcp/authorize` (owner): body as Bookplate's `inputSchema` plus `codeHash` (64 hex) and `wrap` (a sealed 32-byte key, `sealedWrap()`), both required when `approve` is true. Re-validates client and `redirectUriMatches`; answers `{ redirectUrl }` where the URL carries `state` and, for Deny, `error=access_denied`. The browser appends `code` itself: the vault never sees it. 400 `{ error }` with a one-sentence reason otherwise; 404 when MCP is off.
- `GET /api/v1/mcp/grants` (owner) → `{ grants: [{ id, clientName, clientUri, createdAt, lastUsedAt }] }`.
- `DELETE /api/v1/mcp/grants/:id` (owner) → 204; idempotent.

- [x] Tests: approve writes a grant and a code row with the given hash and wrap and returns the registered URI with `state`; deny returns `error=access_denied` and writes nothing; an unregistered URI is 400 for both; a second approval for the same client drops the first client's tokens; grants list and disconnect; a device token may also call these (owner auth), a bare request is 401.

---

### Task 7: The five tools (port of ScribeMCP)

**Files:** `app/server/mcp/queries/{types,budget,fuzzy,resolved,tags,summary,meetings,search,transcript,speakers,arguments,errors}.ts`, `app/server/mcp/tools.ts` (catalog: schemas copied from `ToolCatalog.swift`, dispatch, `reply`), `app/server/mcp/server.ts` (`buildMcpServer`), tests beside each.

Port rules: same ordering and tiebreaks; `ResponseBudget.fit` measures `JSON.stringify` of each item with sorted keys (a tiny stable-stringify helper) so the budget counts what the stdio door counts, within a few bytes; dates emitted with `toISOString()`; fields that Swift encodes with `encodeIfPresent` are omitted when `undefined`, and `cluster_id` / `enrolled_voice_id` keep their explicit `null`; `MeetingCursor` is `<startedAt ms>#<id>`; search and speakers cursors are counts; `timestamp()` is `HH:MM:SS`; the instructions text is Scribe's with the one sentence about `scribe://` links kept (it is excluded from conformance either way) and the server name `scribe`, version `APP_VERSION`.

- [x] Tests translated from `SearchQueryTests`, `MeetingQueryTests`, `TranscriptQueryTests`, `SpeakerQueryTests`, `ResponseBudgetTests`, `TagPayloadTests`, `SummaryPayloadTests`, `ToolCatalogTests` (the lenient-argument and refusal cases, "every declared parameter is one the handler reads", "no payload carries an embedding") over an in-memory `LibraryReader` fake, so they need no vault; plus one test that drives every tool through `POST /mcp` against a real harness with sealed blobs.

---

### Task 8: Log-safety test

**File:** `app/server/log-safety.test.ts`

Reads every `app/server/**/*.ts` outside tests and `node_modules`; asserts (a) no file under `mcp/queries/`, nor `mcp/library-reader.ts`, `mcp/tools.ts`, `mcp/server.ts`, imports `../logger` or `./logger`; (b) for every `log.<level>(` call site in the tree, no `${…}` interpolation's source text matches `/\b(title|text|token|code|secret|plaintext|transcript|summary|speaker|label|wrap|password|query|libraryKey|authKey|kek|lk|key)\b/i` unless the expression is on a small allowlist (`kind`, identifiers ending in `Id`, `.length`, `.size`, `count`, `status`, `reason`, `err.message`, `err.name`). The test names the file, line and expression on failure.

---

### Task 9: Job queue

**Files:** `app/server/services/jobs.ts` (+ test), `app/server/routes/jobs.ts` (+ test), client methods `enqueueJob`, `listJobs`, `claimJob`, `heartbeatJob`, `completeJob` and the constants `JOB_LEASE_MS`, `JOB_HEARTBEAT_INTERVAL_MS` in `http-vault-client.ts`, `scripts/vault-cli.ts` (`jobs enqueue|claim|heartbeat|complete|list`), `server.ts` mount.

Routes: `POST /api/v1/jobs {meetingId, reason}` → 201 (or 200 when a queued job for that meeting exists), 404 for an unknown or deleted meeting; `GET /api/v1/jobs` → `{ depth, leased, recent[10] }`; `POST /api/v1/jobs/claim` → 200 `{ job }` or 204; `POST /api/v1/jobs/:id/heartbeat` → 200 `{ leaseExpiresAt }`, 409 when not this device's live lease; `POST /api/v1/jobs/:id/complete {outcome:'ok'|'failed', note?}` → 200, same 409. Claim runs under `withKeyLock('jobs')`: the oldest queued or lapsed job; a lapse increments `attempts`, and the third lapse fails the job instead of handing it out.

- [x] Tests: enqueue, dedupe, unknown meeting; claim order and 204 on empty; two concurrent claims hand out two different jobs, or one job and a 204; heartbeat extends; after the lease lapses another device claims it and the first device's heartbeat and complete are 409; the third lapse fails the job; complete records outcome and the admin summary shows depth and recent outcomes; session callers may enqueue and list but not claim (401).

---

### Task 10: SPA, consent page

**Files:** `app/client/src/lib/connect.ts` (+ test), `app/client/src/page/connect/{index.tsx,style.ts,index.test.tsx}`, `app/client/src/router/{path-internal.ts,path.ts,component.tsx}`, `app/client/src/lib/seal.ts` and `kdf.ts` (from Task 2), `app/client/src/page/index.ts`.

`approveConnection({ request, password, secretKey })`: salts → derive → `GET /api/v1/library` → open the password wrap → mint 32-byte code → `deriveTokenKek` → `seal(k, LK, tokenWrapAad(libraryId, 'code', codeHash))` → `POST /api/v1/mcp/authorize` → returns `redirectUrl` with `code` appended. `denyConnection(request)` → `redirectUrl`. Secrets never reach a string shown anywhere.

Page copy: title *Connect {clientName}?*; lead *This assistant will be able to read your meetings through your vault while connected. Disconnect it here at any time.*; a line *It can search and read transcripts, meetings and speakers. It cannot change anything.*; Approve opens `PasswordPromptModal` (title *Unlock for this assistant*, confirm *Approve*, `askSecretKey` when none is remembered) with the explanation *Your password unwraps the Library Key here, in your browser, so the vault can answer the assistant.* Deny needs no password. Failures use `SecurityCard`'s wording.

- [x] Tests: invalid link; unknown client; Approve asks for the password, posts `codeHash` and a `wrap` that opens under the derived key (the test derives it from the generated code captured off the final URL), and navigates to the URL with `code` and `state`; Deny navigates to `error=access_denied` without a password; the route is protected (unauthenticated → `/login` with `from` preserving the query string, which `UnprotectedRoute` already handles).

---

### Task 11: SPA, dashboard cards

**Files:** `app/client/src/component/assistants-card/`, `app/client/src/component/jobs-card/`, `app/client/src/lib/dashboard.ts`, `app/client/src/page/dashboard/index.tsx` (+ tests), `app/client/src/component/index.ts`.

Assistants: one `CardRow` per grant (name, link when `clientUri`, *Connected <date> · Last used <relative>*), Disconnect with `ConfirmModal` (*Disconnect {name}? It can no longer read your meetings. Its tokens stop working now.*). Empty: *No assistants connected.*, and when `status.mcp` is false a second line *Set PUBLIC_URL to an https origin to turn the MCP endpoint on.* Jobs: *Queue depth* and *In progress* as a `dl` like `StorageCard`, then up to ten recent outcomes (meeting id shortened to 8 characters, outcome, relative time). Empty: *No jobs yet.*

- [x] Tests mirror `device-list` and `dashboard` suites: rows render from the API, Disconnect confirms then `DELETE`s then refetches, failure toasts, the MCP-off hint.

---

### Task 12: Conformance test

**Files:** `app/server/mcp/conformance.test.ts`, `app/server/mcp/conformance-support.ts`, `test/conformance/` (from Task 1).

Reads `test/conformance/{store,script.json,expected.json}`; `describe.skipIf(!exists)` with the reason *run Scripts/export-mcp-conformance.sh in the Scribe repo*. Creates a harness and owner, seals every artifact file of every `store/Meetings/<UUID>/` into the meeting's blob of the matching kind under the lowercase id (and `store/tags.json` as `tag-list`), mints a token, connects an SDK client, runs the script with the same `follow` semantics, and compares `normalize(actual)` to `normalize(expected)` per step and `tools/list` to `expected.tools`. `normalize`: drop `next_cursor`; lowercase every string that is a UUID; replace every string that parses as ISO-8601 with its epoch milliseconds; sort object keys. Errors compare their text.

---

### Task 13: CLI, CI, README

- `scripts/vault-cli.ts`: the five `jobs` subcommands (Task 9) and `assistants` (list grants) for completeness; `--help` updated.
- `.github/workflows/ci.yml`: the smoke test gains a container with `PUBLIC_URL=https://vault.example` asserting `GET /.well-known/oauth-authorization-server` is 200 with that issuer and `POST /mcp` without a token is 401 with a `WWW-Authenticate` header; the existing no-`PUBLIC_URL` container asserts both are 404 JSON.
- `README.md`: Configuration row for `PUBLIC_URL` says MCP turns on when it is https (already) and names the consent flow; Surfaces table lists `/mcp` as real; a new **Connecting an assistant** section (add `https://<host>/mcp` as a custom connector, approve in the browser with your password, Disconnect from the admin page) with the §10 boundary sentence; "What the vault stores" gains grants, tokens and jobs; **Reprocessing** paragraph under Usage; the CLI section lists `jobs`.

---

### Task 14: Acceptance (owner-run)

Deploy the merged PR to Coolify; add `https://<domain>/mcp` as a custom connector in claude.ai; complete consent; list meetings and search a transcript; Disconnect from the admin page; confirm the connector fails. Watch the logs for anything that is not an id, a count or a status.
