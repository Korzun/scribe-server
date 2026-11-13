/**
 * What `ScribeStore` derives from the artifact files before any query looks
 * at them: a transcript with its stored labels applied, the origin of each
 * name, the inferences a speaker carries, whether a summary or a meeting's
 * tags still describe the transcript, and whether a line fell inside a bled
 * window. Pure functions over the parsed artifacts.
 */
import { createHash } from 'crypto';

import {
  CURRENT_SUMMARIZER_VERSION,
  CURRENT_TAGGER_VERSION,
  sameRef,
  type BleedWindow,
  type MeetingSummaryFile,
  type MeetingTagsFile,
  type SpeakerInference,
  type SpeakerInferencesFile,
  type SpeakerLabelsFile,
  type SpeakerRef,
  type TagListFile,
  type TagTier,
  type Transcript,
} from '../artifacts';
import type { LabelOriginPayload, TagPayload } from './payloads';

/** `Transcript.label(for:)`: the roster's label, or "Unknown" for a ref the roster lacks. */
export function labelFor(transcript: Transcript, ref: SpeakerRef): string {
  return transcript.speakers.find((s) => sameRef(s.ref, ref))?.label ?? 'Unknown';
}

/**
 * A transcript with its stored labels already applied. Fusion regenerates the
 * roster on every run, so the transcript's own labels are derived and
 * `labels.json` is what a person decided.
 */
export class ResolvedTranscript {
  /** With labels applied. */
  readonly transcript: Transcript;
  /**
   * Exactly as `transcript.json` holds it, before labels were reapplied.
   * Summary and tag fingerprints are computed from this value.
   */
  readonly rawTranscript: Transcript;
  private readonly labels: SpeakerLabelsFile;

  constructor(transcript: Transcript, labels: SpeakerLabelsFile | null) {
    this.rawTranscript = transcript;
    this.labels = labels ?? { entries: [] };
    this.transcript = {
      ...transcript,
      speakers: transcript.speakers.map((info) => {
        const entry = this.labels.entries.find((e) => sameRef(e.ref, info.ref));
        if (entry === undefined) return info;
        // A human's own naming attaches no voice; a match names the voice that
        // claimed this speaker. Cleared otherwise, as `SpeakerLabels.applied`.
        const origin = entry.origin ?? { human: {} };
        const renamed = { ...info, label: entry.name };
        if ('voiceprint' in origin) renamed.enrolledVoiceID = origin.voiceprint.id;
        else delete renamed.enrolledVoiceID;
        return renamed;
      }),
    };
  }

  label(ref: SpeakerRef): string {
    return labelFor(this.transcript, ref);
  }

  origin(ref: SpeakerRef): LabelOriginPayload {
    const entry = this.labels.entries.find((e) => sameRef(e.ref, ref));
    if (entry === undefined) return 'generated';
    // A file written before origins existed holds names a person typed.
    const origin = entry.origin ?? { human: {} };
    if ('human' in origin) return 'human';
    if ('voiceprint' in origin) return 'voiceprint';
    return 'inferred';
  }

  enrolledVoiceID(ref: SpeakerRef): string | undefined {
    return this.transcript.speakers.find((s) => sameRef(s.ref, ref))?.enrolledVoiceID;
  }
}

/**
 * `MeetingSummary.fingerprint(of:)`: SHA-256 over each utterance's resolved
 * label and text, length-prefixed, truncated to 16 hex characters. Covers the
 * label because a rename changes nothing about the text and everything about
 * whether a summary is still true.
 */
export function fingerprint(transcript: Transcript): string {
  const hash = createHash('sha256');
  const length = (bytes: Buffer) => {
    const out = Buffer.alloc(4);
    out.writeUInt32BE(bytes.length, 0);
    return out;
  };
  for (const u of transcript.utterances) {
    const label = Buffer.from(labelFor(transcript, u.speaker), 'utf8');
    const text = Buffer.from(u.text, 'utf8');
    hash.update(length(label)).update(label).update(length(text)).update(text);
  }
  return hash.digest('hex').slice(0, 16);
}

/**
 * `Store.freshSummary`: the summary's text when it still describes
 * `transcript` (the RAW one, which is what was fingerprinted), else nothing.
 * A file without a summarizer version fails Scribe's decoding and reads as
 * "not yet", never as one that passes for current.
 */
export function freshSummary(
  summary: MeetingSummaryFile | null,
  transcript: Transcript | null
): string | undefined {
  if (summary === null || transcript === null) return undefined;
  if (summary.summarizerVersion === undefined) return undefined;
  if (summary.summarizerVersion !== CURRENT_SUMMARIZER_VERSION) return undefined;
  if (summary.transcriptFingerprint !== fingerprint(transcript)) return undefined;
  return summary.text;
}

/** `SpeakerInferences.suggestions(for:)`: what may be offered, applied ones excluded. */
export function suggestionsFor(
  inferences: SpeakerInferencesFile | null,
  ref: SpeakerRef
): SpeakerInference[] {
  return (inferences?.entries ?? []).filter((e) => sameRef(e.ref, ref) && e.status === 'suggested');
}

/**
 * `SpeakerInferences.bestSuggestion(for:)`: the strongest, ties to whichever
 * was heard earliest, so the choice cannot reshuffle between two reads.
 */
export function bestSuggestion(
  inferences: SpeakerInferencesFile | null,
  ref: SpeakerRef
): SpeakerInference | undefined {
  const first = (e: SpeakerInference) => e.evidence[0]?.utterance_index ?? Number.MAX_SAFE_INTEGER;
  return suggestionsFor(inferences, ref).reduce<SpeakerInference | undefined>((best, e) => {
    if (best === undefined) return e;
    const bestStrong = best.tier === 'strong';
    const eStrong = e.tier === 'strong';
    if (eStrong !== bestStrong) return eStrong ? e : best;
    return first(e) < first(best) ? e : best;
  }, undefined);
}

/** A meeting's tags as served; `names` lower-cased, for filtering. */
export type ServedTags = {
  payload?: TagPayload[];
  suggestion?: string;
  stale?: boolean;
  names: Set<string>;
};

export const NO_TAGS: ServedTags = { names: new Set() };

const TIERS: TagTier[] = ['context', 'format', 'topic'];

/** Lists saved before topics existed had one tier for both, called "type". */
const tierOf = (tier: TagTier | 'type'): TagTier => (tier === 'type' ? 'format' : tier);

/**
 * `Queries.servedTags`: resolved through the list so a renamed tag reads by
 * its new name, Context first; an id the list lacks is left out. A file
 * without a tagger version fails Scribe's decoding and reads as no tags.
 * `transcript` is the raw one, as `freshSummary` wants it.
 */
export function servedTags(
  tags: MeetingTagsFile | null,
  transcript: Transcript | null,
  list: TagListFile | null
): ServedTags {
  if (list === null || tags === null || tags.taggerVersion === undefined) return NO_TAGS;
  const inList = tags.applied
    .map((a) => list.tags.find((t) => t.id === a.tagID))
    .filter((t): t is NonNullable<typeof t> => t !== undefined);
  const ordered = TIERS.flatMap((tier) => inList.filter((t) => tierOf(t.tier) === tier));
  const payload = ordered.map((t) => ({
    name: t.name,
    tier: tierOf(t.tier),
    origin: tags.applied.find((a) => a.tagID === t.id)?.origin ?? 'auto',
  }));
  const stale =
    transcript !== null &&
    (tags.taggerVersion !== CURRENT_TAGGER_VERSION || tags.fingerprint !== fingerprint(transcript));
  return {
    payload: payload.length === 0 ? undefined : payload,
    suggestion: tags.suggestion?.name,
    stale: stale && payload.length > 0 ? true : undefined,
    names: new Set(ordered.map((t) => t.name.toLowerCase())),
  };
}

/** Every wanted tag, ignoring case. No filter matches everything. */
export function hasAllTags(served: ServedTags, wanted: readonly string[] | undefined): boolean {
  if (wanted === undefined || wanted.length === 0) return true;
  return wanted.every((w) => served.names.has(w.toLowerCase()));
}

/** `BleedDetector.isBled(from:to:)`: any part of the span inside a window over the threshold. */
export function isBled(
  start: number,
  end: number,
  windows: readonly BleedWindow[],
  threshold: number,
  windowDuration = 1.5
): boolean {
  return windows.some(
    (w) => w.coefficient > threshold && start < w.start + windowDuration && end >= w.start
  );
}
