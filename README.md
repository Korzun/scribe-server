# Scribe

[![GitHub Release][release-shield]][releases]
[![Project Stage][stage-shield]][releases]
[![License][license-shield]](#license)

![Supports aarch64][aarch64-shield]
![Supports amd64][amd64-shield]

A self-hosted, encrypted **vault** for Scribe, the macOS meeting recorder, also
packaged as a Home Assistant add-on. It is the one copy of your meeting library,
stored encrypted, that every Mac you run Scribe on writes to and reads from, and
that an AI assistant will be able to reach through a remote **MCP** endpoint
whether or not a Mac is awake. Everything it stores is encrypted with keys only
your devices hold. The vault keeps the record; it does not think. It does no
transcription, diarization, summarizing or tagging (the words are made on the
Mac), and it has no web library: the web page is admin only.

## Quick start with Docker Compose

```bash
git clone https://github.com/Korzun/scribe-server.git && cd scribe-server
cp .env.example .env
# Set SETUP_CODE (a long random phrase, 12+ characters) and, if you have one,
# PUBLIC_URL (the https origin your proxy or tunnel serves).
docker compose up -d
```

Open the vault in a browser (`https://<your-domain>/`, or `http://localhost:3000/`
for a local trial) and follow **Create your library** (see "First run"). Then
remove `SETUP_CODE` from `.env` and run `docker compose up -d` again, so the
code that can create or wipe a library is no longer configured.

Everything the vault needs lives in one named volume mounted at `/data`. The
image is `node:24-alpine` with a built-in health check, and the process drops to
the unprivileged `node` user (uid 1000) after taking ownership of its data
directories.

**Updating:** `git pull && docker compose up -d`. The compose file always builds
from the checkout, so the new code runs; the volume is untouched.

Releases also publish a multi-arch image, `ghcr.io/korzun/scribe-server`
(`:latest`, `:beta`, `:<version>`), for hosts that deploy by image name:

```bash
docker run -d --name scribe --restart unless-stopped -p 3000:3000 \
  -e PUBLIC_URL=https://scribe.example.com -e SETUP_CODE=a-long-random-phrase \
  -v scribe-data:/data ghcr.io/korzun/scribe-server:latest
```

The package has to be public on GHCR for that pull to work without a login.

## Deploying on Coolify

1. **New resource → Git repository**, this repository, branch `main`, build pack
   **Dockerfile**. Port `3000`.
2. **Domain:** the hostname your tunnel or DNS serves, with `https`. Coolify
   routes it to the container.
3. **Environment variables:** `PUBLIC_URL` (that origin), `TRUST_PROXY_HOPS=2`
   when a tunnel sits in front of Coolify's proxy (`1` for the proxy alone), and
   `SETUP_CODE` (a long random phrase, as a runtime variable).
4. **Persistent storage:** a volume mounted at `/data`.
5. **Deploy.** Coolify builds the image on the server, starts it, and waits for
   the health check.
6. Open the domain. The page offers **Create your library**.
7. Afterwards, remove `SETUP_CODE` and redeploy.

Nothing Coolify-specific is in this repository: the `Dockerfile`, its exposed
port and health check, and the environment variables below are the whole
contract, and the same steps work on any host that runs containers.

## Configuration

Every setting is an environment variable. Under Home Assistant the same settings
are add-on options (see "Home Assistant add-on"). Precedence is **environment
variable, then add-on option, then default**, and a variable set to the empty
string counts as unset.

| Variable           | Default            | Add-on option      | Purpose                                                                                                                                                                                                                                                                                               |
| ------------------ | ------------------ | ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DATA_DIR`         | `/data`            | —                  | The SQLite database, in-flight upload parts, and by default the blobs.                                                                                                                                                                                                                                |
| `BLOBS_DIR`        | `<DATA_DIR>/blobs` | `library_dir`      | Where the encrypted blobs live. Set it (and mount a second volume) to keep blobs on a bigger disk. Under the add-on, `library_dir` places them at `/media/<library_dir>/blobs`.                                                                                                                       |
| `PORT`             | `3000`             | —                  | Listen port inside the container.                                                                                                                                                                                                                                                                     |
| `PUBLIC_URL`       | _(none)_           | `public_url`       | The `https` origin clients use (e.g. `https://scribe.example.com`). Never derived from the request. The MCP endpoint and its OAuth server turn on only when this is an `https` origin, and it is their issuer.                                                                                       |
| `TRUST_PROXY_HOPS` | `0`                | `trust_proxy_hops` | Reverse-proxy hops to trust when resolving a client's IP for rate limiting: `1` for one proxy, `2` for a tunnel in front of a proxy. Trusting a hop you don't run lets a client bypass the limiter, so never set it higher than your real proxy count.                                                |
| `SETUP_CODE`       | _(none)_           | `setup_code`       | Authorizes creating the library on a fresh vault and the keys-lost reset (see "Recovery"), so it is what stops a stranger claiming a vault on a public hostname. At least **12 characters**; shorter is ignored as if unset. **Remove it once the library exists** and set it again only for a reset. |
| `LOG_LEVEL`        | `info`             | `log_level`        | `debug`, `info`, `warn` or `error`.                                                                                                                                                                                                                                                                   |

An environment variable is fixed for the life of the container: to change or
remove `SETUP_CODE`, change the variable and redeploy (`docker compose up -d`).
A misconfigured value never stops the vault from starting: a bad `PUBLIC_URL`
degrades to none with a warning, a bad hop count to `0`, a short setup code to
unset.

## First run

A fresh vault has no library. Its page offers **Create your library**:

1. Choose a password and type the setup code. The password is never sent to the
   vault and cannot be recovered without the kit.
2. The page generates your **Secret Key** and **ten one-time recovery codes** in
   the browser and shows them once. **Download kit** saves them as a text file
   with the vault's URL. Tick that you have saved them.
3. **Create library.** The page signs you in and remembers the Secret Key on
   this browser.

Nothing here can be shown again: the kit is the only copy of the Secret Key
outside the devices that hold it. Connecting a Mac is built in Scribe itself (a
later part of this project); it enrols with the password and the Secret Key.

**The page needs HTTPS** (or `localhost`). Setup and sign-in derive your keys in
the browser, and browsers expose WebCrypto only in secure contexts, so over
plain `http://<lan-ip>:3000` neither can work. This is a browser rule, not a
Scribe limitation. Put the vault behind HTTPS (your proxy or tunnel) and open it
there.

## What the vault stores and what it can read

Everything in a meeting (audio, transcript, speakers, summary, tags, calendar
details, voiceprints) is encrypted on your Mac with a Library Key the vault never
holds on its disk unwrapped. A stolen drive, a backup shipped off-site, or
another process reading the volume yields no words. What stays in plaintext on
the vault is only what it needs to operate with no key in hand:

- the library id, the salts and password verifiers, and the wrapped Library Keys;
- per meeting: its id, which blob kinds are present, byte sizes, a SHA-256 of
  each ciphertext, revision numbers, which device uploaded, and the vault's own
  timestamps;
- the change log, devices and tokens;
- the reprocessing job queue (meeting ids, a short reason, who asked, lease and
  outcome) and, for each AI assistant you connect, its registration, its grant,
  and the hashes of its tokens.

Not stored in the clear: titles, start and end times, durations, attendees,
speaker names, tags, or text. The vault's own upload timestamps do reveal roughly
when meetings happen; that is accepted.

The remote MCP endpoint is the one place the vault reads plaintext. To answer an
assistant you approved, it unwraps the Library Key with the assistant's token,
decrypts only what the call needs in memory, answers, and drops the key. The
Library Key sits on the vault's disk only sealed under keys derived from the
assistant's own tokens, which the vault does not keep. **A live, compromised
vault could read what passes through while a token is in use; that is the
boundary.** Disconnecting an assistant deletes its wraps and ends its access at
once. See "Connecting an assistant".

## Usage

The vault serves everything on one port (`3000` inside the container), on the
same origin:

| Service        | Path      | Use it for                                                                                   |
| -------------- | --------- | -------------------------------------------------------------------------------------------- |
| **Admin page** | `/`       | Setup, signing in, devices, assistants, reprocessing, storage, recovery.                     |
| **Device API** | `/api/v1` | What Scribe on your Mac talks to, and the reprocessing job queue.                            |
| **MCP**        | `/mcp`    | Letting an AI assistant read the library over OAuth; served only when `PUBLIC_URL` is https. |

### The admin page

Open `https://<your-host>/` and sign in with your **password and Secret Key**. The
Secret Key is entered once per browser and remembered there.

From the admin page you can:

- **Devices** — see each enrolled Mac, when it last connected, and **revoke** one.
  Revoking is the only way to cut a Mac off: a password change or a recovery does
  not invalidate device tokens.
- **Assistants** — see each AI assistant connected through MCP, when it was
  approved and last used, and **Disconnect** one, which ends its access at once.
- **Reprocessing** — the job queue's depth and the last few outcomes.
- **Storage** — see how much the library holds, and **Empty now** to clear space
  the vault no longer needs.
- **Recover** or change your password and regenerate recovery codes (see
  "Recovery").

### Connecting an assistant

The vault serves a remote **MCP** endpoint at `https://<your-host>/mcp` with
five read-only tools, the same five as Scribe's own `scribe-mcp` on a Mac:
`search_transcripts`, `list_meetings`, `get_transcript`, `get_meeting` and
`list_speakers`. It works whether or not a Mac is awake, and it is on only when
`PUBLIC_URL` is an `https` origin, which is also the OAuth issuer.

1. In your assistant (for example claude.ai → Settings → Connectors → Add
   custom connector), add `https://<your-host>/mcp`. The assistant registers
   itself and sends your browser to the vault's consent page.
2. Sign in if you are not already, read what the assistant will be able to do,
   and press **Approve**. The page asks for your password again, every time: it
   unwraps the Library Key in your browser and seals it under a key only the
   assistant's authorization code can derive. The vault is sent that sealed key
   and the code's hash, never the code or the password.
3. The assistant exchanges the code for tokens. From then on every call it
   makes lets the vault unwrap the Library Key with that token, decrypt what
   the call needs in memory, answer, and drop the key.

To cut an assistant off, press **Disconnect** on the admin page. Its grant and
every token go at once, and the next call it makes fails. Approving the same
assistant again also invalidates the tokens it held before.

What this does not protect against is a vault that is itself compromised while
a token is in use: it could read what passes through. What it does protect is
everything at rest, and everything the moment you disconnect.

### Reprocessing

When Scribe's pipeline improves, a meeting can be run through it again. The
vault only keeps the queue: a Mac asks for a job when it is idle and on mains
power, takes it under a lease, fetches the audio, reprocesses, uploads the new
artifacts and completes the job. The admin page shows how many jobs wait and
how the last few went. Scribe's worker is a later part of this project; until
then `npm run vault -- jobs …` drives the queue by hand (see "Trying it without
Scribe").

### Connect from Scribe on your Mac

Connecting a Mac to the vault is built in Scribe itself (a later part of this
project). Each Mac enrols with the password and the Secret Key.

## Recovery

Your **kit** is the text file from first run: the vault URL, the **Secret Key**,
and **ten one-time recovery codes**, with a note on what each is for. The
password is not on it. The kit is the only copy of the Secret Key outside the
devices that hold it. From the admin page you can regenerate the codes at any
time; the old ones stop working.

- **Forgot the password:** admin page → **Recover** → a recovery code **plus the
  Secret Key** → set a new password. A recovery code without the Secret Key is
  useless. Your Macs notice nothing; their tokens and keys are unchanged.
- **Lost the Macs, have the kit:** enrol a new Mac with the password and the
  Secret Key. Every artifact comes down; audio stays on the vault.
- **Lost the Secret Key:** nothing can be done. The library cannot be opened, by
  you or by anyone else. The admin page offers to delete the library and start
  over, and that is authorized by the setup code: set `SETUP_CODE` (at least 12
  characters) and redeploy, or set the `setup_code` add-on option and restart,
  type it on the admin page, and type `DELETE`. The same code then protects
  re-creating the library.

The setup code gates both creating the library and this reset from anyone who
can reach the vault's address, so it must be at least 12 characters (a shorter
one is ignored, as if unset) and should not stay configured: **once the library
exists, remove it**, and set it again only when a reset is needed.

## Backups

The vault's whole state is the `/data` volume (and `BLOBS_DIR`, if you split
blobs onto a second one): the SQLite database, in-flight upload parts and the
encrypted blobs. Back it up with your host's volume backups, or copy the
directory while the container is stopped. Everything in it is ciphertext or
operational metadata; a backup is no more readable than the disk is. Under Home
Assistant an add-on backup covers the add-on's `data` share only; include the
`media` folder in your Home Assistant backup too, or the blobs are not in it.

The process runs as uid 1000 after taking ownership of those two directories at
start: a directory it does not own yet (a fresh volume, a bind mount, or data an
earlier version wrote as root) is taken over once, recursively. If you start the
container with `--user` (or compose `user:`), that step is skipped and the
directories must already be writable by that user.

## Home Assistant add-on

The same image is a Home Assistant add-on.

1. Navigate to **Settings → Add-ons → Add-on Store** in your Home Assistant UI.
2. Click the ⋮ menu (top-right) → **Repositories**, and add this repository URL:

   ```
   https://github.com/Korzun/scribe-server
   ```

   [![Add repository to your Home Assistant instance][repo-badge]][repo-add]

3. Find **Scribe** in the store and click **Install**.
4. Set `setup_code` in the **Configuration** tab (see below) **before the first
   start**. Creating the library needs it.
5. **Start** the add-on, open its page, and follow **Create your library**.
6. Clear `setup_code` and restart the add-on.

Add-on options (set in the **Configuration** tab) map to the variables in
"Configuration": `library_dir` (default `scribe`; blobs go to
`/media/<library_dir>/blobs`), `public_url`, `trust_proxy_hops`, `setup_code`
(a `password` field; change it and restart the add-on to rotate it) and
`log_level`.

```yaml
library_dir: scribe
public_url: https://scribe.example.com
trust_proxy_hops: 1
setup_code: a-long-random-phrase
log_level: info
```

Add-on state (the SQLite database, which holds the salts, verifiers, devices and
change log) is persisted in the add-on **`data`** volume; encrypted blobs are
stored under the Home Assistant **`media`** share.

## Ports

| Port       | Description                         |
| ---------- | ----------------------------------- |
| `3000/tcp` | Vault: device API, admin page, MCP. |

## Development

The repository is an npm workspace monorepo (`app/server` — Express + Prisma/SQLite;
`app/client` — React + Vite). A `Makefile` and `docker-compose.dev.yml` wrap the common
tasks; the root `docker-compose.yml` is the deployable one described above.

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
will not (see "First run").

### Trying it without Scribe

`npm run vault` is a small command-line client that does what the Mac app does —
creates or joins the library, seals files into meeting blobs, opens them back out —
so you can prove a running vault (`make run`, `make dev`, or a real deployment with
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

Against a library you created in the browser, join it as a device instead:

```bash
npm run vault -- --url https://<your-domain> enrol --name laptop
```

`enrol`, `devices`, `delete <meetingId>` and `assistants` (the connected MCP
clients) are there too, and `jobs` drives the reprocessing queue as a Mac would:

```bash
npm run vault -- jobs enqueue "$U" --reason "new pipeline"   # ask for a meeting to be redone
npm run vault -- jobs claim                                 # take the oldest job under a 15-minute lease
npm run vault -- jobs heartbeat <jobId>                     # keep the lease (a Mac does this every 5 minutes)
npm run vault -- jobs complete <jobId> [--failed] [--note "…"]
npm run vault -- jobs list                                  # depth, live leases, recent outcomes
```

`npm run vault -- --help` lists everything. The device token is cached in `~/.scribe-vault-cli.json` (mode
`0600`) with the vault's URL and the library and device ids; the password and the
Secret Key are only ever read from the environment, never written. Delete the file to
forget the device.

## Release channels

- **Stable** — the default. Released from `main`; regular users are updated here,
  and the image is tagged `:latest` and `:<version>`.
- **Beta** — opt-in pre-release channel, tagged `:beta`. In Home Assistant, add the
  repository, then enable the beta version in the add-on's **Version** section to
  test release candidates early.

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
   multi-arch add-on images and the `ghcr.io/korzun/scribe-server` image, syncs the
   `beta` channel, and creates the GitHub Release. The `scribe-server` package is
   private on GHCR until it is made public once in the package settings.

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
