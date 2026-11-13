# Scribe — The Vault as a Docker Service

**Date:** 2026-11-13
**Status:** Draft for the owner's approval

This is a delta to the Home Assistant vault design
(`2026-11-05-scribe-home-assistant-design.md`). Everything that document
says about keys, blobs, the change log, uploads, devices, recovery and the
admin page still holds. This document changes only how the vault is
packaged, configured, deployed and first set up. Where the two disagree,
this one wins.

## 1. Overview

The owner now runs Coolify on a second small ARM board and wants the vault
there first, with Home Assistant as a later, optional home. Coolify is
pointed at this GitHub repository and builds whatever `Dockerfile` it finds
at the root. The owner then sets a domain and a few environment variables
in Coolify's UI, and traffic arrives through the owner's existing HTTPS
tunnel, which hands requests to Coolify's proxy.

So the vault becomes an ordinary container first and an add-on second. The
image already starts from `node:24-alpine` with no supervisor dependency;
what is missing is the surface a plain Docker host expects: configuration
by environment variables for every knob, one volume that holds all state, a
health check, a non-root user, a deployable compose file, and a published
image. The one product gap is first-run setup: today the library can only
be created by Scribe (not built yet) or the CLI test client. After this
work, the vault's own web page creates it.

### Goals

- Coolify builds the root `Dockerfile` on an arm64 board and runs the
  result with no file but the image, two or three environment variables and
  one persistent volume.
- The same image runs with `docker compose up` on any Linux host, and as
  the Home Assistant add-on, unchanged.
- A fresh vault is set up from the browser: password, Secret Key and ten
  recovery codes are produced on the page, the kit is shown, and the
  library is created with the setup code.
- The CLI client (`npm run vault`) round-trips a blob through the tunnel
  against the Coolify deployment. That is the acceptance test.
- The Home Assistant add-on keeps working and keeps releasing; it just stops
  being the primary shape.

### Non-goals

- Connecting Scribe on a Mac (plan 3 of the original design) and the MCP
  endpoint (plan 2). Unchanged and still later.
- Backups. The vault's state is one directory of ciphertext plus one SQLite
  file; the README says that is what to back up. Nothing is built.
- TLS inside the container, or any assumption about which proxy sits in
  front. Coolify's proxy and the tunnel are the owner's.
- Kubernetes, Helm, Nixpacks, a Coolify template submission, rootless
  Podman. Plain Docker and Compose only.
- A PDF or QR kit from the browser. The page shows text and offers a
  plain-text download; the PDF kit stays with Scribe in plan 3.

### Anti-goals

- **State that a rebuild loses.** Coolify rebuilds the image on every push.
  Nothing the vault needs may live outside the mounted volume.
- **A container that is "healthy" while the database is unopenable.** The
  health check must reach the application, not just the port.
- **A second configuration mechanism the operator has to learn.** Home
  Assistant operators keep `options.json`; everyone else uses environment
  variables; the vault reads both with one precedence rule and no other
  source.
- **A setup page that lets a stranger claim a public vault.** The setup
  code gate from the original design stays exactly as strict in the browser
  flow as it is in the API.

### Decided constraints

- **Coolify, build from Git, Dockerfile build pack.** The owner pushes to
  GitHub; Coolify clones and runs `docker build` on the board. Builds must
  succeed natively on arm64 and on amd64 (CI), so nothing in the build may
  depend on the host's architecture beyond what the Dockerfile already
  handles.
- **Two proxies in front.** Cloudflare Tunnel → Coolify's proxy →
  container. `TRUST_PROXY_HOPS=2` is the documented value for the owner's
  setup; the default stays `0`.
- **One port, `3000`,** as today. Coolify reads it from `EXPOSE`.
- **The vault's public origin is what the owner typed into Coolify's domain
  field,** set as `PUBLIC_URL`. Never derived from the `Host` header
  (unchanged).

## 2. Configuration

Every knob has an environment variable. `options.json` stays for the
add-on only. Precedence is **environment variable, then `options.json`,
then default**, for every knob, with no exceptions.

| Variable | Default | Add-on option | Purpose |
|---|---|---|---|
| `DATA_DIR` | `/data` | — | SQLite database, upload parts, and by default the blobs. |
| `BLOBS_DIR` | `<DATA_DIR>/blobs` | `library_dir` → `/media/<dir>/blobs` | Where ciphertext blobs live. Set it to split big storage from small. |
| `PORT` | `3000` | — | Listen port. |
| `PUBLIC_URL` | *(none)* | `public_url` | The `https` origin clients use. |
| `TRUST_PROXY_HOPS` | `0` | `trust_proxy_hops` | Proxy hops to trust for the client IP. |
| `SETUP_CODE` | *(none)* | `setup_code` | Gates library creation and the keys-lost reset. At least 12 characters, else treated as unset. |
| `LOG_LEVEL` | `info` | `log_level` | `debug`, `info`, `warn` or `error`. |

Two changes from today:

- **`SETUP_CODE` is new.** When it is set, it wins and `options.json` is
  not consulted for the code. An environment variable cannot change while
  the container runs, so in Docker the "read live" property of the original
  design means: change or remove the variable and redeploy. The README
  tells the operator to remove it once the library exists and set it again
  only for a keys-lost reset. Coolify operators mark it as a runtime (not
  build-time) variable.
- **The default blob location moves under `DATA_DIR`.** With no
  `options.json` and no `BLOBS_DIR`, blobs go to `/data/blobs`, so a plain
  deployment mounts one volume at `/data` and has all its state. The add-on
  is unaffected: its `options.json` always carries `library_dir`, which
  still resolves under `/media`, confined as today.

A misconfigured value never stops the boot, as today: a bad `PUBLIC_URL`
degrades to none with a warning, a bad hop count to `0`, a short setup
code to unset. An environment variable set to the empty string counts as
unset and falls through to `options.json` and then the default, because
compose substitution (`${VAR:-}`) passes empty strings for anything the
operator left out.

No deployment exists today without `options.json`: the dev loop and `make
run` write one, the add-on always has one, and the owner has not deployed
the image anywhere else. So the blob default moves with no migration and
no startup warning.

## 3. The image

The root `Dockerfile` keeps its three-stage shape (builder, prod-deps,
runtime on `node:24-alpine`, with the cross-build handling it already has)
and gains:

- **A non-root process.** The container starts as root, and `run.sh`
  makes `DATA_DIR` and `BLOBS_DIR` owned by the image's `node` user (uid
  1000) and then drops to that user with `su-exec` before starting
  `node`. This is the pattern that works for every mount the vault meets:
  a Docker named volume, a host bind mount, and Home Assistant's `data`
  and `media` directories, which the Supervisor creates root-owned. If the
  container is started with `--user` (or compose `user:`), `run.sh` is
  not root, skips the ownership step and just execs `node`, so an operator
  who prefers a fixed uid can have one. My call; the app itself never
  needs root.
- **A health check.** `HEALTHCHECK` every 30 s, 5 s timeout, 3 retries,
  10 s start period, running `node` against `GET /api/v1/status` on the
  container's own port and failing on anything but a 200 with a JSON body.
  No `curl` or `wget` is added to the image. Coolify shows this state and
  waits for it on deploy.
- **OCI labels**: title, description, source (this repository), version,
  licence.
- **Graceful stop.** Node is PID 1 and the server already handles
  `SIGTERM` and `SIGINT` by closing the listener and the database. `init:
  false` stays in the add-on; a plain `docker run` needs no `--init`.
- **A `.dockerignore`** that keeps `dev-data`, `dev-media`, `node_modules`,
  `.git`, `docs` and the worktrees out of the build context (check what is
  there and add what is missing).

`run.sh` stays as the entrypoint for both shapes: ownership, drop
privileges, exec `node`, nothing else.

## 4. Storage

One directory holds everything:

```
/data
├── db.sqlite        salts, verifiers, wraps, devices, change log, settings
├── uploads/<id>/    parts of in-flight uploads (expire after 7 days)
└── blobs/<aa>/<sha> ciphertext, content-addressed
```

An operator who wants blobs on a bigger disk sets `BLOBS_DIR` and mounts a
second volume. The add-on keeps its two volumes (`data`, `media`) through
`library_dir`.

Backing up is copying `/data` (and `BLOBS_DIR` if split) while the
container is stopped, or using Coolify's volume backup. Everything in it is
ciphertext or operational metadata; the original design's "what stays in
plaintext" list is unchanged.

## 5. Compose

The repository's root `docker-compose.yml` is today the live-reload dev
stack. That is the file Coolify's Compose build pack and any `docker
compose up` would pick, and it would be wrong. So:

- The dev stack moves to `docker-compose.dev.yml`; `scripts/dev-compose.mjs`
  and the Makefile pass `-f` accordingly. `make dev` behaves as before.
- A new root `docker-compose.yml` is the deployable one: one service,
  `build: .`, `image: ghcr.io/korzun/scribe-server`, port `3000`, a named
  volume at `/data`, `restart: unless-stopped`, and an `environment` block
  listing every variable from §2 with `${VAR:-default}` substitution so a
  `.env` file beside it is the whole configuration. A `.env.example`
  documents them. The health check comes from the image.

## 6. Deploying on Coolify

What the owner does, and what the README walks through:

1. New resource → Git repository → this repo, branch `main`, build pack
   **Dockerfile**. Port `3000`.
2. Domain: the hostname the tunnel serves, with `https`. Coolify routes it
   to the container.
3. Environment variables: `PUBLIC_URL` (that origin), `TRUST_PROXY_HOPS=2`,
   `SETUP_CODE` (a long random phrase, runtime variable).
4. Persistent storage: a volume mounted at `/data`.
5. Deploy. Coolify builds, starts, and waits for the health check.
6. Open the domain. The page offers **Create your library** (§7).
7. Afterwards, remove `SETUP_CODE` and redeploy.

Nothing Coolify-specific is committed to the repository. The Dockerfile,
`EXPOSE`, `HEALTHCHECK` and environment variables are the whole contract,
and the same steps work on any host that runs containers.

## 7. First-run setup in the browser

Today the admin page, finding no library, shows a message and waits for
Scribe. After this work it offers setup.

**Route.** `/setup`, unprotected. The login page, when `GET /api/v1/status`
reports no library, links to it (or redirects; the builder chooses, and
the login page's existing "no library" branch becomes that). `/setup` with
a library present redirects to `/login`.

**The page.** One card, in three steps on one screen:

1. **Password and setup code.** A password field with a confirm field, and
   the setup code field. Copy says the password is never sent and cannot
   be recovered without the kit.
2. **Your kit.** On continue, the page generates the Library Key, the
   Secret Key and ten recovery codes in the browser, derives everything per
   the original design's §3 (the same WebCrypto code the recovery and
   password-change flows use), and shows the Secret Key and the ten codes
   as text, with a **Download kit** button that saves a plain-text file
   containing the vault URL, the Secret Key, the codes and one paragraph on
   what each is for. The vault URL is `PUBLIC_URL` when the vault has one,
   else the origin the page is open on; `GET /api/v1/status` gains a
   `publicUrl` field (`null` when unset) so the page can tell.
   A checkbox: *I have saved my Secret Key and recovery
   codes somewhere safe.* The create button is disabled until it is ticked.
3. **Create.** `POST /api/v1/library` with the setup code, salts,
   verifiers and wraps. On 201 the page signs in with the derived auth key
   (the existing session flow), remembers the Secret Key in local storage
   as the login page does, and lands on the dashboard. On 403 (wrong or
   missing setup code) it says so and keeps the generated kit on screen so
   the owner can retry without a new one. On 409 (a library appeared
   meanwhile) it sends the owner to sign in.

**Server change.** `POST /api/v1/library` today requires a `device` name
and returns a device token, because Scribe creates the library and is its
first device. The browser is not a device. The field becomes optional:
when absent, no device row is created and the response carries only
`libraryId`. The existing one-transaction guarantee and the setup-code
check are unchanged. The CLI and the future Scribe flow keep sending a
device.

**Copy** follows the original design's §9 voice: plain, short, says what
is irreversible. Exact strings are the builder's.

**Secure context.** Setup needs WebCrypto, like every other key flow, so it
works only over HTTPS or on `localhost`. The page shows the same "open the
vault over HTTPS" message the other flows use if the API is missing.

## 8. The Home Assistant add-on

Unchanged in behaviour. `config.yaml`, `repository.yaml`, `run.sh`, the
`options.json` reader and the builder-based release stay. Two touches:

- The add-on now runs as the `node` user. Home Assistant's `data` and
  `media` mounts are writable by any uid in practice; the CI add-on smoke
  test proves the image boots and writes with an empty `/data`.
- The README moves Home Assistant from the headline to a section after
  Docker and Coolify, with the same content it has now.

## 9. CI and release

- **CI** keeps its six jobs. The Docker smoke test additionally waits for
  the container to report `healthy` (not just for the port), creates a
  library through the API with `SETUP_CODE` set by environment, and runs
  the same create against a container with no `SETUP_CODE` and expects
  403. The multi-arch build job is unchanged.
- **Release** keeps the add-on images (`ghcr.io/korzun/scribe-{arch}`, via
  home-assistant/builder) and adds one `docker/build-push-action` step that
  publishes a multi-arch manifest from the same Dockerfile, with the same
  channel semantics the add-on images have: a pre-release pushes
  `ghcr.io/korzun/scribe-server:<version>` and `:beta`; a stable release
  pushes `:<version>`, `:latest`, and re-points `:beta` as the beta-channel
  sync job does today, so `:beta` is never behind `:latest`. The compose
  file's `image:` refers to it. The package is private on GHCR until the
  owner makes it public once, in the package settings; the release
  checklist in the README says so. Coolify does not need it; anyone
  deploying by image name does.

## 10. README

Reordered, not rewritten: intro (the vault, now "a self-hosted service,
also packaged as a Home Assistant add-on"), **Quick start with Docker
Compose**, **Deploying on Coolify** (§6 verbatim), **Configuration** (the
§2 table, env-first, with the add-on column), **First run** (§7 from the
owner's side), **What the vault stores**, **Recovery**, **Backups** (§4's
last paragraph), **Home Assistant add-on** (the current install and
options text), **Development**, **Release channels**. The "needs HTTPS or
localhost" note stays prominent.

## 11. Testing

- `config.test.ts`: every variable from §2, precedence env > options >
  default for each, the short-setup-code rule for both sources, and the
  new default blob path with and without `options.json`.
- `routes/library.test.ts`: creation without `device` returns 201 and
  `{ libraryId }` only, creates no device row; with `device` behaves as
  today. `routes/status.test.ts`: `publicUrl` present and `null` when
  unset.
- Client: a `setup` page test suite covering the three steps, the disabled
  create button, the 403 and 409 branches, the download's content, and
  that the login page routes to setup when no library exists.
- CI smoke test as in §9. Compose file validated with `docker compose
  config` in CI's lint job.
- Acceptance, by hand: deploy on the owner's Coolify, create the library
  in the browser through the tunnel, run `npm run vault -- put` and `get`
  against it.

## 12. Build order

1. Configuration: `SETUP_CODE`, blob default, precedence, tests.
2. Image: user, health check, labels, `.dockerignore`; CI smoke test.
3. Compose: rename dev, add deployable file and `.env.example`, Makefile.
4. Server: optional `device` on create.
5. Client: setup page and login routing.
6. Release workflow: multi-arch image publish.
7. README.

Each step leaves the add-on working.

## 13. Calls made in this document, for the owner to check

- Setup happens in the browser, not the CLI or Scribe (the owner said it
  does not matter; this makes the vault usable alone).
- One volume at `/data` by default; blobs split only by choice.
- The container starts as root only to take ownership of its mounts, then
  runs as the `node` user; `--user` skips that and is honoured.
- The dev compose file is renamed so the root compose file is deployable.
- A multi-arch `scribe-server` image is published on release, in addition
  to the add-on images.
- `device` becomes optional on library creation.
- No PDF or QR kit from the browser; plain text and a download.
- `TRUST_PROXY_HOPS=2` documented for tunnel plus Coolify.
- Backups are documentation only.
- An empty environment variable means unset.
- `:beta` and `:latest` on the published image follow the add-on's
  channel rules; making the GHCR package public is a one-time step for
  the owner.
- The kit's URL is `PUBLIC_URL` when set, else the page's own origin, via
  a new `publicUrl` field on the status endpoint.
