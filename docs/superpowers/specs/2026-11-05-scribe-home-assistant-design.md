# Scribe — The Home Assistant Vault

**Date:** 2026-11-05
**Status:** Approved design, ready for implementation planning

## 1. Overview

A Scribe library lives on the Mac that recorded it. The iCloud Drive design
of 2026-09-02 lets the transcript half of each meeting follow the owner to a
second Mac, but audio never leaves the recording machine, voiceprints never
leave any machine, there is no copy of anything the owner can reach from a
phone, and every hour of WAV stays on a laptop drive until the owner deletes
it by hand. The read-only MCP server works only while a Mac is open.

This design adds a Home Assistant add-on, running on the owner's Raspberry
Pi 5, that becomes the one copy of the library: audio, transcripts,
speakers, summaries, tags, calendar details, the voiceprints and the tag
list. Every Mac the owner runs Scribe on writes to it and reads from it.
It hosts a remote MCP server reachable through the owner's Cloudflare
Tunnel, so an assistant on a phone or in the cloud can read the library
whether or not a Mac is awake. It holds the audio so that a Mac can delete
its WAVs, and so that when Scribe's models improve, any idle Mac can pull a
meeting back down and process it again.

Everything the add-on stores is encrypted with keys only the owner's
devices hold. The Pi never sees a transcript in the clear except in memory,
while answering an MCP call, on behalf of an assistant the owner approved.

### What this is not: a server that thinks

The Pi 5 has 4 GB of RAM and a Hailo-8, which runs only the smallest
Whisper models and is not a fit for speaker diarization at all. Scribe's
pipeline on an M-series Mac — Apple SpeechAnalyzer, pyannote on Core ML
through FluidAudio, FoundationModels for summaries and tags — produces
better transcripts than anything that machine could. So the words are made
on the Mac, as today. The Pi keeps the record. Encryption at rest makes
that division permanent: a machine that cannot read the audio cannot
process it, and that is the point.

### Goals

- The library is reachable by an MCP client from anywhere, through the
  owner's Cloudflare Tunnel, with no Mac open.
- Every Mac sees the same meetings, the same people and the same tags,
  because there is one library and one set of voiceprints.
- Audio survives, on the Pi, so that a better model can be run over the
  whole archive later; a Mac keeps no WAVs once the Pi has them.
- Nothing stored on the Pi is readable without keys the owner holds. A
  stolen NVMe, a Home Assistant backup shipped to Nabu Casa or Google
  Drive, another add-on reading `/media`: none of them yields a word.
- A Mac records and processes exactly as today when the Pi is unreachable.
  The vault is somewhere the result goes, never something recording waits
  on.

### Non-goals (v1)

- Processing of any kind on the Pi. No transcription, diarization,
  summarizing, tagging, transcoding or indexing.
- More than one owner. One library, one password, several Macs.
- A web library. The web page is admin only: devices, assistants, storage,
  recovery. Reading a transcript in a browser is a later design.
- Audio playback, anywhere.
- Writes through the remote MCP. It is read-only, like `scribe-mcp` today.
- Home Assistant entities, events or automations. Deferred, see §12.
- A plaintext full-text index on the Pi. Search decrypts and scans.

### Anti-goals

These would make the work a failure even if every test passed.

- **A deleted WAV the Pi does not have.** A Mac deletes audio only after
  the Pi has confirmed the stored ciphertext by hash, byte for byte.
- **Plaintext at rest on the Pi, anywhere.** Not in blobs, not in SQLite,
  not in logs, not in a crash dump path the builder forgot. No log line
  ever contains a title, a name, or a line of transcript.
- **Two sources of truth.** iCloud Drive sync retires. There is the Pi, and
  there are caches.
- **A Mac that cannot record because the Pi is down.** Capture, processing
  and the Library window never block on the network.
- **Two MCP servers that disagree.** The remote server and the stdio server
  expose the same tool names with the same payload shapes, checked by a
  shared fixture.
- **A library the owner locks themself out of by surprise.** Unrecoverable
  is the design; unrecoverable without having been told, with a kit in
  hand, is a failure.

### Decided constraints

- **The Pi is a Raspberry Pi 5, 4 GB RAM, 1 TB NVMe, Home Assistant OS.**
  The add-on targets `aarch64` first and `amd64` for development and CI;
  32-bit ARM only if the dependencies make it free.
- **Reached at a Cloudflare Tunnel hostname**, e.g. `scribe.example.com`,
  by every client, the Macs included. There is one URL. The add-on binds
  a port; the tunnel is the owner's. Consequences: `public_url` is an
  add-on option, MCP turns on only when it is `https`, and a single
  request body cannot exceed Cloudflare's 100 MB cap, which rules out
  single-request audio upload. Bulk traffic goes through the tunnel too:
  a whole-library reprocess is on the order of 10 GB of FLAC coming back
  down, a one-time half hour or so on a typical home uplink, accepted for
  v1. A LAN fast path is deferred (§12).
- **Bookplate is the template.** Same packaging, same release pipeline,
  same server and client stack, same OAuth shape for MCP, same house
  style. Where this design says nothing, do what Bookplate does.
- **The Mac holds the keys.** Scribe gets its first outbound network code
  and its first use of CryptoKit for anything but hashing. Both live in
  one new module so the rest of the app stays as network-free as it is.

## 2. Roles

| Party | Owns | Does |
|---|---|---|
| **Scribe on a Mac** | capture, processing, the Library window, a cache | records, transcribes, encrypts, uploads, deletes its WAVs, edits, reprocesses |
| **The vault** (the add-on) | the one copy, the change log, the job queue, the MCP endpoint, the admin page | stores ciphertext, orders changes, hands out jobs, decrypts per MCP call in memory |
| **An MCP client** | a token | reads, through the vault, what the owner approved |
| **A browser** | the admin session | manages devices and assistants, approves MCP connections, uses recovery |

The vault is **the authority**. A Mac's copy of any artifact is a cache of
the vault's; on disagreement the vault wins. Audio is the one thing a Mac
does not cache once uploaded.

## 3. Keys

Envelope encryption, 1Password's two-secret shape. The names below are the
ones the code should use.

| Name | What | Where it lives |
|---|---|---|
| **Library Key** (LK) | 256-bit random. Encrypts every blob. | Mac Keychain. Vault memory, during an MCP call. Never on the vault's disk unwrapped. |
| **Secret Key** (SK) | 128-bit random, shown as `A1-XXXXX-XXXXX-XXXXX-XXXXX-XXXXXX`: a version prefix, then 26 base32 characters in groups of 5-5-5-5-6. | Mac login Keychain. Browser local storage after first entry. The kit. Never sent to the vault. |
| **Password** (P) | Owner's choice. | The owner's head, or their password manager. |
| **Recovery codes** | Ten one-time codes, 16 base32 chars each. | The kit. |

### Derivation

All three runtimes — CryptoKit and CommonCrypto on the Mac, WebCrypto in
the browser, Node's `crypto` on the vault — must derive identical bytes,
which is why the KDF is PBKDF2 and not Argon2: WebCrypto has no Argon2. The
Secret Key supplies the entropy a memory-hard KDF would otherwise be
buying, exactly as in 1Password's design.

```
k_pw   = PBKDF2-HMAC-SHA256(P, salt_pw, 650_000 iterations, 32 bytes)
k_sk   = HKDF-SHA256(ikm = SK, salt = salt_pw, info = "scribe/v1/secret-key", 32 bytes)
AUK    = k_pw XOR k_sk                      # account unlock key
KEK    = HKDF-SHA256(AUK, info = "scribe/v1/kek", 32)      # wraps LK
AuthK  = HKDF-SHA256(AUK, info = "scribe/v1/auth", 32)     # sent as the password
```

The vault stores `salt_pw`, `argon2id(AuthK)` as the login verifier, and
`wrap(KEK, LK)`. It can authenticate the owner and hand back the wrapped
Library Key; it cannot unwrap it. Changing the password rewraps LK under a
new KEK; no blob is touched.

**The password guards the key; a device token guards the door.** They are
independent. An ordinary password change is made from Scribe's settings
on any enrolled Mac: the owner types the current password, the Mac
derives the current `AuthK` to authorize the call, derives a new
`salt_pw`, verifier and wrap from the new password, and `PUT`s them. The
vault swaps all three atomically. No device token is invalidated by a
password change or by a recovery, and no Mac has to re-authenticate: a
Mac never stores the password, only LK, SK and its token, and none of
those changed. Cutting a Mac off is always and only "revoke device" on the
admin page. The one consequence worth saying aloud: a stolen Mac keeps
working until the owner revokes it, whatever happens to the password.

A recovery code `c` derives the same way with `c` in place of `P` and its
own salt: the vault stores, per code, `salt_c`, `argon2id(AuthK_c)` and
`wrap(KEK_c, LK)`. Using a code authenticates with `AuthK_c`, unwraps LK
client-side, sets a new password (new `salt_pw`, new verifier, new wrap),
and the vault deletes that code's row. Codes are single-use, enforced by
the vault. Regenerating codes replaces all ten. A code without the Secret
Key is useless, which is the second dimension the owner asked for.

### Blobs

Every artifact and every audio file is one blob:

```
magic "SCRB" | version u8 = 1 | nonce 12 bytes | AES-256-GCM ciphertext | tag 16 bytes
AAD = library_id || meeting_id || blob_kind || revision     (UTF-8, '/'-joined)
```

Key is LK directly, nonce random per blob. The AAD binds a blob to its
place: the vault cannot swap one meeting's transcript for another's, or roll
a revision back, without the authentication failing on the Mac. Whole-file
GCM is fine at these sizes (artifacts are KB to low MB; FLAC audio is tens
of MB) and the vault never decrypts audio at all. If the builder finds
whole-file decryption of audio a memory problem on the Mac, a chunked AEAD
for audio blobs only is acceptable, as blob version 2, without changing
anything else in this document.

### Test vectors

One JSON file of known-answer vectors — inputs, salts, every intermediate
key, a wrapped LK, an encrypted blob — is committed in this repository and
copied verbatim into Scribe's tests. Both suites run it. This is the only
thing standing between "three implementations of the same KDF" and "three
KDFs".

### What stays in plaintext on the vault

Only what the vault needs to operate with no key in hand:

- library id; the salts and verifiers above; the wrapped Library Keys.
- per meeting: id, blob kinds present, byte sizes, SHA-256 of each
  ciphertext, revision numbers, which device uploaded, the vault's own
  timestamps.
- the change log (§6), the job queue (§8), devices, grants, tokens.

Not: titles, start and end times, durations, attendees, speaker names,
tags, text. The vault's `uploaded_at` leaks roughly when meetings happen.
That is accepted and said here so no one later mistakes it for an
oversight.

## 4. The vault

### Packaging

`config.yaml` in Bookplate's shape. Slug `scribe`, image
`ghcr.io/korzun/scribe-{arch}`, `map: [media:rw, data:rw]`, one port.
Options:

| Option | Default | Purpose |
|---|---|---|
| `public_url` | *(none)* | The `https` origin the tunnel serves. Required for MCP, and for the connect flow's issuer. Never derived from the `Host` header. |
| `trust_proxy_hops` | `0` | As Bookplate. Behind the tunnel it is `1`. |
| `library_dir` | `scribe` | Sub-directory of `/media` holding blobs. |
| `setup_code` | *(none)* | A string the owner sets in Home Assistant. Presenting it is what authorizes the two actions the vault's own cryptography cannot: creating the library on a fresh vault, and deleting a library whose keys are lost (§9). Read live from `options.json` on each such request, never cached, so changing the option and restarting rotates it. This is how a vault on a public hostname is not claimable by whoever finds it first. |
| `log_level` | `info` | |

There is no `username`/`password` option. The password is half of the
Library Key's wrapping and does not belong in `options.json`.

Blobs live under `/media/<library_dir>/blobs/<first two hex of sha256>/<sha256>`
— content-addressed, so a re-upload of identical ciphertext is a no-op and
integrity is checkable by `ls`. SQLite is at `/data/db.sqlite`. Home
Assistant backups may include either; both are safe to ship anywhere,
which is the whole reason for §3. The admin page shows blob storage used so
the owner can decide whether to exclude `/media` from backups for size.

### Stack

Express 5, Prisma 7 on better-sqlite3 with Bookplate's migration runner,
React 19 with Vite and react-jss for the admin page, vitest, oxlint and
oxfmt, the same CI, the same four release workflows, the same
`watch-release.mjs`. The MCP transport and OAuth come from
`@modelcontextprotocol/sdk` as in Bookplate. GraphQL is **not** carried
over: the admin page has a dozen operations and the device API is a REST
contract that a Swift client consumes, so one REST surface serves both.

### Surfaces

| Path | For | Auth |
|---|---|---|
| `/` | admin page (SPA) | session: `AuthK` login, JWT + refresh cookie as Bookplate |
| `/api/v1/...` | device API, admin API | device token (Macs) or session (browser) |
| `/mcp`, `/mcp/oauth/*`, `/.well-known/*` | remote MCP | OAuth 2.1, PKCE, dynamic registration |

## 5. Devices and the first Mac

**Creating the library** happens once, from Scribe's settings on the first
Mac. The Mac generates LK and SK, asks for a password, derives everything
in §3, generates ten recovery codes and their wraps, and calls
`POST /api/v1/library` with the setup code, the salts, the verifiers and
the wraps. The vault refuses if a library already exists. The response is
the first device token. Scribe then shows the kit (§9) and insists the
owner save it before continuing.

**Enrolling another Mac**: the owner enters the vault URL, the password and
the Secret Key, typed, pasted from the kit, or scanned from the first
Mac's QR. The Mac derives `AuthK`, calls `POST /api/v1/devices` with a
device name, receives the wrapped LK and a device token, unwraps LK
locally and stores LK, SK and the token in its login Keychain.

iCloud Keychain is **not** used. Synchronizable Keychain items need the
data-protection keychain and a keychain-access-groups entitlement, which
only a team-signed app gets, and Scribe is signed with a local identity
(`docs/creating-the-signing-identity.md` in the Scribe repo). The kit, the
QR and paste are the whole enrolment story. Should the signing identity
ever change, iCloud Keychain is a small addition, not a redesign.

**Device tokens** are opaque 32-byte secrets, stored hashed, long-lived,
one per Mac, revocable from the admin page, which lists each device with
its name, enrolment date and last-seen time. Revoking a device does not
rotate LK — a revoked Mac that already held LK can read blobs it already
had, and nothing can change that. What revocation stops is any further
access to the vault.

## 6. The library on the vault, and how it changes

### Shape

A meeting is a set of blobs by kind:

| Kind | From Scribe's | Notes |
|---|---|---|
| `manifest` | `manifest.json` | gains `processedWith` (§8) |
| `transcript` | `transcript.json` | |
| `diarization` | `diarization.json` | carries per-segment embeddings; encrypted like everything else |
| `labels` | `labels.json` | |
| `inferences` | `inferences.json` | |
| `summary` | `summary.json` | |
| `tags` | `tags.json` (per meeting) | |
| `markdown` | `transcript.md` | kept so `scribe-mcp`'s Share still works from a cache |
| `audio-mic`, `audio-system` | `mic.wav`, `system.wav` | **FLAC**, encoded on the Mac before encryption |

Library-wide blobs, each with its own revision:

| Kind | From | Notes |
|---|---|---|
| `tag-list` | root `tags.json` | one blob |
| `voice/<uuid>` | one entry of `voiceprints.json` | **one blob per voiceprint**, so two Macs that each learned a different voice in the same minute do not overwrite each other's work. `VoiceprintStore` splits and joins; its callers do not change. |

Scratch bundles (enrolment clips) are never uploaded.

### The change log

Every write to the vault appends one row to a single library-wide log:

```
seq (monotonic) | meeting_id? | kind | revision | sha256 | size | deleted | device_id | at
```

A Mac syncs by `GET /api/v1/changes?since=<seq>`, pages through, and for
each row decides whether it needs the blob (artifacts: yes, unless the
hash matches what it has; audio: no, unless a job asked for it). A Mac
stores its `last_seq`. This is the whole sync protocol. It is pull-based
and polled; a Mac polls on a timer while running and immediately after
its own writes. No push, no websockets, in v1.

### Writes and conflicts

`PUT /api/v1/meetings/<id>/blobs/<kind>` carries the ciphertext, its
SHA-256, and `If-Match: <revision>` (or `If-None-Match: *` for a first
write). A mismatch is `409` with the current revision; the Mac fetches the
current blob, re-applies its change, and retries. For every kind but one
that re-application is "write mine" because the Mac that processed the
meeting is the only writer. The exception is `labels`, where two Macs can
both be renaming speakers. Its re-application is a three-way merge with
no format change: base is the revision the Mac last synced (it keeps it in
`vault.json`'s shadow copy), theirs is the vault's current blob, mine is
the local file. Per speaker ref: if only one side changed it from base,
that side wins; if both did, mine wins, because the owner is sitting at
this Mac and just typed it. `refusals` are unioned. That is the only merge
in the design, and `labels.json` gains no timestamp to support it.

Deletion is `DELETE /api/v1/meetings/<id>`, which tombstones every blob of
the meeting in the log. A Mac that sees the tombstone removes its cache and
any local audio. Blobs are garbage-collected on the vault after a grace
period of seven days, and the admin page can empty the bin sooner.

## 7. Audio: upload and offload

After processing finishes on the Mac, it uploads the artifacts, then the
audio:

1. Encode each WAV to FLAC with `AVAudioFile` (`kAudioFormatFLAC`).
   Lossless, roughly half the bytes, and decodable by the same API on the
   way back.
2. Encrypt the FLAC into a blob. Compute its SHA-256.
3. `POST /api/v1/uploads` with kind, size and hash → an upload id.
4. `PUT /api/v1/uploads/<id>/parts/<n>` in 16 MiB parts, any order,
   resumable: `GET /api/v1/uploads/<id>` says which parts the vault has.
5. `POST /api/v1/uploads/<id>/complete`. The vault assembles, hashes,
   compares to the declared hash, stores the blob, appends to the log, and
   answers with the hash it computed.
6. The Mac compares that hash to its own. **Only on a match** does it
   delete `mic.wav` and `system.wav`, and the FLAC and ciphertext
   temporaries.

Part size is the builder's to tune below Cloudflare's cap; 16 MiB is the
starting point. Incomplete uploads expire on the vault after seven days.

The upload queue on the Mac is durable — a small JSON file under the local
root — so a Mac that sleeps or quits mid-upload resumes, and a Mac with no
vault configured never creates one. Uploads run in the background, one
meeting at a time, and pause while recording.

**Audio-dependent actions** — reprocessing, enrolling a voice from a
meeting, any future playback — fetch the audio from the vault when it is
not local, decrypt and decode it to a temporary WAV, act, and delete the
temporary. The iCloud design disabled these actions for a meeting whose
audio was elsewhere; this design makes them wait instead.

## 8. Reprocessing

The vault holds a queue; Macs do the work.

- `POST /api/v1/jobs` enqueues `{meeting_id, reason}`. Scribe's Library
  window offers "Reprocess" on a meeting and "Reprocess meetings processed
  before <version>" for the library; both call this.
- A Mac running Scribe that is not recording, not processing, and on mains
  power, polls `POST /api/v1/jobs/claim` and receives at most one job with
  a lease. It heartbeats; a lease that lapses returns the job to the
  queue. It fetches audio, runs the pipeline exactly as a fresh recording
  would, uploads the new artifacts, and completes the job.
- `manifest.processedWith` records the pipeline version that produced the
  current artifacts: a string Scribe bumps whenever a model, the fusion,
  the summarizer or the tagger changes in a way worth re-running. The
  library-wide reprocess is "every meeting whose `processedWith` is older
  than mine".

Reprocessing keeps human corrections exactly as `scribe-cli process` keeps
them today; this design neither improves nor worsens that. The admin page
shows queue depth and the last few outcomes, nothing more.

## 9. The kit, and recovery

The kit is a single page Scribe generates when the library is created and
on request afterwards, exported as PDF and shown on screen:

- the vault URL
- the Secret Key, as text and QR
- the ten recovery codes, marked as used when they are
- one paragraph saying what each is for and that the password is not on
  this page

Scribe refuses to finish library creation until the owner confirms the
kit is saved. The kit is the only copy of the Secret Key outside the Macs
that hold it (§5 says why iCloud Keychain is not one).

**Forgot the password:** admin page → Recover → a code plus the Secret Key
→ set a new password. The Macs notice nothing: their tokens and their LK
are unchanged (§3). Only the next browser sign-in and the next password
change need the new password.

**Lost the Secret Key:** nothing can be done. The admin page says so in
those words, and offers to delete the library and start over. That
deletion cannot be authorized by anything the vault's cryptography knows,
because the owner has lost it, so it is authorized by the one thing
outside it: the `setup_code` option, read live from `options.json` at the
moment of the request. The flow is "set or change `setup_code` in Home
Assistant, restart the add-on, type it here, type DELETE". The same code
then protects re-creation. Rotating it is editing the option.

**Lost the Macs, have the kit:** enrol a new Mac with the password and the
Secret Key. Every artifact comes down; audio stays on the vault.

## 10. The remote MCP

A TypeScript port of `ScribeMCP`'s five tools, read-only, with the same
names, arguments, payload field names, 25,000-character budget and cursor
semantics as the stdio server: `search_transcripts`, `list_meetings`,
`get_transcript`, `get_meeting`, `list_speakers`. An agent must see one
Scribe through either door.

**Keeping them honest:** `ScribeMCPTests` builds its corpus in code
today and exports nothing, so the first task of the MCP plan is a small
addition in the Scribe repo: a test-only exporter that writes the fixture
corpus as a store on disk plus the parsed JSON results of a fixed script
of tool calls. Both land in this repository under `test/conformance/`,
and the vault's tests encrypt the corpus into a temporary library, run the
same script, and compare **parsed payloads**, not bytes. Excluded from
comparison: cursor and offset strings, which are opaque and valid only at
the door that minted them; the server's `instructions` text and version;
and date formatting, which is compared as instants. Changing a payload
means re-running the exporter and committing in both places, which is
exactly the friction wanted.

**OAuth** is Bookplate's: dynamic client registration, PKCE, opaque
tokens stored hashed, one-hour access and thirty-day refresh tokens, a
consent page in the SPA, and a Disconnect that deletes the grant and kills
every token at once. One scope, `library:read`.

**The key chain through the tokens**, which is what lets the vault
decrypt for a client that cannot:

1. The consent page runs with the owner signed in. It needs the Secret Key
   once per browser, remembered in local storage as 1Password does, and
   asks for the password again at consent to unwrap LK in the browser.
2. The browser generates the authorization code itself (32 random bytes),
   derives `k_code = HKDF(code, "scribe/v1/token-kek")`, and sends the
   vault `hash(code)` and `wrap(k_code, LK)` along with the grant.
3. At the token exchange the vault unwraps LK with the presented code,
   mints the access and refresh tokens, stores `wrap(HKDF(token_secret), LK)`
   for each, deletes the code's wrap, and drops LK from memory.
4. On every `POST /mcp`, the vault unwraps LK with the presented access
   token, decrypts what the tool needs, answers, and drops LK.
5. On refresh, it unwraps with the refresh token and rewraps under the new
   pair.

So the vault's disk holds LK only under keys that exist solely inside
tokens the client holds. Disconnect deletes the wraps. A live, compromised
vault could read what passes through while a token is in use; that is the
boundary, and the README says so.

**Cost.** `list_meetings` decrypts every manifest; `search_transcripts`
decrypts every transcript. At a few hundred meetings that is a few hundred
megabytes of AES-GCM, well under a second on the Pi's ARMv8 crypto
extensions, and a few seconds of JSON parsing in Node. To keep search
pleasant the vault may hold a **per-grant, in-memory** cache of decrypted
search text, bounded at 256 MB total, dropped on token expiry, disconnect
or restart, and never written anywhere. The builder decides whether to
build it in v1 or after measuring.

## 11. Scribe

### New module: `ScribeVault`

Networking (the app's first `URLSession`), CryptoKit and CommonCrypto for
§3, Keychain, FLAC encode and decode, the durable upload queue, the change
log client, the job worker. Depends on `ScribeCore` and `ScribeStore`
only. Nothing else in the package imports Foundation networking, and a
test asserts that `ScribeMCP`, `ScribeCLI` and `ScribePipeline` do not
link it.

### Store

`Store` returns to a single local root. `syncedRoot` and everything the
iCloud design added — routing on the synced manifest, union listing,
`requestSyncedArtifactDownloads`, `awaitingDownload` — comes out once
migration is in. The local root is now a cache plus the recording area:
artifacts are written locally first, as today, then uploaded; artifacts
that arrive from the vault are written into the same directories. A
per-meeting `vault.json` beside the artifacts records each kind's vault
revision and hash, which is what `If-Match` and "do I need this blob"
read.

### Migration from iCloud

On first successful enrolment, with the owner shown what is about to
happen: every bundle under both roots is uploaded — artifacts from
wherever they are, audio where it is local. Progress is visible and
resumable. When the last bundle is confirmed, Scribe stops reading and
writing the CloudDocs folder and tells the owner it may be deleted; it
does not delete it. Each Mac migrates what it has; meetings already in the
vault are skipped by hash. What is lost: `transcript.md` is no longer
readable from Files on an iPhone with no app. That is the price of
encryption, and the design accepts it.

### Settings → Home Assistant

A new tab: vault URL; create library / enrol this Mac / sign out; this
Mac's name; change password; the Secret Key with a QR and a "Show kit"
button; recovery codes (regenerate); status — last sync, queued uploads with sizes,
pending jobs, and whether this Mac is currently eligible to take jobs. A
single switch, "Work on reprocessing jobs on this Mac", default on.

### Copy

The promise moves from "this Mac" to "your own hardware". Drafts, for
the builder to place:

- About: "Records and transcribes your meetings entirely on this Mac.
  Your library lives only on hardware you own, encrypted with keys only
  you hold."
- Onboarding welcome: "Everything — audio, transcripts, voices — is made
  on this Mac and kept on your own devices. Connect your Home Assistant
  later and it holds the encrypted copy."
- Voices: "Voices you have taught Scribe. They never leave your own
  devices unencrypted."
- Info.plist strings keep "on this Mac" where they describe capture and
  transcription, which remains true, and drop "never leave your device".
- The MCP consent page: "This assistant will be able to read your meetings
  through your vault while connected. Disconnect it here at any time."

### What does not change

Recording, the pipeline, corrections, the Library window's behaviour,
`scribe-cli`, and the stdio `scribe-mcp`, which keeps reading the local
cache and now works for every meeting the vault has, audio or not.

## 12. Deferred, and what this opens up

- **Home Assistant events and entities.** A `scribe_meeting_recorded`
  event or a "last meeting" sensor would let automations react. Cheap once
  the vault exists; left out so v1 is one thing.
- **A web library.** Reading transcripts in the browser on a phone needs
  client-side decryption in the SPA, which the consent page already does
  half of.
- **MCP writes.** Renames and tags through the remote server, under a
  `library:write` scope.
- **Multiple owners.** Per-library keys make it structurally possible.
- **Push instead of poll** for change notification.
- **A LAN fast path for the Macs.** A second, home-network URL with
  failover to the tunnel, so reprocessing does not pull gigabytes through
  Cloudflare. Needs a story for TLS or for device tokens on plain HTTP
  before it is worth having.

## 13. Testing

**Vault (vitest):** the §3 vectors; blob encrypt/decrypt with AAD
mismatch rejected; library creation refused twice and refused without the
setup code; device enrolment and revocation; the change log's ordering,
paging and tombstones; `If-Match` conflicts; chunked upload out of order,
resumed, hash mismatch refused, expiry; job claim, heartbeat, lapse,
complete; recovery code single-use and password rotation, with device
tokens surviving both; `setup_code` re-read on every creation and
keys-lost deletion; the MCP conformance fixture; OAuth connect, refresh and disconnect, with a test
that a disconnected token can no longer decrypt; a Docker smoke test as
Bookplate's. A grep-style test that no log call site receives a decrypted
field.

**Scribe (`ScribeVaultTests`, against a stub vault in-process):** the
same vectors; FLAC round trip is sample-exact; the queue survives a
simulated quit; WAVs are deleted only after a matching hash and never on a
mismatch or a network error; `labels` merge; migration uploads from both
roots, skips by hash and is idempotent; a job runs end to end against
fixture audio; the module-boundary test in §11.

## 14. Build order

Four plans, in sequence, each shippable alone:

1. **Vault core:** packaging, crypto, library and devices, blobs, change
   log, uploads, admin page, CI and release. Usable with a small test
   client before Scribe knows it exists.
2. **Vault MCP and jobs.** Begins with the one Scribe-repo task it needs:
   the conformance exporter of §10.
3. **Scribe connects:** `ScribeVault`, settings, migration, artifact sync,
   audio offload, copy. iCloud code removed at the end of this plan.
4. **Scribe reprocesses:** the job worker and the Library buttons.

## 15. Calls made in this document, for the owner to check

- FLAC on the vault, encoded on the Mac.
- PBKDF2 at 650,000 iterations rather than Argon2, for WebCrypto parity.
- Content-addressed blobs under `/media`, database under `/data`.
- A `setup_code` option instead of an admin username and password.
- One blob per voiceprint; `labels` is the only merged artifact.
- Seven-day grace for deleted meetings and abandoned uploads.
- Jobs only on mains power, with an opt-out switch per Mac.
- Audio deleted from the Mac immediately on confirmation, no "keep local
  audio" setting.
- REST only on the vault; no GraphQL.
- The consent page asks for the password again, every time.
- `uploaded_at` left in plaintext.
- A password change or recovery never invalidates a device token; "revoke
  device" is the only way to cut a Mac off.
- `setup_code` is live configuration and gates both creation and
  keys-lost deletion; there is no separate reset option.
- No iCloud Keychain under the current signing identity; the kit, QR and
  paste are the enrolment story.
- `labels` conflicts are a three-way merge with "mine wins" on a true
  collision; no timestamp is added to the file.
- MCP conformance compares parsed payloads and treats cursors as opaque
  per door; the exporter is the first task of plan 2.
- Tunnel only, one URL, for every client (the owner's decision).
