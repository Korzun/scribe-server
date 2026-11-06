/**
 * A small command-line client for a running vault (spec §14, "usable with a
 * small test client"): it creates or joins a library, seals a file into a
 * meeting blob, opens one back out, and reads the change log, the same way
 * the Mac app will. It exists so a human can prove a vault before Scribe
 * talks to it, and so a developer can reproduce a bug against a live one.
 *
 * Every request goes through `HttpVaultClient`, the class the route tests
 * drive over supertest, here over `fetch`: a request the tests prove is the
 * request this sends.
 *
 * Credentials come from the environment (`SCRIBE_PASSWORD`,
 * `SCRIBE_SECRET_KEY`), never from flags, so they stay out of shell history.
 * The device token is cached in `~/.scribe-vault-cli.json` (mode 0600) with
 * the URL and the ids; the password and Secret Key are never written, and the
 * Library Key is unwrapped afresh on each command that needs it. Nothing
 * secret is ever printed, except the kit `create` prints once, by design.
 *
 *   npm run vault -- --help
 */
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseArgs } from 'util';

import { blobAad, open, seal } from '../app/server/crypto/seal';
import { isCanonicalUuid, isMeetingKind } from '../app/server/services/blob-kinds';
import {
  buildLibraryRequest,
  fetchTransport,
  HttpVaultClient,
  type ClientResponse,
} from '../app/server/test-support/http-vault-client';

const MiB = 1024 * 1024;
/** Above this a blob goes up in parts (spec §7), the size the Mac uses. */
const PART_SIZE = 16 * MiB;
const DEFAULT_URL = 'http://localhost:3000';
const CACHE_FILE = path.join(os.homedir(), '.scribe-vault-cli.json');

const HELP = `Usage: npm run vault -- [--url <origin>] <command> [options]

Commands:
  create --setup-code <code> [--name <device>]
                         Create the library (password from SCRIBE_PASSWORD) and
                         print its kit: URL, Secret Key and ten recovery codes
  enrol [--name <device>]
                         Join an existing library as a new device
                         (SCRIBE_PASSWORD and SCRIBE_SECRET_KEY)
  put <meetingId> <kind> <file>
                         Seal <file> and store it as the meeting's <kind>
  get <meetingId> <kind> <out>
                         Fetch the meeting's <kind>, open it, write it to <out>
  changes [--since <seq>]
                         Print the change log, one line per change
  devices                List the library's devices
  delete <meetingId>     Delete a meeting (its blobs go after seven days)

Options:
  --url <origin>         The vault (default ${DEFAULT_URL}, or the cached one)
  -h, --help             Show this help

The device token is cached in ${CACHE_FILE}.
put and get need SCRIBE_PASSWORD and SCRIBE_SECRET_KEY to unwrap the Library Key.`;

/** A failure meant for the user: one line, nothing secret in it. */
class CliError extends Error {}

type Cache = { url: string; deviceId: string; deviceToken: string; libraryId: string };

function readCache(): Cache | null {
  let text: string;
  try {
    text = fs.readFileSync(CACHE_FILE, 'utf8');
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as Cache;
  } catch {
    throw new CliError(`${CACHE_FILE} is not valid JSON; delete it and enrol again`);
  }
}

function writeCache(cache: Cache): void {
  // `mode` applies only when the file is created, so tighten an older one too.
  fs.writeFileSync(CACHE_FILE, `${JSON.stringify(cache, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(CACHE_FILE, 0o600);
}

function env(name: 'SCRIBE_PASSWORD' | 'SCRIBE_SECRET_KEY'): string {
  const value = process.env[name];
  if (value === undefined || value === '') throw new CliError(`${name} is not set`);
  return value;
}

/** Turns a refusal into one line: the status and the vault's own short error, never the body. */
function fail(what: string, res: ClientResponse): never {
  const reason = typeof res.body.error === 'string' ? `: ${res.body.error}` : '';
  throw new CliError(`${what} failed (HTTP ${res.status}${reason})`);
}

function meetingIdArg(raw: string | undefined): string {
  if (raw === undefined || !isCanonicalUuid(raw)) {
    throw new CliError('a meeting id must be a canonical lowercase UUID');
  }
  return raw;
}

function kindArg(raw: string | undefined): string {
  if (raw === undefined || !isMeetingKind(raw)) {
    throw new CliError(`unknown kind ${JSON.stringify(raw ?? '')}`);
  }
  return raw;
}

function positional(args: string[], n: number, usage: string): string[] {
  if (args.length !== n) throw new CliError(`usage: ${usage}`);
  return args;
}

/**
 * A path as the user typed it: `npm run vault` runs this from `app/server`,
 * so relative paths resolve against the directory npm was started in.
 */
const userPath = (p: string) => path.resolve(process.env.INIT_CWD ?? process.cwd(), p);

const defaultName = () => `vault-cli on ${os.hostname()}`;

type Context = {
  url: string;
  client: HttpVaultClient;
  values: { 'setup-code'?: string; name?: string; since?: string };
  args: string[];
};

/** The cached device, provided it belongs to the vault this command talks to. */
function device(ctx: Context): Cache {
  const cache = readCache();
  if (cache === null) throw new CliError(`no device cached in ${CACHE_FILE}; run create or enrol`);
  if (cache.url !== ctx.url) {
    throw new CliError(`the cached device belongs to ${cache.url}, not ${ctx.url}`);
  }
  return cache;
}

/** The Library Key, unwrapped from the vault's password wrap with the env credentials. */
async function libraryKey(ctx: Context, cache: Cache): Promise<Buffer> {
  const password = env('SCRIBE_PASSWORD');
  const secretKey = env('SCRIBE_SECRET_KEY');
  try {
    const { libraryKey: key } = await ctx.client.unlock({
      token: cache.deviceToken,
      password,
      secretKey,
    });
    return key;
  } catch (err) {
    // The client's own `unlock: …` (a refused read, a malformed Secret Key)
    // and network failures go up as they are; anything else is the wrap
    // refusing to open.
    if (err instanceof TypeError || (err instanceof Error && err.message.startsWith('unlock:'))) {
      throw err;
    }
    throw new CliError('the password and Secret Key do not open this library');
  }
}

async function create(ctx: Context): Promise<void> {
  const setupCode = ctx.values['setup-code'];
  if (setupCode === undefined) throw new CliError('usage: create --setup-code <code>');
  positional(ctx.args, 0, 'create --setup-code <code> [--name <device>]');
  const built = buildLibraryRequest({
    setupCode,
    password: env('SCRIBE_PASSWORD'),
    name: ctx.values.name ?? defaultName(),
  });
  const res = await ctx.client.createLibrary(built.body);
  if (res.status !== 201) fail('create', res);
  writeCache({
    url: ctx.url,
    deviceId: res.body.deviceId!,
    deviceToken: res.body.deviceToken!,
    libraryId: built.libraryId,
  });
  // The kit (spec §9): the only time the Secret Key and the codes are shown.
  console.log(`Library ${built.libraryId} created.`);
  console.log('');
  console.log('SAVE THIS NOW. It is shown once and the vault cannot show it again.');
  console.log('Without the Secret Key, no password or code can open the library.');
  console.log('');
  console.log(`  Vault:       ${ctx.url}`);
  console.log(`  Secret Key:  ${built.secretKey}`);
  console.log('  Recovery codes:');
  for (const code of built.recoveryCodes) console.log(`    ${code}`);
  console.log('');
  console.log(`Device ${res.body.deviceId} cached in ${CACHE_FILE}.`);
}

async function enrol(ctx: Context): Promise<void> {
  positional(ctx.args, 0, 'enrol [--name <device>]');
  const res = await ctx.client.enrol({
    password: env('SCRIBE_PASSWORD'),
    secretKey: env('SCRIBE_SECRET_KEY'),
    name: ctx.values.name ?? defaultName(),
  });
  if (res.status !== 201) fail('enrol', res);
  writeCache({
    url: ctx.url,
    deviceId: res.body.deviceId!,
    deviceToken: res.body.deviceToken!,
    libraryId: res.body.libraryId!,
  });
  console.log(`Enrolled device ${res.body.deviceId} in library ${res.body.libraryId}.`);
  console.log(`Device cached in ${CACHE_FILE}.`);
}

async function put(ctx: Context): Promise<void> {
  const [rawId, rawKind, file] = positional(ctx.args, 3, 'put <meetingId> <kind> <file>');
  const meetingId = meetingIdArg(rawId);
  const kind = kindArg(rawKind);
  const plaintext = fs.readFileSync(userPath(file!));
  const cache = device(ctx);
  const key = await libraryKey(ctx, cache);

  // The revision this write will have is part of the AAD, so ask first.
  const meeting = await ctx.client.getMeeting(cache.deviceToken, meetingId);
  if (meeting.status !== 200 && meeting.status !== 404) fail('reading the meeting', meeting);
  const current = meeting.body.blobs?.find((b) => b.kind === kind)?.revision ?? null;
  const revision = (current ?? 0) + 1;
  const sealed = seal(key, plaintext, blobAad(cache.libraryId, meetingId, kind, revision));

  const res =
    plaintext.length > PART_SIZE
      ? await ctx.client.upload({
          token: cache.deviceToken,
          meetingId,
          kind,
          bytes: sealed,
          partSize: PART_SIZE,
          ifMatch: current,
        })
      : await ctx.client.putMeetingBlob({
          token: cache.deviceToken,
          meetingId,
          kind,
          bytes: sealed,
          ifMatch: current,
        });
  if (res.status !== 200 && res.status !== 201) fail('put', res);
  const via =
    plaintext.length > PART_SIZE ? `, in ${Math.ceil(sealed.length / PART_SIZE)} parts` : '';
  console.log(
    `Stored ${meetingId}/${kind} revision ${res.body.revision} (${res.body.size} bytes sealed${via}, sha256 ${res.body.sha256}).`
  );
}

async function get(ctx: Context): Promise<void> {
  const [rawId, rawKind, out] = positional(ctx.args, 3, 'get <meetingId> <kind> <out>');
  const meetingId = meetingIdArg(rawId);
  const kind = kindArg(rawKind);
  const cache = device(ctx);
  const key = await libraryKey(ctx, cache);
  const res = await ctx.client.getMeetingBlob({ token: cache.deviceToken, meetingId, kind });
  if (res.status !== 200) fail('get', res);
  const revision = Number(/^"(\d+)"$/.exec(res.etag ?? '')?.[1]);
  if (!Number.isInteger(revision)) throw new CliError('get: the vault sent no revision');
  if (crypto.createHash('sha256').update(res.bytes).digest('hex') !== res.sha256) {
    throw new CliError('get: the blob does not match the hash the vault sent');
  }
  let plaintext: Buffer;
  try {
    plaintext = open(key, res.bytes, blobAad(cache.libraryId, meetingId, kind, revision));
  } catch {
    throw new CliError(`get: ${meetingId}/${kind} revision ${revision} does not open`);
  }
  fs.writeFileSync(userPath(out!), plaintext);
  console.log(
    `Wrote ${meetingId}/${kind} revision ${revision} (${plaintext.length} bytes) to ${out}.`
  );
}

async function changes(ctx: Context): Promise<void> {
  positional(ctx.args, 0, 'changes [--since <seq>]');
  const raw = ctx.values.since ?? '0';
  if (!/^\d+$/.test(raw)) throw new CliError('--since must be a non-negative integer');
  const cache = device(ctx);
  let since = Number(raw);
  for (;;) {
    const res = await ctx.client.changes(cache.deviceToken, since);
    if (res.status !== 200) fail('changes', res);
    for (const c of res.body.changes ?? []) {
      const what = c.deleted ? 'deleted' : `revision ${c.revision}, ${c.size} bytes`;
      console.log(
        `${c.seq}\t${c.at}\t${c.meetingId ?? 'library'}\t${c.kind}\t${what}\tdevice ${c.deviceId ?? '-'}`
      );
    }
    since = res.body.nextSince ?? since;
    if (res.body.hasMore !== true) break;
  }
  console.log(`Up to seq ${since}.`);
}

async function devices(ctx: Context): Promise<void> {
  positional(ctx.args, 0, 'devices');
  const cache = device(ctx);
  const res = await ctx.client.devices(cache.deviceToken);
  if (res.status !== 200) fail('devices', res);
  const iso = (ms: number | null) => (ms === null ? '-' : new Date(ms).toISOString());
  for (const d of res.body.devices ?? []) {
    const state = d.revokedAt !== null ? `revoked ${iso(d.revokedAt)}` : 'active';
    console.log(
      `${d.id}\t${d.name}\tcreated ${iso(d.createdAt)}\tlast seen ${iso(d.lastSeenAt)}\t${state}${d.isCurrent ? '\t(this device)' : ''}`
    );
  }
}

async function remove(ctx: Context): Promise<void> {
  const [rawId] = positional(ctx.args, 1, 'delete <meetingId>');
  const meetingId = meetingIdArg(rawId);
  const cache = device(ctx);
  const res = await ctx.client.deleteMeeting(cache.deviceToken, meetingId);
  if (res.status !== 204) fail('delete', res);
  console.log(`Deleted meeting ${meetingId}; its blobs are collected after seven days.`);
}

const COMMANDS: Record<string, (ctx: Context) => Promise<void>> = {
  create,
  enrol,
  put,
  get,
  changes,
  devices,
  delete: remove,
};

async function main(argv: string[]): Promise<number> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      url: { type: 'string' },
      'setup-code': { type: 'string' },
      name: { type: 'string' },
      since: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });
  const [command, ...args] = positionals;
  if (values.help === true || command === undefined) {
    console.log(HELP);
    return values.help === true ? 0 : 1;
  }
  const run = COMMANDS[command];
  if (run === undefined)
    throw new CliError(`unknown command ${JSON.stringify(command)}; see --help`);

  // create and enrol start a device, so they talk to --url or the default;
  // the rest default to the vault their cached device belongs to.
  const starts = command === 'create' || command === 'enrol';
  const url = (values.url ?? (starts ? undefined : readCache()?.url) ?? DEFAULT_URL).replace(
    /\/+$/,
    ''
  );
  const client = new HttpVaultClient(fetchTransport(url));
  await run({ url, client, values, args });
  return 0;
}

/**
 * The one line printed for a failure. Only messages known to carry nothing
 * secret are printed as they are: this script's own, argument errors, file
 * system errors (they name a path), and the shared client's `<step>: …`
 * errors (they name a status). Anything else, a `SyntaxError` quoting a body
 * say, is named by its class alone.
 */
function describeFailure(err: unknown): string {
  if (err instanceof CliError) return err.message;
  if (!(err instanceof Error)) return 'unexpected failure';
  const code = 'code' in err ? String(err.code) : '';
  if (err instanceof TypeError && err.message === 'fetch failed') {
    const cause = (err.cause as { code?: string } | undefined)?.code ?? 'network error';
    return `could not reach the vault (${cause})`;
  }
  if (code.startsWith('ERR_PARSE_ARGS')) return err.message;
  if ('syscall' in err) return err.message;
  if (/^(enrol|login|unlock|upload|recover): /.test(err.message)) return err.message;
  return `unexpected ${err.name}`;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`vault: ${describeFailure(err)}`);
    process.exit(1);
  }
);
