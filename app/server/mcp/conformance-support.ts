/**
 * The conformance fixture's shape (spec §10, "Keeping them honest"), the
 * script runner both doors go through, and the normalisation their payloads
 * go through before they are compared.
 *
 * `test/conformance/` holds `script.json` (a fixed script of tool calls,
 * source) and what `scripts/export-mcp-conformance.ts` writes beside it: the
 * corpus as a Scribe store on disk (`store/`, from `conformance-corpus.ts`)
 * and the parsed results Scribe's stdio server gave (`expected.json`). The
 * vault test seals the store into a temporary library, runs the same script
 * against the remote tools, and compares parsed payloads, not bytes.
 * Excluded: cursor strings (opaque per door); the server's `instructions` and
 * version; date formatting, compared as instants; and the case of meeting ids
 * (Scribe emits `UUID.uuidString`, uppercase; the vault emits its canonical
 * lowercase). Test and export support only.
 */
import * as fs from 'fs';
import * as path from 'path';

/** The committed fixture, or a directory named by `SCRIBE_CONFORMANCE_DIR` for a local run against an export that has not been committed yet. */
export const CONFORMANCE_DIR =
  process.env.SCRIBE_CONFORMANCE_DIR ?? path.resolve(__dirname, '../../../test/conformance');

/** One tool call of the script. `follow` walks pages, feeding the named field back. */
export type ScriptStep = {
  name: string;
  arguments?: Record<string, unknown>;
  follow?: 'next_cursor' | 'next_offset';
};

export type Script = { version: 1; steps: ScriptStep[] };

/** What one step produced on the stdio side. */
export type StepResult = { payload: unknown } | { pages: unknown[] } | { error: string };

export type Expected = {
  version: 1;
  /** Which Scribe server answered; informational. */
  exportedFrom?: string;
  tools: unknown[];
  results: StepResult[];
};

export const HOW_TO_EXPORT =
  'run `npm run conformance:export` on a Mac with Scribe installed and commit test/conformance/';

export type FixtureState =
  | { kind: 'absent' }
  | { kind: 'partial'; missing: string[] }
  | { kind: 'present'; script: Script; expected: Expected };

/** What the exporter writes. `script.json` is committed source and is always there. */
const EXPORTED = ['store', 'expected.json'];

/** Absent (skip), partial (fail: a half-committed fixture), or present. */
export function fixtureState(dir: string = CONFORMANCE_DIR): FixtureState {
  if (!fs.existsSync(dir)) return { kind: 'absent' };
  const missing = EXPORTED.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length === EXPORTED.length) return { kind: 'absent' };
  if (!fs.existsSync(path.join(dir, 'script.json'))) missing.push('script.json');
  if (missing.length > 0) return { kind: 'partial', missing };
  return {
    kind: 'present',
    script: JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')) as Script,
    expected: JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as Expected,
  };
}

/** One tool call at either door: a parsed payload, or the text of an error result. */
export type ToolCaller = (
  name: string,
  args: Record<string, unknown>
) => Promise<{ payload: unknown } | { error: string }>;

/**
 * Runs one script step. A `follow` step is called again with the named field
 * fed back (`next_cursor` as `cursor`, `next_offset` as `offset`) until a page
 * offers none, and records the pages; an error ends the walk and is recorded
 * as such. The exporter runs this against Scribe's stdio server and the test
 * against the vault, so the two doors are asked exactly the same questions.
 */
export async function runStep(call: ToolCaller, step: ScriptStep): Promise<StepResult> {
  if (step.follow === undefined) return call(step.name, step.arguments ?? {});

  const pages: unknown[] = [];
  let args: Record<string, unknown> = { ...(step.arguments ?? {}) };
  for (let page = 0; page < 50; page++) {
    const result = await call(step.name, args);
    if ('error' in result) return result;
    pages.push(result.payload);
    const next =
      result.payload !== null && typeof result.payload === 'object'
        ? (result.payload as Record<string, unknown>)[step.follow]
        : undefined;
    if (next === undefined || next === null) break;
    args = step.follow === 'next_cursor' ? { ...args, cursor: next } : { ...args, offset: next };
  }
  return { pages };
}

/** `Meetings/<UUID>/<file>` → the vault blob kind, as spec §6 maps them. */
export const ARTIFACT_KINDS: Record<string, string> = {
  'manifest.json': 'manifest',
  'transcript.json': 'transcript',
  'diarization.json': 'diarization',
  'labels.json': 'labels',
  'inferences.json': 'inferences',
  'summary.json': 'summary',
  'tags.json': 'tags',
  'transcript.md': 'markdown',
};

export type StoreMeeting = { id: string; files: Array<{ kind: string; bytes: Buffer }> };

/** Every meeting bundle in an exported store, ids lowercased, plus the library tag list. */
export function readStore(dir: string): { meetings: StoreMeeting[]; tagList: Buffer | null } {
  const meetingsRoot = path.join(dir, 'Meetings');
  const meetings: StoreMeeting[] = [];
  if (fs.existsSync(meetingsRoot)) {
    for (const entry of fs.readdirSync(meetingsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const bundle = path.join(meetingsRoot, entry.name);
      const files = fs
        .readdirSync(bundle)
        .filter((f) => f in ARTIFACT_KINDS)
        .map((f) => ({ kind: ARTIFACT_KINDS[f]!, bytes: fs.readFileSync(path.join(bundle, f)) }));
      meetings.push({ id: entry.name.toLowerCase(), files });
    }
  }
  const tagList = path.join(dir, 'tags.json');
  return { meetings, tagList: fs.existsSync(tagList) ? fs.readFileSync(tagList) : null };
}

/** The same value with every object's keys sorted, so a file written from it diffs stably. */
export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((k) => [k, sortKeys(record[k])])
    );
  }
  return value;
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

/** Fields that are opaque per door and never compared. */
const OPAQUE_KEYS = new Set(['next_cursor']);

/**
 * The comparison form of a payload: cursors dropped, UUIDs lowercased, dates
 * as epoch milliseconds, nulls kept, arrays in order. Applied to both sides.
 */
export function normalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (OPAQUE_KEYS.has(key) || v === undefined) continue;
      out[key] = normalize(v);
    }
    return out;
  }
  if (typeof value === 'string') {
    if (UUID_RE.test(value)) return value.toLowerCase();
    if (ISO_RE.test(value)) return Date.parse(value);
  }
  return value;
}

/**
 * The comparison form of a `tools/list` entry: null-valued keys dropped, since
 * one SDK may write `"outputSchema": null` where the other omits the key.
 */
export function normalizeTool(tool: unknown): unknown {
  if (tool === null || typeof tool !== 'object') return tool;
  return Object.fromEntries(
    Object.entries(tool as Record<string, unknown>).filter(([, v]) => v !== null && v !== undefined)
  );
}
