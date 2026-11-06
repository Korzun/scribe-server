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

// Canonical lowercase only, and never normalised: the client builds each
// blob's AAD (`<libraryId>/<meetingId>/<kind>/<revision>`) from the id it
// sends, and every other Mac rebuilds it from the id in the change log. A
// vault that lowercased an uppercase id would accept a write that no other
// Mac could ever open, so anything but the canonical form is refused.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/**
 * True only for a canonical lowercase `8-4-4-4-12` hex UUID. The one validator
 * for every meeting id and voice id the vault is handed, on every route.
 */
export function isCanonicalUuid(s: string): boolean {
  return UUID_RE.test(s);
}

export type LibraryKind = { kind: 'tag-list' } | { kind: 'voice'; voiceId: string };

/**
 * Parses a library-wide kind: `tag-list`, or `voice/<uuid>` (one blob per
 * voiceprint, so two Macs learning different voices never collide), the voice
 * id in canonical lowercase. Anything else, including an uppercase voice id or
 * any extra or empty segment, is `null`.
 */
export function parseLibraryKind(s: string): LibraryKind | null {
  if (s === 'tag-list') return { kind: 'tag-list' };
  if (!s.startsWith('voice/')) return null;
  const voiceId = s.slice('voice/'.length);
  return isCanonicalUuid(voiceId) ? { kind: 'voice', voiceId } : null;
}

/** The kind string stored in `blobs` and the change log: `tag-list` or `voice/<lowercase uuid>`. */
export function libraryKindName(k: LibraryKind): string {
  return k.kind === 'tag-list' ? 'tag-list' : `voice/${k.voiceId}`;
}
