/**
 * The conformance fixture's shape (spec §10, "Keeping them honest") and the
 * normalisation both doors' payloads go through before they are compared.
 *
 * `test/conformance/` is exported by `ScribeMCPTests` in the Scribe repo
 * (`Scripts/export-mcp-conformance.sh`): a store on disk, a fixed script of
 * tool calls, and the parsed results the stdio server gave. The vault test
 * encrypts the store into a temporary library, runs the same script against
 * the remote tools, and compares parsed payloads, not bytes. Excluded: cursor
 * strings (opaque per door); the server's `instructions` and version; date
 * formatting, compared as instants; and the case of meeting ids (Scribe emits
 * `UUID.uuidString`, uppercase; the vault emits its canonical lowercase).
 * Test support only.
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
  /** The Scribe commit the fixture was exported from; informational. */
  exportedFrom?: string;
  tools: unknown[];
  results: StepResult[];
};

export const HOW_TO_EXPORT =
  'run Scripts/export-mcp-conformance.sh in the Scribe repo and copy its output into test/conformance/';

export type FixtureState =
  | { kind: 'absent' }
  | { kind: 'partial'; missing: string[] }
  | { kind: 'present'; script: Script; expected: Expected };

const FILES = ['store', 'script.json', 'expected.json'];

/** Absent (skip), partial (fail: a half-committed fixture), or present. */
export function fixtureState(dir: string = CONFORMANCE_DIR): FixtureState {
  if (!fs.existsSync(dir)) return { kind: 'absent' };
  const missing = FILES.filter((f) => !fs.existsSync(path.join(dir, f)));
  if (missing.length === FILES.length) return { kind: 'absent' };
  if (missing.length > 0) return { kind: 'partial', missing };
  return {
    kind: 'present',
    script: JSON.parse(fs.readFileSync(path.join(dir, 'script.json'), 'utf8')) as Script,
    expected: JSON.parse(fs.readFileSync(path.join(dir, 'expected.json'), 'utf8')) as Expected,
  };
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
