import * as fs from 'fs';
import * as path from 'path';

import { describe, expect, it } from 'vitest';

/**
 * The grep-style test spec §13 asks for: no log call site ever receives a
 * decrypted field, a key, a token or a code (the anti-goal of §1: no log line
 * ever contains a title, a name, or a line of transcript).
 *
 * Two rules. First, the modules that hold plaintext or keys import no logger
 * at all. Second, every `log.<level>(...)` call anywhere in the server is read
 * for the expressions it interpolates, and each expression's identifiers
 * (split on camelCase) are held against a denylist of the words a secret or
 * a decrypted field would be called. `tokenHash` fails because it names a
 * token; `meetingId` passes. A legitimate new interpolation that trips the
 * list is renamed, not allowlisted: the list is the point.
 */

const ROOT = __dirname;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'test-support', '__mocks__']);

/** Modules that handle keys or plaintext: a log line here is one step from a leak. */
const SILENT = [
  'crypto/',
  'mcp/queries/',
  'mcp/artifacts.ts',
  'mcp/library-reader.ts',
  'mcp/tools.ts',
  'mcp/server.ts',
  'mcp/handler.ts',
  'mcp/tokens.ts',
  'mcp/oauth-provider.ts',
];

const DENY = new Set([
  'title',
  'text',
  'token',
  'code',
  'secret',
  'plaintext',
  'plain',
  'transcript',
  'summary',
  'speaker',
  'label',
  'wrap',
  'password',
  'query',
  'key',
  'kek',
  'lk',
  'name',
  'auth',
  'verifier',
  'body',
  'bytes',
  'note',
  'metadata',
]);

/** Identifiers that contain a denied word but name nothing secret. */
const ALLOW_IDENTIFIERS = new Set([
  // A Prisma migration directory: `0004_mcp_jobs`.
  'migName',
]);

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) out.push(...sourceFiles(path.join(dir, entry.name)));
      continue;
    }
    if (!entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) continue;
    if (entry.name.endsWith('.d.ts') || entry.name === 'vite.config.ts') continue;
    out.push(path.join(dir, entry.name));
  }
  return out;
}

/** The text of each `log.<level>(` call's arguments, with its line number. */
function logCalls(source: string): Array<{ line: number; args: string }> {
  const calls: Array<{ line: number; args: string }> = [];
  const re = /\blog\.(debug|info|warn|error)\(/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    let depth = 1;
    let i = re.lastIndex;
    let quote: string | null = null;
    for (; i < source.length && depth > 0; i++) {
      const c = source[i]!;
      if (quote !== null) {
        if (c === '\\') i++;
        else if (c === quote) quote = null;
        continue;
      }
      if (c === '"' || c === "'" || c === '`') quote = c;
      else if (c === '(') depth++;
      else if (c === ')') depth--;
    }
    calls.push({
      line: source.slice(0, match.index).split('\n').length,
      args: source.slice(re.lastIndex, i - 1),
    });
  }
  return calls;
}

/** Every `${...}` expression's source text inside a template literal. */
function interpolations(args: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] !== '$' || args[i + 1] !== '{') continue;
    let depth = 1;
    let j = i + 2;
    for (; j < args.length && depth > 0; j++) {
      if (args[j] === '{') depth++;
      else if (args[j] === '}') depth--;
    }
    out.push(args.slice(i + 2, j - 1));
    i = j;
  }
  return out;
}

const words = (identifier: string): string[] =>
  identifier
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[\s_]+/)
    .map((w) => w.toLowerCase())
    .filter((w) => w !== '');

/** A SCREAMING_CASE constant is a compile-time literal, never a value read from a meeting. */
const isConstant = (identifier: string): boolean => /^[A-Z][A-Z0-9_]+$/.test(identifier);

function offendingIdentifiers(expression: string): string[] {
  const identifiers = expression.match(/[A-Za-z_$][\w$]*/g) ?? [];
  return identifiers.filter(
    (id) => !ALLOW_IDENTIFIERS.has(id) && !isConstant(id) && words(id).some((w) => DENY.has(w))
  );
}

describe('no log call site receives a decrypted field, a key, a token or a code', () => {
  const files = sourceFiles(ROOT);

  it('finds the server sources', () => {
    expect(files.length).toBeGreaterThan(30);
  });

  it('the modules that hold keys or plaintext import no logger and never print', () => {
    for (const file of files) {
      const rel = path.relative(ROOT, file).split(path.sep).join('/');
      if (!SILENT.some((prefix) => rel.startsWith(prefix))) continue;
      const source = fs.readFileSync(file, 'utf8');
      expect(source, `${rel} imports the logger`).not.toMatch(/from\s+['"][./]*\/?logger['"]/);
      expect(source, `${rel} writes to the console`).not.toMatch(/\bconsole\.\w+\(/);
      expect(source, `${rel} writes to a stream`).not.toMatch(/process\.std(out|err)\.write/);
    }
  });

  it('every interpolated value in a log line names something safe', () => {
    const offences: string[] = [];
    let checked = 0;
    for (const file of files) {
      const rel = path.relative(ROOT, file);
      const source = fs.readFileSync(file, 'utf8');
      for (const call of logCalls(source)) {
        for (const expression of interpolations(call.args)) {
          checked += 1;
          const bad = offendingIdentifiers(expression);
          if (bad.length > 0)
            offences.push(`${rel}:${call.line}: \${${expression}} names ${bad.join(', ')}`);
        }
      }
    }
    expect(checked).toBeGreaterThan(20);
    expect(offences).toEqual([]);
  });

  it('catches what it is meant to catch', () => {
    expect(offendingIdentifiers('tokenHash')).toEqual(['tokenHash']);
    expect(offendingIdentifiers('manifest.title')).toEqual(['title']);
    expect(offendingIdentifiers('libraryKey.toString("hex")')).toEqual(['libraryKey']);
    expect(offendingIdentifiers('meetingId')).toEqual([]);
    expect(offendingIdentifiers('MIN_SETUP_CODE_LENGTH')).toEqual([]);
    expect(offendingIdentifiers('err instanceof Error ? err.message : String(err)')).toEqual([]);
    expect(interpolations('`a ${x} b ${y.z} c`')).toEqual(['x', 'y.z']);
    expect(logCalls('log.info(`x ${a(")")}`); log.warn("y")')).toEqual([
      { line: 1, args: '`x ${a(")")}`' },
      { line: 1, args: '"y"' },
    ]);
  });
});
