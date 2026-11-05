import * as fs from 'fs';
import * as path from 'path';

import { logger } from './logger';
import { AppConfig } from './types';

const log = logger('Config');

const MEDIA_ROOT = '/media';

/**
 * Maps the add-on's `library_dir` option to the blobs directory, confined to
 * `/media`. An empty value or one that climbs out of `/media` falls back to
 * the default WITH A WARNING rather than a throw: the add-on should still boot
 * and store data somewhere sane, instead of writing outside its mount.
 */
export function resolveBlobsDir(libraryDir: string): string {
  const fallback = path.join(MEDIA_ROOT, 'scribe', 'blobs');
  const cleaned = libraryDir.trim().replace(/^\/+/, '');
  if (cleaned === '') {
    log.warn(`Empty library_dir, using ${fallback}`);
    return fallback;
  }
  const resolved = path.resolve(MEDIA_ROOT, cleaned);
  const rel = path.relative(MEDIA_ROOT, resolved);
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    log.warn(`library_dir "${libraryDir}" escapes ${MEDIA_ROOT}, using ${fallback}`);
    return fallback;
  }
  return path.join(resolved, 'blobs');
}

interface Options {
  library_dir: string;
  public_url: string;
  trust_proxy_hops: number;
  setup_code: string;
  log_level: string;
}

/**
 * `TRUST_PROXY_HOPS` (bare-metal/dev env var) or `trust_proxy_hops`
 * (Home Assistant add-on option — the add-on has no env-var surface at all,
 * `run.sh` execs `node` with no arguments, so `options.json` is the only
 * reachable path) — see `AppConfig.trustProxyHops`'s doc comment (`types.ts`)
 * for what this does and doesn't affect. Accepts either source's raw shape
 * (env vars are always strings; `options.json`, parsed from the add-on
 * schema's `int` type, is already a number) and defaults to `0` (trust
 * nothing) on any missing/malformed/non-positive value from EITHER source —
 * the same conservative-default requirement that field's doc comment states,
 * enforced here so a typo'd env var or a hand-edited `options.json` can only
 * ever fail SAFE (toward "don't trust the header"), never open the limiter up
 * to spoofing.
 */
function parseTrustProxyHops(raw: string | number | undefined): number {
  if (raw === undefined) return 0;
  const parsed = typeof raw === 'number' ? raw : parseInt(raw, 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
}

/** Trimmed value, or `''` for anything blank/missing — the "unset" spelling everywhere below. */
function trimmed(raw: string | undefined): string {
  return (raw ?? '').trim();
}

/**
 * Accepts only an absolute http(s) origin, and returns it without a trailing
 * slash so callers can concatenate a path unconditionally. Anything else is
 * `null` WITH A WARNING rather than a throw: a malformed value degrades to
 * "no public URL", which works, instead of failing the whole boot or — far
 * worse — emitting a link nobody can follow.
 */
function parsePublicUrl(raw: string): string | null {
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    log.warn(`public_url "${raw}" is not an absolute URL, ignoring it`);
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    log.warn(`public_url "${raw}" is not http(s), ignoring it`);
    return null;
  }
  return url.origin;
}

export function loadConfig(): AppConfig {
  const dataDir = process.env.DATA_DIR ?? '/data';
  const optionsPath = path.join(dataDir, 'options.json');

  let options: Options = {
    library_dir: 'scribe',
    public_url: '',
    trust_proxy_hops: 0,
    setup_code: '',
    log_level: 'info',
  };

  if (fs.existsSync(optionsPath)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(optionsPath, 'utf-8')) as Partial<Options>;
      options = {
        library_dir: parsed.library_dir ?? options.library_dir,
        public_url: parsed.public_url ?? options.public_url,
        trust_proxy_hops: parsed.trust_proxy_hops ?? options.trust_proxy_hops,
        setup_code: parsed.setup_code ?? options.setup_code,
        log_level: parsed.log_level ?? options.log_level,
      };
    } catch {
      log.warn(`Could not parse ${optionsPath}, using defaults`);
    }
  }

  return {
    dataDir,
    blobsDir: process.env.BLOBS_DIR ?? resolveBlobsDir(options.library_dir),
    port: parseInt(process.env.PORT ?? '3000', 10),
    // Env var (bare-metal/dev) takes precedence over the add-on option: the
    // "env overrides options.json" convention used for every knob here.
    publicUrl: parsePublicUrl(trimmed(process.env.PUBLIC_URL ?? options.public_url)),
    trustProxyHops: parseTrustProxyHops(process.env.TRUST_PROXY_HOPS ?? options.trust_proxy_hops),
    logLevel: process.env.LOG_LEVEL ?? options.log_level,
  };
}

/**
 * The setup code an operator typed into the add-on's configuration, or `null`
 * when none is set. Opens `options.json` on EVERY call and caches nothing:
 * the operator can set, change or clear the code in the HA UI and the next
 * enrolment attempt must see it without restarting the add-on, and a cached
 * copy would keep honouring a code the operator had already revoked.
 *
 * A missing file, unparsable JSON, a missing key and a blank value all mean
 * "no code" (`null`) — enrolment stays closed rather than failing open. The
 * value is a secret and is never logged, not even on a parse failure.
 */
export function readSetupCode(dataDir: string): string | null {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'options.json'), 'utf-8');
    const parsed = JSON.parse(raw) as Partial<Options>;
    const code = typeof parsed.setup_code === 'string' ? parsed.setup_code.trim() : '';
    return code === '' ? null : code;
  } catch {
    return null;
  }
}
