/**
 * Small helpers the queries share: the timestamp format, the case-insensitive
 * contains Swift's `range(of:options:.caseInsensitive)` provides, and dates.
 */

/** `HH:MM:SS` from the start of the recording, as Scribe renders it. */
export function timestamp(seconds: number): string {
  const total = Math.floor(Math.max(0, seconds));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor((total % 3600) / 60))}:${pad(total % 60)}`;
}

/**
 * Case-insensitive substring test. An empty needle matches nothing, as
 * Foundation's `range(of: "")` is nil: the filters that take a string treat
 * an empty one as a filter nobody can pass, not as no filter.
 */
export function includesCI(haystack: string, needle: string): boolean {
  if (needle === '') return false;
  return haystack.toLowerCase().includes(needle.toLowerCase());
}

/** Milliseconds since the epoch for an ISO 8601 string, or NaN. */
export const parseIso = (iso: string): number => Date.parse(iso);

/**
 * A date on the wire: ISO 8601 to the second, as Foundation's `.iso8601`
 * strategy writes it (no fractional seconds), so both doors spell the same
 * instant the same way.
 */
export function isoSeconds(ms: number): string {
  return new Date(Math.floor(ms / 1000) * 1000).toISOString().replace(/\.000Z$/, 'Z');
}

const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * A meeting id as the vault stores it: canonical lowercase, from any case the
 * caller wrote (`UUID(uuidString:)` accepts both). Null when not a UUID.
 */
export function canonicalUuid(raw: string): string | null {
  return UUID_RE.test(raw) ? raw.toLowerCase() : null;
}
