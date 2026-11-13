import { QueryError } from './errors';
/**
 * Reading tool arguments without trusting their JSON types, as Scribe's
 * `Arguments` does. Two rules, and the difference between them is the whole
 * point: a model that sends `"limit": "10"` is being unhelpful, not wrong, so
 * types are coerced leniently; but an argument that is present and cannot be
 * read at all is refused rather than dropped, because dropping it turns the
 * call into a different, well-formed question nobody asked.
 */
import type { Detail, SearchMatch } from './queries';

const DETAILS: readonly Detail[] = ['text', 'full'];
const MATCHES: readonly SearchMatch[] = ['fuzzy', 'literal'];

/** How Scribe's `Value.description` would print the offending value. */
function describe(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  return JSON.stringify(value);
}

export class Arguments {
  private readonly raw: Record<string, unknown>;
  /** Which keys were looked at: the drift test's evidence that a schema's parameter is read. */
  readonly read = new Set<string>();

  constructor(raw: Record<string, unknown> | undefined) {
    this.raw = raw ?? {};
  }

  /** JSON null counts as absent: a model filling in a field it has no value for writes null. */
  private value(key: string): unknown {
    this.read.add(key);
    const v = this.raw[key];
    return v === undefined || v === null ? undefined : v;
  }

  private readAs<T>(
    key: string,
    expected: string,
    convert: (v: unknown) => T | undefined
  ): T | undefined {
    const v = this.value(key);
    if (v === undefined) return undefined;
    const converted = convert(v);
    if (converted === undefined) throw QueryError.unreadable(key, describe(v), expected);
    return converted;
  }

  string(key: string): string | undefined {
    return this.readAs(key, 'a string', (v) => {
      if (typeof v === 'string') return v;
      if (typeof v === 'number' || typeof v === 'boolean') return String(v);
      return undefined;
    });
  }

  requiredString(key: string): string {
    const v = this.string(key);
    if (v === undefined || v === '') throw QueryError.missing(key);
    return v;
  }

  int(key: string): number | undefined {
    return this.readAs(key, 'a whole number', (v) => {
      if (typeof v === 'number') return Number.isInteger(v) ? v : undefined;
      if (typeof v === 'string' && /^\s*[+-]?\d+\s*$/.test(v)) return Number(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return undefined;
    });
  }

  double(key: string): number | undefined {
    return this.readAs(key, 'a number', (v) => {
      if (typeof v === 'number') return Number.isFinite(v) ? v : undefined;
      if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
      if (typeof v === 'boolean') return v ? 1 : 0;
      return undefined;
    });
  }

  bool(key: string): boolean | undefined {
    return this.readAs(key, 'true or false', (v) => {
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 1) return true;
      if (v === 'false' || v === 0) return false;
      return undefined;
    });
  }

  strings(key: string): string[] | undefined {
    const v = this.value(key);
    if (v === undefined) return undefined;
    if (!Array.isArray(v)) throw QueryError.unreadable(key, describe(v), 'an array of strings');
    return v.map((element) => {
      if (typeof element === 'string') return element;
      if (typeof element === 'number' || typeof element === 'boolean') return String(element);
      throw QueryError.unreadable(key, describe(element), 'an array of strings');
    });
  }

  /** An unrecognised detail level is refused rather than quietly defaulted. */
  detail(key: string): Detail {
    const raw = this.string(key);
    if (raw === undefined) return 'text';
    if (!(DETAILS as readonly string[]).includes(raw)) throw QueryError.notOneOf(key, raw, DETAILS);
    return raw as Detail;
  }

  /** An unrecognised match mode is refused rather than quietly defaulted. */
  match(key: string): SearchMatch {
    const raw = this.string(key);
    if (raw === undefined) return 'fuzzy';
    if (!(MATCHES as readonly string[]).includes(raw)) throw QueryError.notOneOf(key, raw, MATCHES);
    return raw as SearchMatch;
  }

  /**
   * Accepts a bare date as readily as a full timestamp: a model asked for
   * "meetings since August" writes `2026-08-01`. Milliseconds since the epoch.
   */
  date(key: string): number | undefined {
    const raw = this.string(key);
    if (raw === undefined) return undefined;
    if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
      const ms = Date.parse(`${raw}T00:00:00Z`);
      if (Number.isFinite(ms)) return ms;
    }
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(raw)) {
      const ms = Date.parse(raw);
      if (Number.isFinite(ms)) return ms;
    }
    throw QueryError.notADate(key, raw);
  }
}
