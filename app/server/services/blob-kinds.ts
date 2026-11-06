/**
 * The blob kinds the vault accepts (spec §6). A kind ends up in a URL, in the
 * `blobs` table and in the change log, and a library kind contains a slash, so
 * nothing outside these exact shapes is ever let through: `voice/../x` must be
 * refused here, long before anything could think of it as a path. (Files are
 * named by SHA-256, never by kind, but the rule holds regardless.)
 */

/** The blobs of one meeting, one current revision each. */
export const MEETING_KINDS = [
  'manifest',
  'transcript',
  'diarization',
  'labels',
  'inferences',
  'summary',
  'tags',
  'markdown',
  'audio-mic',
  'audio-system',
] as const;

export type MeetingKind = (typeof MEETING_KINDS)[number];

const MEETING_KIND_SET: ReadonlySet<string> = new Set(MEETING_KINDS);

export function isMeetingKind(s: string): s is MeetingKind {
  return MEETING_KIND_SET.has(s);
}

// Canonical lowercase only: meeting and voice ids are scopes and kinds the
// vault compares as strings, so `ABC…` and `abc…` must not name two things.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** True only for the canonical lowercase form; ids from a request go through `normalizeUuid` first. */
export function isUuid(s: string): boolean {
  return UUID_RE.test(s);
}

/**
 * The one place an id from a request becomes the id the vault keys on: any
 * case is accepted (Swift's `UUID().uuidString` is uppercase) and lowercased,
 * so an uppercase `PUT` and a lowercase `GET` name the same blob and the change
 * log only ever carries lowercase. Anything that is not a UUID is `null`.
 * Every meeting route and `parseLibraryKind` use this.
 */
export function normalizeUuid(s: string): string | null {
  const lower = s.toLowerCase();
  return UUID_RE.test(lower) ? lower : null;
}

export type LibraryKind = { kind: 'tag-list' } | { kind: 'voice'; voiceId: string };

/**
 * Parses a library-wide kind: `tag-list`, or `voice/<uuid>` (one blob per
 * voiceprint, so two Macs learning different voices never collide), with the
 * voice id lowercased. Anything else, including any extra or empty segment,
 * is `null`.
 */
export function parseLibraryKind(s: string): LibraryKind | null {
  if (s === 'tag-list') return { kind: 'tag-list' };
  if (!s.startsWith('voice/')) return null;
  const voiceId = normalizeUuid(s.slice('voice/'.length));
  return voiceId === null ? null : { kind: 'voice', voiceId };
}

/** The kind string stored in `blobs` and the change log: `tag-list` or `voice/<lowercase uuid>`. */
export function libraryKindName(k: LibraryKind): string {
  return k.kind === 'tag-list' ? 'tag-list' : `voice/${k.voiceId}`;
}
