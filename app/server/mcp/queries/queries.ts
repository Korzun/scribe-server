/**
 * Every read the remote MCP server can perform: a TypeScript port of Scribe's
 * `Queries` (`MeetingQueries.swift`, `SearchQueries.swift`,
 * `TranscriptQueries.swift`, `TagQueries.swift`, `PayloadBuilders.swift`).
 * One object rather than five, because each query needs the same reader and
 * nothing else. Nothing here writes, and nothing here logs: the values in
 * scope are decrypted meetings.
 *
 * Orderings, tiebreaks, cursor semantics and truncation reasons are Scribe's
 * exactly; where the two doors must differ it is said so in a comment, and
 * the conformance fixture (`conformance.test.ts`) holds the rest.
 */
import {
  sameRef,
  STARTER_TAG_LIST,
  type Manifest,
  type TagListFile,
  type Transcript,
  type Utterance,
} from '../artifacts';
import type { LibraryReader } from '../library-reader';
import { fit } from './budget';
import { QueryError } from './errors';
import { FuzzyQuery, FuzzyUtterance } from './fuzzy';
import type {
  MatchTypePayload,
  MeetingDetailPayload,
  MeetingListPayload,
  MeetingRow,
  PersonPayload,
  SearchHitPayload,
  SearchPayload,
  SpeakerAppearancePayload,
  SpeakerListPayload,
  SpeakerPayload,
  SuggestionPayload,
  TitleOriginPayload,
  TranscriptPayload,
  TruncationReasonPayload,
  UtterancePayload,
} from './payloads';
import {
  bestSuggestion,
  freshSummary,
  hasAllTags,
  isBled,
  ResolvedTranscript,
  servedTags,
  type ServedTags,
} from './resolved';
import { canonicalUuid, includesCI, isoSeconds, parseIso, timestamp } from './text';

/** `FusionConfig.default.confidenceThreshold`: below it, attribution is weak. */
export const CONFIDENCE_THRESHOLD = 0.5;
/** `FusionConfig.default.bleedCoefficientThreshold`. */
export const BLEED_THRESHOLD = 0.5;
/** The ceiling on `context_lines`, so one hit cannot flood the response. */
export const MAX_CONTEXT_LINES = 20;
/** The ceiling on how many meetings one person's entry lists. */
export const MAX_APPEARANCES = 20;

export type Detail = 'text' | 'full';
export type SearchMatch = 'fuzzy' | 'literal';

const TITLE_ORIGINS: Record<string, TitleOriginPayload> = {
  calendar: 'calendar',
  windowTitle: 'window_title',
  adHoc: 'ad_hoc',
  human: 'human',
};

const ATTENDEE_KINDS = new Set(['person', 'group', 'room', 'resource']);

/** `MeetingRow` plus what the list needs to filter and page: the sort key and the tags. */
type Summary = { startedAt: number; row: MeetingRow; tags: ServedTags };

/**
 * Where a `list_meetings` page ended: the sort key of its last row, as
 * `<started_at ms>#<meeting_id>`. A key rather than an offset, because the
 * list shifts under a walker. Opaque per door: Scribe's cursor spells the
 * same position differently.
 */
class MeetingCursor {
  constructor(
    readonly startedAt: number,
    readonly meetingId: string
  ) {}

  static parse(raw: string): MeetingCursor {
    const separator = raw.indexOf('#');
    if (separator < 0 || separator === raw.length - 1) throw QueryError.malformedCursor(raw);
    const ms = Number(raw.slice(0, separator));
    if (!Number.isFinite(ms) || raw.slice(0, separator).trim() === '') {
      throw QueryError.malformedCursor(raw);
    }
    return new MeetingCursor(ms, raw.slice(separator + 1));
  }

  encoded(): string {
    return `${this.startedAt}#${this.meetingId}`;
  }

  /** Whether `row` comes strictly after this position in (startedAt desc, id asc). */
  precedes(startedAt: number, meetingId: string): boolean {
    return this.startedAt === startedAt ? this.meetingId < meetingId : this.startedAt > startedAt;
  }
}

/** Newest first, ties broken by id so the ordering is total. */
const newestFirst = (a: { startedAt: number; id: string }, b: { startedAt: number; id: string }) =>
  a.startedAt === b.startedAt
    ? a.id < b.id
      ? -1
      : a.id > b.id
        ? 1
        : 0
    : b.startedAt - a.startedAt;

/** A non-negative count cursor, as Scribe reads it: anything unreadable is 0. */
const countCursor = (cursor: string | undefined): number =>
  cursor !== undefined && /^-?\d+$/.test(cursor) ? Math.max(0, Number(cursor)) : 0;

const speakingSeconds = (utterances: readonly Utterance[]): number => {
  let total = 0;
  for (const u of utterances) total += u.end - u.start;
  return total;
};

/**
 * The index of the turn `u` happened entirely inside, or undefined. Strict
 * containment against the whole transcript; where turns nest, the earliest
 * starting container wins; a speaker's own turn never counts.
 */
export function containerIndex(u: Utterance, all: readonly Utterance[]): number | undefined {
  let earliest: { index: number; start: number } | undefined;
  all.forEach((candidate, index) => {
    if (sameRef(candidate.speaker, u.speaker)) return;
    if (!(candidate.start < u.start && u.end < candidate.end)) return;
    if (earliest === undefined || candidate.start < earliest.start) {
      earliest = { index, start: candidate.start };
    }
  });
  return earliest?.index;
}

export function utterancePayload(
  u: Utterance,
  index: number,
  resolved: ResolvedTranscript,
  options: {
    detail: Detail;
    includeTokens: boolean;
    bleed: readonly { start: number; coefficient: number; lag: number }[];
    duringUtteranceIndex: number | undefined;
  }
): UtterancePayload {
  const full = options.detail === 'full';
  // Only a microphone line can be a victim of bleed; the system stream is the
  // source of the echo. Checked over the whole span.
  const bleedSuspected =
    full &&
    u.speaker.stream === 'microphone' &&
    isBled(u.start, u.end, options.bleed, BLEED_THRESHOLD);
  return {
    index,
    timestamp: timestamp(u.start),
    start_seconds: u.start,
    end_seconds: u.end,
    speaker: resolved.label(u.speaker),
    text: u.text,
    speaker_confidence: full ? u.speakerConfidence : undefined,
    text_confidence: full ? u.textConfidence : undefined,
    overlapped: full ? u.overlapped : undefined,
    stream: full ? u.speaker.stream : undefined,
    bleed_suspected: bleedSuspected ? true : undefined,
    during_utterance_index: full ? options.duringUtteranceIndex : undefined,
    cluster_id: full ? (u.speaker.cluster ?? null) : undefined,
    label_origin: full ? resolved.origin(u.speaker) : undefined,
    enrolled_voice_id: full ? (resolved.enrolledVoiceID(u.speaker) ?? null) : undefined,
    tokens: options.includeTokens
      ? u.tokens.map((t) => ({
          text: t.text,
          start_seconds: t.start,
          end_seconds: t.end,
          confidence: t.confidence,
        }))
      : undefined,
  };
}

export class Queries {
  constructor(private readonly reader: LibraryReader) {}

  /** A transcript with its labels applied, or null while a meeting is still processing. */
  private async resolved(id: string): Promise<ResolvedTranscript | null> {
    const transcript = await this.reader.transcript(id);
    if (transcript === null) return null;
    return new ResolvedTranscript(transcript, await this.reader.labels(id));
  }

  /** The list, or the starter set when none has been written. */
  private async tagList() {
    return (await this.reader.tagList()) ?? STARTER_TAG_LIST;
  }

  private async servedTags(id: string, transcript: Transcript | null, list: TagListFile | null) {
    return servedTags(await this.reader.meetingTags(id), transcript, list);
  }

  /** A canonical id the library holds, or the error that names what was wrong. */
  private async meetingId(raw: string): Promise<{ id: string; manifest: Manifest }> {
    const id = canonicalUuid(raw);
    if (id === null) throw QueryError.malformedMeetingID(raw);
    const manifest = await this.reader.manifest(id);
    if (manifest === null) throw QueryError.unknownMeeting(raw);
    return { id, manifest };
  }

  /** Every readable meeting, newest first. A manifest that will not open is skipped. */
  private async summaries(): Promise<Summary[]> {
    const list = await this.tagList();
    const out: Array<Summary & { id: string }> = [];
    for (const id of await this.reader.listMeetingIds()) {
      const manifest = await this.reader.manifest(id);
      if (manifest === null) continue;
      const transcript = await this.reader.transcript(id);
      const tags = await this.servedTags(id, transcript, list);
      const startedAt = parseIso(manifest.startedAt);
      out.push({
        id,
        startedAt,
        tags,
        row: {
          meeting_id: id,
          title: manifest.title,
          started_at: isoSeconds(startedAt),
          ended_at:
            manifest.endedAt === undefined ? undefined : isoSeconds(parseIso(manifest.endedAt)),
          duration_seconds: manifest.duration,
          speaker_count: transcript?.speakers.length ?? 0,
          utterance_count: transcript?.utterances.length ?? 0,
          processed: transcript !== null,
          summary: freshSummary(await this.reader.summary(id), transcript),
          tags: tags.payload,
          suggested_tag: tags.suggestion,
          tags_stale: tags.stale,
        },
      });
    }
    return out.sort(newestFirst);
  }

  async listMeetings(input: {
    from?: number;
    to?: number;
    titleContains?: string;
    limit: number;
    cursor?: string;
    tags?: string[];
  }): Promise<MeetingListPayload> {
    let rows = (await this.summaries()).filter((s) => hasAllTags(s.tags, input.tags));
    if (input.from !== undefined) rows = rows.filter((s) => s.startedAt >= input.from!);
    if (input.to !== undefined) rows = rows.filter((s) => s.startedAt <= input.to!);
    if (input.titleContains !== undefined && input.titleContains !== '') {
      rows = rows.filter((s) => includesCI(s.row.title, input.titleContains!));
    }
    // The cursor is the sort key where the last page ended; resuming means
    // dropping everything at or before it.
    if (input.cursor !== undefined) {
      const boundary = MeetingCursor.parse(input.cursor);
      const start = rows.findIndex((s) => boundary.precedes(s.startedAt, s.row.meeting_id));
      rows = start < 0 ? [] : rows.slice(start);
    }
    const window = rows.slice(0, Math.max(0, input.limit));
    const { kept, truncated: budgetTruncated } = fit(
      window.map((s) => s.row),
      200
    );

    // Truncated and a cursor go together, always. When the last row is the
    // cut one, the cursor is its own key, and the page it opens is empty.
    const truncated = kept.length < rows.length || budgetTruncated;
    const last = kept.length > 0 ? window[kept.length - 1] : undefined;
    const reason: TruncationReasonPayload | undefined = budgetTruncated
      ? 'response_size_budget'
      : truncated
        ? 'end_of_window'
        : undefined;
    return {
      meetings: kept,
      truncated,
      next_cursor: truncated
        ? last !== undefined
          ? new MeetingCursor(last.startedAt, last.row.meeting_id).encoded()
          : input.cursor
        : undefined,
      truncation_reason: reason,
    };
  }

  async getMeeting(raw: string): Promise<MeetingDetailPayload> {
    const { id, manifest } = await this.meetingId(raw);
    const resolved = await this.resolved(id);
    const inferences = await this.reader.inferences(id);

    let speakers: SpeakerPayload[] = [];
    if (resolved !== null) {
      const totalTalk = speakingSeconds(resolved.transcript.utterances);
      speakers = resolved.transcript.speakers.map((info) => {
        const spoken = resolved.transcript.utterances.filter((u) => sameRef(u.speaker, info.ref));
        const seconds = speakingSeconds(spoken);
        const offered: SuggestionPayload[] = [];
        for (const s of (inferences?.entries ?? []).filter(
          (e) => sameRef(e.ref, info.ref) && e.status === 'suggested'
        )) {
          // An inference with no evidence behind it should not exist, and a
          // suggestion carrying nothing to justify it is exactly what the
          // quote is on the wire to prevent.
          if (s.evidence.length === 0) continue;
          offered.push({
            name: s.name,
            tier: s.tier === 'strong' ? 'strong' : 'weak',
            evidence: s.evidence.map((e) => ({
              kind: e.kind === 'self_introduction' ? 'self_introduction' : 'call_and_response',
              quote: e.quote,
              utterance_index: e.utterance_index,
            })),
          });
        }
        return {
          label: info.label,
          stream: info.ref.stream,
          cluster_id: info.ref.cluster ?? null,
          label_origin: resolved.origin(info.ref),
          enrolled_voice_id: info.enrolledVoiceID ?? null,
          utterance_count: spoken.length,
          speaking_seconds: seconds,
          speaking_share: totalTalk > 0 ? seconds / totalTalk : 0,
          suggestions: offered.length === 0 ? undefined : offered,
        };
      });
    }

    // Only attributed utterances can be weakly attributed.
    const attributed = resolved?.transcript.utterances.filter(
      (u) => u.speaker.cluster !== undefined
    );
    const weak = attributed?.filter((u) => u.speakerConfidence < CONFIDENCE_THRESHOLD);
    const share =
      attributed !== undefined && weak !== undefined && attributed.length > 0
        ? weak.length / attributed.length
        : undefined;

    const coefficients = manifest.bleedWindows.map((w) => w.coefficient);
    const tags = await this.servedTags(id, resolved?.rawTranscript ?? null, await this.tagList());

    // `attendeeKinds` aligned to the names, and served only when at least one
    // kind is known, as `Invitee.kindsIfRecorded` decides.
    let attendeeKinds: Array<string | null> | undefined;
    if (manifest.attendeeNames !== undefined) {
      const kinds = (manifest.attendeeKinds ?? [])
        .slice(0, manifest.attendeeNames.length)
        .map((k) => (k !== null && ATTENDEE_KINDS.has(k) ? k : null));
      while (kinds.length < manifest.attendeeNames.length) kinds.push(null);
      attendeeKinds = kinds.some((k) => k !== null) ? kinds : undefined;
    }

    return {
      meeting_id: id,
      title: manifest.title,
      started_at: isoSeconds(parseIso(manifest.startedAt)),
      ended_at: manifest.endedAt === undefined ? undefined : isoSeconds(parseIso(manifest.endedAt)),
      duration_seconds: manifest.duration,
      sample_rate: manifest.sampleRate,
      device_identifier: manifest.deviceIdentifier ?? 'unknown',
      processed: resolved !== null,
      utterance_count: resolved?.transcript.utterances.length ?? 0,
      speakers,
      quality: {
        mic_duration: manifest.micDuration ?? manifest.duration,
        system_duration: manifest.systemDuration ?? manifest.duration,
        stream_durations_measured:
          manifest.micDuration !== undefined && manifest.systemDuration !== undefined,
        bleed_window_count: manifest.bleedWindows.length,
        peak_bleed_coefficient: coefficients.length === 0 ? undefined : Math.max(...coefficients),
        low_confidence_utterance_share: share,
      },
      attendee_names: manifest.attendeeNames,
      attendee_kinds: attendeeKinds,
      scheduled_start:
        manifest.scheduledStart === undefined
          ? undefined
          : isoSeconds(parseIso(manifest.scheduledStart)),
      scheduled_end:
        manifest.scheduledEnd === undefined
          ? undefined
          : isoSeconds(parseIso(manifest.scheduledEnd)),
      title_origin:
        manifest.titleOrigin === undefined ? undefined : TITLE_ORIGINS[manifest.titleOrigin],
      summary: freshSummary(await this.reader.summary(id), resolved?.rawTranscript ?? null),
      tags: tags.payload,
      suggested_tag: tags.suggestion,
      tags_stale: tags.stale,
    };
  }

  async getTranscript(input: {
    id: string;
    startTime?: number;
    endTime?: number;
    offset?: number;
    limit?: number;
    minDurationSeconds?: number;
    detail: Detail;
    includeTokens: boolean;
  }): Promise<TranscriptPayload> {
    const hasTimeWindow = input.startTime !== undefined || input.endTime !== undefined;
    const hasIndexWindow = input.offset !== undefined || input.limit !== undefined;
    if (hasTimeWindow && hasIndexWindow) throw QueryError.conflictingWindow();

    const { id, manifest } = await this.meetingId(input.id);
    const startedAt = isoSeconds(parseIso(manifest.startedAt));
    const resolved = await this.resolved(id);
    if (resolved === null) {
      return {
        meeting_id: id,
        title: manifest.title,
        started_at: startedAt,
        utterances: [],
        total_utterances: 0,
        truncated: false,
      };
    }

    const all = resolved.transcript.utterances;
    // Index first, window second: the index names a position in the whole
    // transcript, so a search hit stays followable.
    const indexed = all.map((element, offset) => ({ offset, element }));
    let selected: typeof indexed;
    if (hasTimeWindow) {
      const lower = input.startTime ?? -Infinity;
      const upper = input.endTime ?? Infinity;
      // Overlap, not containment.
      selected = indexed.filter((x) => x.element.end > lower && x.element.start < upper);
    } else {
      const start = Math.min(Math.max(0, input.offset ?? 0), indexed.length);
      const count = input.limit === undefined ? indexed.length : Math.max(0, input.limit);
      selected = indexed.slice(start, start + count);
    }

    // The duration filter thins the window rather than defining one, and
    // never renumbers: the dropped lines leave holes in the index sequence.
    const survivors =
      input.minDurationSeconds === undefined
        ? selected
        : selected.filter((x) => x.element.end - x.element.start >= input.minDurationSeconds!);
    const filteredOut = selected.length - survivors.length;

    const payloads = survivors.map((x) =>
      utterancePayload(x.element, x.offset, resolved, {
        detail: input.detail,
        includeTokens: input.includeTokens,
        bleed: manifest.bleedWindows,
        // Containment looks at `all`, not the window, and only at full detail.
        duringUtteranceIndex: input.detail === 'full' ? containerIndex(x.element, all) : undefined,
      })
    );
    const { kept } = fit(payloads, 300);

    const cutByBudget = kept.length < payloads.length;
    const lastSelected = selected[selected.length - 1];
    const moreAfterWindow = hasTimeWindow
      ? false
      : lastSelected !== undefined && lastSelected.offset < all.length - 1;
    const more = cutByBudget || moreAfterWindow;
    const reason: TruncationReasonPayload | undefined = cutByBudget
      ? 'response_size_budget'
      : moreAfterWindow
        ? 'end_of_window'
        : undefined;
    // One past the last returned line, or, when the filter emptied the whole
    // window, one past the window itself.
    const resumeFrom = kept.length > 0 ? kept[kept.length - 1]!.index : lastSelected?.offset;
    return {
      meeting_id: id,
      title: manifest.title,
      started_at: startedAt,
      utterances: kept,
      total_utterances: all.length,
      utterances_filtered_out: filteredOut > 0 ? filteredOut : undefined,
      truncated: more,
      next_offset: more && resumeFrom !== undefined ? resumeFrom + 1 : undefined,
      truncation_reason: reason,
    };
  }

  async searchTranscripts(input: {
    query: string;
    match: SearchMatch;
    from?: number;
    to?: number;
    meetingIds?: string[];
    speaker?: string;
    contextLines: number;
    limit: number;
    cursor?: string;
    tags?: string[];
  }): Promise<SearchPayload> {
    // A meeting id that is not a UUID is refused rather than dropped.
    let wanted: Set<string> | undefined;
    if (input.meetingIds !== undefined) {
      wanted = new Set();
      for (const raw of input.meetingIds) {
        const id = canonicalUuid(raw);
        if (id === null) throw QueryError.malformedMeetingID(raw);
        wanted.add(id);
      }
    }
    const context = Math.min(Math.max(0, input.contextLines), MAX_CONTEXT_LINES);
    const list = input.tags === undefined ? null : await this.tagList();

    // Newest first, ties by id, so the scan order is the same on every call.
    const candidates: Array<{ id: string; startedAt: number; manifest: Manifest }> = [];
    for (const id of await this.reader.listMeetingIds()) {
      const manifest = await this.reader.manifest(id);
      if (manifest === null) continue;
      if (wanted !== undefined && !wanted.has(id)) continue;
      const startedAt = parseIso(manifest.startedAt);
      if (input.from !== undefined && startedAt < input.from) continue;
      if (input.to !== undefined && startedAt > input.to) continue;
      if (
        input.tags !== undefined &&
        !hasAllTags(await this.servedTags(id, null, list), input.tags)
      ) {
        continue;
      }
      candidates.push({ id, startedAt, manifest });
    }
    candidates.sort(newestFirst);

    // The cursor is how many matches an earlier page already delivered.
    const start = countCursor(input.cursor);
    const fuzzyQuery = new FuzzyQuery(input.query);

    const hits: SearchHitPayload[] = [];
    let matched = 0;
    let searched = 0;
    let stoppedEarly = false;

    for (const { id, startedAt, manifest } of candidates) {
      const resolved = await this.resolved(id);
      if (resolved === null) continue;
      searched += 1;

      const utterances = resolved.transcript.utterances;
      for (let index = 0; index < utterances.length; index++) {
        const u = utterances[index]!;
        // The substring check runs first in both modes, so fuzzy stays a
        // strict superset of literal.
        const substring = includesCI(u.text, input.query);
        let matchType: MatchTypePayload | undefined;
        let matchedText: string | undefined;
        if (input.match === 'literal') {
          if (!substring) continue;
        } else if (substring) {
          matchType = 'exact';
        } else {
          const tokenized = new FuzzyUtterance(u.text);
          const aligned = fuzzyQuery.match(tokenized);
          if (aligned === null) continue;
          matchType = aligned.exact ? 'exact' : 'fuzzy';
          if (!aligned.exact) {
            matchedText = tokenized.display.slice(aligned.start, aligned.end).join(' ');
          }
        }

        const name = resolved.label(u.speaker);
        if (input.speaker !== undefined && !includesCI(name, input.speaker)) continue;

        matched += 1;
        if (matched <= start) continue;
        if (hits.length >= Math.max(0, input.limit)) {
          stoppedEarly = true;
          break;
        }

        hits.push({
          meeting_id: id,
          title: manifest.title,
          started_at: isoSeconds(startedAt),
          utterance_index: index,
          timestamp: timestamp(u.start),
          speaker: name,
          text: u.text,
          context_before: utterances.slice(Math.max(0, index - context), index).map((x) => x.text),
          context_after: utterances
            .slice(
              Math.min(index + 1, utterances.length),
              Math.min(index + 1 + context, utterances.length)
            )
            .map((x) => x.text),
          speaker_confidence: u.speakerConfidence,
          overlapped: u.overlapped,
          match_type: matchType,
          matched_text: matchedText,
        });
      }
      if (stoppedEarly) break;
    }

    const { kept, truncated: budgetTruncated } = fit(hits, 250);
    const more = stoppedEarly || budgetTruncated;
    return {
      hits: kept,
      meetings_searched: searched,
      truncated: more,
      next_cursor: more ? String(start + kept.length) : undefined,
      truncation_reason: budgetTruncated
        ? 'response_size_budget'
        : stoppedEarly
          ? 'end_of_window'
          : undefined,
    };
  }

  async listSpeakers(input: {
    voiceId?: string;
    nameContains?: string;
    from?: number;
    to?: number;
    cursor?: string;
  }): Promise<SpeakerListPayload> {
    type Accumulator = {
      label: string;
      labelDate: number;
      voiceId: string | undefined;
      suggestion: { name: string; tier: 'strong' | 'weak' } | undefined;
      seconds: number;
      /** Keyed by meeting: one person can hold two speaker slots in one meeting. */
      appearances: Map<string, SpeakerAppearancePayload & { startedAtMs: number }>;
    };
    const people = new Map<string, Accumulator>();

    for (const id of await this.reader.listMeetingIds()) {
      const manifest = await this.reader.manifest(id);
      if (manifest === null) continue;
      const startedAt = parseIso(manifest.startedAt);
      if (input.from !== undefined && startedAt < input.from) continue;
      if (input.to !== undefined && startedAt > input.to) continue;
      const resolved = await this.resolved(id);
      if (resolved === null) continue;
      const inferences = await this.reader.inferences(id);

      for (const info of resolved.transcript.speakers) {
        const voice = info.enrolledVoiceID;
        if (input.voiceId !== undefined && voice !== input.voiceId) continue;
        // Only for a speaker with no enrolled voice: an enrolled voice already knows who it is.
        const suggestion = voice === undefined ? bestSuggestion(inferences, info.ref) : undefined;
        if (input.nameContains !== undefined) {
          const matchesLabel = includesCI(info.label, input.nameContains);
          const matchesSuggestion =
            suggestion !== undefined && includesCI(suggestion.name, input.nameContains);
          if (!matchesLabel && !matchesSuggestion) continue;
        }

        const spoken = resolved.transcript.utterances.filter((u) => sameRef(u.speaker, info.ref));
        const seconds = speakingSeconds(spoken);

        // Keyed by voice where there is one; otherwise by this meeting and
        // this speaker, which is as far as identity is knowable.
        const key = voice ?? `${id}#${info.ref.stream}#${info.ref.cluster ?? '-'}`;
        const entry: Accumulator = people.get(key) ?? {
          label: info.label,
          labelDate: startedAt,
          voiceId: voice,
          suggestion:
            suggestion === undefined
              ? undefined
              : { name: suggestion.name, tier: suggestion.tier === 'strong' ? 'strong' : 'weak' },
          seconds: 0,
          appearances: new Map(),
        };
        entry.seconds += seconds;
        // A person's current name is the one most recently recorded.
        if (startedAt >= entry.labelDate) {
          entry.label = info.label;
          entry.labelDate = startedAt;
        }
        const existing = entry.appearances.get(id);
        entry.appearances.set(id, {
          meeting_id: id,
          title: manifest.title,
          started_at: isoSeconds(startedAt),
          startedAtMs: startedAt,
          speaking_seconds: (existing?.speaking_seconds ?? 0) + seconds,
          utterance_count: (existing?.utterance_count ?? 0) + spoken.length,
        });
        people.set(key, entry);
      }
    }

    // Loudest first; two people who spoke for exactly as long are ordered by
    // their identity key, so the ordering is the same on every call.
    const ranked: Array<{ key: string; person: PersonPayload }> = [];
    for (const [key, entry] of people) {
      const all = [...entry.appearances.values()].sort((a, b) => b.startedAtMs - a.startedAtMs);
      const shown = all.slice(0, MAX_APPEARANCES);
      ranked.push({
        key,
        person: {
          label: entry.label,
          enrolled_voice_id: entry.voiceId ?? null,
          meeting_count: all.length,
          total_speaking_seconds: entry.seconds,
          first_seen: all[all.length - 1]!.started_at,
          last_seen: all[0]!.started_at,
          appearances: shown.map(({ startedAtMs: _ms, ...rest }) => rest),
          appearances_truncated: shown.length < all.length,
          suggested_name: entry.suggestion?.name,
          tier: entry.suggestion?.tier,
        },
      });
    }
    ranked.sort((a, b) =>
      a.person.total_speaking_seconds === b.person.total_speaking_seconds
        ? a.key < b.key
          ? -1
          : a.key > b.key
            ? 1
            : 0
        : b.person.total_speaking_seconds - a.person.total_speaking_seconds
    );
    const payloads = ranked.map((r) => r.person);

    // The cursor is an offset into that same ordering.
    const start = Math.min(countCursor(input.cursor), payloads.length);
    const { kept, truncated: budgetTruncated } = fit(payloads.slice(start), 150);
    const consumed = start + kept.length;
    const truncated = consumed < payloads.length || budgetTruncated;

    const note =
      payloads.length === 0 && (input.voiceId !== undefined || input.nameContains !== undefined)
        ? 'An empty result here is not proof of absence: no enrolled ' +
          'voice and no inferred name matches. Only enrolled voices ' +
          'are indexed by name across meetings; an unenrolled speaker ' +
          'appears per meeting, under a name heard in the ' +
          'conversation if there was one and otherwise under a ' +
          'generated label such as "Remote 1". To find a person by ' +
          'name, search_transcripts for it instead.'
        : undefined;

    return {
      people: kept,
      truncated,
      next_cursor: truncated ? String(consumed) : undefined,
      // list_speakers takes no limit, so the budget is the only thing that can cut a page.
      truncation_reason: truncated ? 'response_size_budget' : undefined,
      note,
    };
  }
}
