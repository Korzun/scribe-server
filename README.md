# Scribe

[![GitHub Release][release-shield]][releases]
[![Project Stage][stage-shield]][releases]
[![License][license-shield]](#license)

![Supports aarch64][aarch64-shield]
![Supports amd64][amd64-shield]

A Home Assistant add-on that is the **vault** for Scribe, the macOS meeting
recorder: the one copy of your meeting library, stored encrypted, that every Mac
you run Scribe on writes to and reads from, and that an AI assistant can reach
through a remote **MCP** endpoint whether or not a Mac is awake. Everything it
stores is encrypted with keys only your devices hold. The vault keeps the
record; it does not think. It does no transcription, diarization, summarizing or
tagging (the words are made on the Mac), and it has no web library: the web page
is admin only.

## Installation

1. Navigate to **Settings → Add-ons → Add-on Store** in your Home Assistant UI.
2. Click the ⋮ menu (top-right) → **Repositories**, and add this repository URL:

   ```
   https://github.com/Korzun/scribe-server
   ```

   [![Add repository to your Home Assistant instance][repo-badge]][repo-add]

3. Find **Scribe** in the store and click **Install**.
4. Set `setup_code` in the **Configuration** tab (see below) **before the first
   start**. Creating the library needs it.
5. **Start** the add-on.
6. Connect from Scribe on your Mac (see "Usage" below).

## Configuration

Add-on options (set in the **Configuration** tab):

| Option             | Type     | Default  | Description                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------ | -------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `library_dir`      | string   | `scribe` | Sub-directory under `/media` where the encrypted blobs are stored.                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `public_url`       | string   | _(none)_ | Optional absolute origin this instance is reachable at (e.g. `https://scribe.example.com`). MCP turns on only when this is an **https** origin.                                                                                                                                                                                                                                                                                                                                                          |
| `trust_proxy_hops` | int      | `0`      | Reverse-proxy hops to trust when resolving a client's real IP for rate limiting. Leave at `0` unless you sit behind a reverse proxy or **HTTPS tunnel**; set to `1` for a single such hop. Trusting a hop you don't actually run behind lets a client bypass the limiter, so don't set it higher than your real proxy count.                                                                                                                                                                             |
| `setup_code`       | password | _(none)_ | The key to creating the library, and to the keys-lost reset (see "Recovery"): it gates both from anyone who can reach the vault's address. Must be **at least 12 characters**; a shorter one is ignored as if unset. Re-read live from the add-on's options, so changing it in Home Assistant and restarting the add-on rotates it. Leave it empty and the vault refuses to create or reset a library. **Clear it (and restart) once the library exists**, and set it again only when a reset is needed. |
| `log_level`        | list     | `info`   | Log verbosity: `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |

Example:

```yaml
library_dir: scribe
public_url: https://scribe.example.com
trust_proxy_hops: 1
setup_code: a-long-random-phrase
log_level: info
```

Encrypted blobs are stored under the Home Assistant **`media`** share
(`/media/<library_dir>/blobs`). Add-on state (the SQLite database, which holds the
salts, verifiers, devices and change log) is persisted in the add-on **`data`**
volume.

## What the vault stores and what it can read

Everything in a meeting (audio, transcript, speakers, summary, tags, calendar
details, voiceprints) is encrypted on your Mac with a Library Key the vault never
holds on its disk unwrapped. A stolen drive, a Home Assistant backup shipped to
the cloud, or another add-on reading `/media` yields no words. What stays in
plaintext on the vault is only what it needs to operate with no key in hand:

- the library id, the salts and password verifiers, and the wrapped Library Keys;
- per meeting: its id, which blob kinds are present, byte sizes, a SHA-256 of
  each ciphertext, revision numbers, which device uploaded, and the vault's own
  timestamps;
- the change log, devices and tokens.

Later releases will add a job queue and the grants of the AI assistants you
connect; those will be stored in plaintext the same way.

Not stored in the clear: titles, start and end times, durations, attendees,
speaker names, tags, or text. The vault's own upload timestamps do reveal roughly
when meetings happen; that is accepted.

This release never reads plaintext. A later release will add a remote MCP
endpoint, and that will be the one place the vault can: to answer an assistant
you approved, it will unwrap the Library Key with the assistant's token,
decrypt only what the call needs in memory, answer, and drop the key. A live,
compromised vault could then read what passes through while a token is in use;
that will be the boundary. Disconnecting an assistant will delete its wraps and
end its access at once.

## Usage

The add-on serves everything on port **3000**, on the same host/origin:

| Service        | Path      | Use it for                                                                                   |
| -------------- | --------- | -------------------------------------------------------------------------------------------- |
| **Admin page** | `/`       | Signing in, devices, storage, recovery.                                                      |
| **Device API** | `/api/v1` | What Scribe on your Mac talks to.                                                            |
| **MCP**        | `/mcp`    | Letting an AI assistant read the library (a later part of this project; needs `public_url`). |

### The admin page

Open `https://<your-host>/` and sign in with your **password and Secret Key**. The
Secret Key is entered once per browser and remembered there.

**The admin page needs HTTPS** (or `localhost`). Sign-in derives your keys in the
browser, and browsers expose WebCrypto only in secure contexts, so over plain
`http://<lan-ip>:3000` sign-in cannot work. This is a browser rule, not a Scribe
limitation. Put the instance behind HTTPS (a reverse proxy or an HTTPS
tunnel) and open it there.

From the admin page you can:

- **Devices** — see each enrolled Mac, when it last connected, and **revoke** one.
  Revoking is the only way to cut a Mac off: a password change or a recovery does
  not invalidate device tokens.
- **Storage** — see how much the library holds, and **Empty now** to clear space
  the vault no longer needs.
- **Recover** or change your password and regenerate recovery codes (see
  "Recovery").

### Connect from Scribe on your Mac

Connecting a Mac to the vault is built in Scribe itself (a later part of this
project). The first Mac creates the library and shows you the kit, and each
further Mac enrols with the password and the Secret Key.

## Recovery

When the library is created, Scribe produces a **kit**: a single page with the
vault URL, the **Secret Key** (as text and a QR code), and **ten one-time recovery
codes**, plus a note on what each is for. The password is not on it. Scribe will
not finish creating the library until you confirm the kit is saved. The kit is
the only copy of the Secret Key outside the Macs that hold it.

- **Forgot the password:** admin page → **Recover** → a recovery code **plus the
  Secret Key** → set a new password. A recovery code without the Secret Key is
  useless. Your Macs notice nothing; their tokens and keys are unchanged.
- **Lost the Macs, have the kit:** enrol a new Mac with the password and the
  Secret Key. Every artifact comes down; audio stays on the vault.
- **Lost the Secret Key:** nothing can be done. The library cannot be opened, by
  you or by anyone else. The admin page offers to delete the library and start
  over, and that is authorized by the `setup_code` option, read live at the moment
  of the request: set `setup_code` (at least 12 characters) in Home Assistant,
  restart the add-on, type it on the admin page, and type `DELETE`. The same code
  then protects re-creating the library.

The setup code gates both creating the library and this reset from anyone who
can reach the vault's address, so it must be at least 12 characters (a shorter
one is ignored, as if unset) and should not stay configured: **once the library
exists, clear `setup_code` in the add-on configuration and restart**, and set it
again only when a reset is needed.

## Ports

| Port       | Description                         |
| ---------- | ----------------------------------- |
| `3000/tcp` | Vault: device API, admin page, MCP. |

## Development

The repository is an npm workspace monorepo (`app/server` — Express + Prisma/SQLite;
`app/client` — React + Vite). A `Makefile` and `docker-compose.yml` wrap the common
tasks.

```bash
# Live-reload dev stack: backend on :3000, frontend on :5173
make dev            # writes dev-data/options.json with a dev setup code if absent
                    # PUBLIC_URL=http://localhost:<client port> make dev  to set the advertised origin

# Production-style single container
make run            # build + run at http://localhost:3000
make logs           # tail container logs
make stop           # stop and remove the container

# Native (without Docker)
npm ci
npm run dev         # server, live-reload
npm run dev:client  # client, live-reload
npm run build       # build server + client
npm test            # run server + client tests
npm run lint        # lint server + client
npm run test:scripts  # dev-loop script tests
```

`make dev` creates `dev-data/options.json` containing
`{"setup_code":"dev-setup-code","library_dir":"scribe","log_level":"debug"}` if it
is absent, so the **dev setup code is `dev-setup-code`**. Edit that file to change
it; the server re-reads it live. `dev-data/` and `dev-media/` are git-ignored.

Open the admin page through the client at `http://localhost:5173/`. `localhost` is
a secure context, so WebCrypto works there; a LAN address over plain `http://`
will not (see "Usage").

### Trying it without Scribe

`npm run vault` is a small command-line client that does what the Mac app does —
creates or joins the library, seals files into meeting blobs, opens them back out —
so you can prove a running vault (`make run`, `make dev`, or a real add-on with
`--url`) before Scribe talks to it:

```bash
make run
export SCRIBE_PASSWORD='a long password'
npm run vault -- create --setup-code dev-setup-code   # prints the Secret Key and recovery codes once
export SCRIBE_SECRET_KEY='A1-…'                       # the Secret Key it printed

U=$(uuidgen | tr A-Z a-z)
npm run vault -- put "$U" manifest some.json          # seals, then uploads (in parts above 16 MiB)
npm run vault -- get "$U" manifest out.json           # downloads, then opens
cmp some.json out.json                                # identical
npm run vault -- changes                              # the change log, one line per change
make stop
```

`enrol`, `devices` and `delete <meetingId>` are there too; `npm run vault -- --help`
lists everything. The device token is cached in `~/.scribe-vault-cli.json` (mode
`0600`) with the vault's URL and the library and device ids; the password and the
Secret Key are only ever read from the environment, never written. Delete the file to
forget the device.

### Environment variables (dev / bare-metal)

When not running under Home Assistant, configuration falls back to environment
variables, which override `options.json`:

| Variable           | Default                      | Description                                                                                                                                                   |
| ------------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`         | `/data`                      | Path for `options.json` and the SQLite database.                                                                                                              |
| `BLOBS_DIR`        | `/media/<library_dir>/blobs` | Absolute path to the encrypted blob store.                                                                                                                    |
| `PORT`             | `3000`                       | HTTP listen port.                                                                                                                                             |
| `PUBLIC_URL`       | _(none)_                     | Same as the add-on's `public_url` option above. Optional; MCP turns on only for an https origin (or `http://localhost` for development).                      |
| `TRUST_PROXY_HOPS` | `0`                          | Same as the add-on's `trust_proxy_hops` option above. Leave at `0` unless you run a proxy; trusting a hop you don't control lets a client bypass the limiter. |
| `LOG_LEVEL`        | `info`                       | Log verbosity.                                                                                                                                                |

## Release channels

- **Stable** — the default. Released from `main`; regular Home Assistant users
  are updated here.
- **Beta** — opt-in pre-release channel. Add the repository, then enable the beta
  version in the add-on's **Version** section to test release candidates early.

See [`CHANGELOG.md`](CHANGELOG.md) for release notes.

### Cutting a release

Releasing is on-rails: go to **Actions → Release · Prepare → Run workflow**, enter a
version (e.g. `0.7.0`, or `0.7.0-rc.1` for a pre-release) and pick a channel. The rest is
automatic — you don't push tags or edit versions by hand.

The pipeline never pushes to the protected `main` branch. Instead it flows through a
normal pull request, so releases respect the same branch protection as everything else:

1. **Release · Prepare** — for **stable**, opens a `release/vX.Y.Z` PR that bumps the
   version (`config.yaml`, `package.json`, `package-lock.json`) and prepends a
   `CHANGELOG.md` entry, with auto-merge enabled. For **beta**, it bumps and tags the
   (unprotected) `beta` branch directly.
2. CI runs on the PR; once the required checks pass it rebase-merges automatically.
3. **Release · Finalize** — tags the merge commit `vX.Y.Z`.
4. **Release · Publish** — re-validates the tagged commit, builds and pushes the
   multi-arch add-on images, syncs the `beta` channel, and creates the GitHub Release.

To follow all four steps from a terminal instead of refreshing the Actions tab, run the
watcher with the PR number **Release · Prepare** opened and the version you entered:

```bash
node scripts/watch-release.mjs 241 0.10.0
```

It polls until the release is published (exit `0`), and fails fast — naming the red
checks or the failed workflow — if the release cannot land (exit `1`, or `2` on timeout).

The workflows authenticate as a dedicated **release GitHub App** (repository variable
`RELEASE_APP_ID` + secret `RELEASE_APP_PRIVATE_KEY`, with "Allow auto-merge" enabled in
repo settings). This is required because GitHub's default `GITHUB_TOKEN` cannot trigger
the downstream CI and publish runs on the PRs and tags it creates — it is **not** a
branch-protection bypass. If the release identity is ever rotated, update those two
values; nothing else changes.

## License

No license has been declared for this project yet. All rights reserved by the
author until a license is added.

[releases]: https://github.com/Korzun/scribe-server/releases
[release-shield]: https://img.shields.io/github/v/release/Korzun/scribe-server?style=flat-square
[stage-shield]: https://img.shields.io/badge/project%20stage-development-orange.svg?style=flat-square
[license-shield]: https://img.shields.io/badge/license-all%20rights%20reserved-red.svg?style=flat-square
[aarch64-shield]: https://img.shields.io/badge/aarch64-yes-green.svg?style=flat-square
[amd64-shield]: https://img.shields.io/badge/amd64-yes-green.svg?style=flat-square
[repo-add]: https://my.home-assistant.io/redirect/supervisor_add_addon_repository/?repository_url=https%3A%2F%2Fgithub.com%2FKorzun%2Fscribe-server
[repo-badge]: https://my.home-assistant.io/badges/supervisor_add_addon_repository.svg
