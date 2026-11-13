/**
 * An in-memory library for the query tests: the artifact files a store on
 * disk would hold, behind the `LibraryReader` interface, with the same
 * helpers Scribe's `Fixtures.swift` gives its tests (`ref`, `utterance`,
 * `transcript`, `speaker`, a `meeting` builder whose dates are whole days
 * from the epoch). Tests only.
 */
import { randomUUID } from 'crypto';

import type {
  AudioStream,
  BleedWindow,
  LabelOrigin,
  Manifest,
  MeetingSummaryFile,
  MeetingTagsFile,
  SpeakerInference,
  SpeakerInferencesFile,
  SpeakerInfo,
  SpeakerLabelsFile,
  SpeakerRef,
  TagListFile,
  TimedToken,
  TitleOrigin,
  Transcript,
  Utterance,
} from '../artifacts';
import { CURRENT_SUMMARIZER_VERSION, CURRENT_TAGGER_VERSION, sameRef } from '../artifacts';
import type { LibraryReader } from '../library-reader';
import { MAX_CHARACTERS } from './budget';
import { fingerprint } from './resolved';

export const DAY_MS = 86_400_000;

export const ref = (stream: AudioStream, cluster: string | null): SpeakerRef =>
  cluster === null ? { stream } : { stream, cluster };

export const utterance = (
  text: string,
  speaker: SpeakerRef,
  from: number,
  to: number,
  extra: {
    speakerConfidence?: number;
    textConfidence?: number | null;
    overlapped?: boolean;
    tokens?: TimedToken[];
  } = {}
): Utterance => ({
  start: from,
  end: to,
  speaker,
  text,
  speakerConfidence: extra.speakerConfidence ?? 0.9,
  ...(extra.textConfidence === null ? {} : { textConfidence: extra.textConfidence ?? 0.8 }),
  overlapped: extra.overlapped ?? false,
  tokens: extra.tokens ?? [],
});

export const speaker = (r: SpeakerRef, label: string, voice?: string): SpeakerInfo => ({
  ref: r,
  label,
  ...(voice === undefined ? {} : { enrolledVoiceID: voice }),
});

export const transcript = (input: {
  id?: string;
  speakers: SpeakerInfo[];
  utterances: Utterance[];
}): Transcript => ({
  meetingID: (input.id ?? randomUUID()).toUpperCase(),
  speakers: input.speakers,
  utterances: input.utterances,
});

/** `SpeakerLabels` as a file: one entry per named speaker. */
export class Labels {
  readonly file: SpeakerLabelsFile = { entries: [], refusals: [] };
  set(name: string, r: SpeakerRef, origin: LabelOrigin = { human: {} }): this {
    const existing = this.file.entries.find((e) => sameRef(e.ref, r));
    if (existing) {
      existing.name = name;
      existing.origin = origin;
    } else {
      this.file.entries.push({ ref: r, name, origin });
    }
    return this;
  }
  get isEmpty(): boolean {
    return this.file.entries.length === 0;
  }
}

export const human: LabelOrigin = { human: {} };
export const inferred: LabelOrigin = { inferred: {} };
export const voiceprint = (id: string): LabelOrigin => ({ voiceprint: { id } });

/** Text that overruns the response budget on its own, wherever it is put. */
export const TEXT_LARGER_THAN_THE_BUDGET = 'x'.repeat(MAX_CHARACTERS + 5_000);

export type MeetingOptions = {
  title: string;
  day: number;
  duration?: number;
  micDuration?: number;
  systemDuration?: number;
  bleedWindows?: BleedWindow[];
  transcript?: Transcript;
  labels?: Labels;
  legacyManifest?: boolean;
  titleOrigin?: TitleOrigin;
  scheduledStart?: number;
  scheduledEnd?: number;
  attendeeNames?: string[];
  attendeeKinds?: Array<string | null>;
};

type Bundle = {
  manifest: Manifest | 'broken';
  transcript?: Transcript;
  labels?: SpeakerLabelsFile;
  inferences?: SpeakerInferencesFile;
  summary?: MeetingSummaryFile;
  tags?: MeetingTagsFile;
};

const iso = (ms: number) => new Date(ms).toISOString().replace(/\.000Z$/, 'Z');

export class FakeLibrary {
  private readonly bundles = new Map<string, Bundle>();
  private tagListFile: TagListFile | null = null;

  /** A meeting with a manifest and, when given, a transcript. Returns its lowercase id. */
  meeting(options: MeetingOptions): string {
    const id = (options.transcript?.meetingID ?? randomUUID()).toLowerCase();
    const startedAt = options.day * DAY_MS;
    const duration = options.duration ?? 600;
    const manifest: Manifest = {
      meetingID: id.toUpperCase(),
      title: options.title,
      startedAt: iso(startedAt),
      endedAt: iso(startedAt + duration * 1000),
      duration,
      sampleRate: 16_000,
      deviceIdentifier: 'Apple M3',
      bleedWindows: options.bleedWindows ?? [],
    };
    if (!options.legacyManifest) {
      manifest.micDuration = options.micDuration ?? duration;
      manifest.systemDuration = options.systemDuration ?? duration;
    }
    if (options.titleOrigin !== undefined) manifest.titleOrigin = options.titleOrigin;
    if (options.scheduledStart !== undefined) manifest.scheduledStart = iso(options.scheduledStart);
    if (options.scheduledEnd !== undefined) manifest.scheduledEnd = iso(options.scheduledEnd);
    if (options.attendeeNames !== undefined) manifest.attendeeNames = options.attendeeNames;
    if (options.attendeeKinds !== undefined) manifest.attendeeKinds = options.attendeeKinds;
    const bundle: Bundle = { manifest };
    if (options.transcript) bundle.transcript = options.transcript;
    if (options.labels && !options.labels.isEmpty) bundle.labels = options.labels.file;
    this.bundles.set(id, bundle);
    return id;
  }

  private bundle(id: string): Bundle {
    const b = this.bundles.get(id.toLowerCase());
    if (!b) throw new Error(`no meeting ${id}`);
    return b;
  }

  rawTranscript(id: string): Transcript {
    const t = this.bundle(id).transcript;
    if (!t) throw new Error(`no transcript for ${id}`);
    return t;
  }

  saveSummary(
    id: string,
    text: string,
    options: { fresh?: boolean; fingerprint?: string; version?: number } = {}
  ): void {
    const b = this.bundle(id);
    b.summary = {
      meetingID: id.toUpperCase(),
      text,
      generatedAt: iso(0),
      transcriptFingerprint:
        options.fingerprint ??
        ((options.fresh ?? true) && b.transcript ? fingerprint(b.transcript) : '0000000000000000'),
      summarizerVersion: options.version ?? CURRENT_SUMMARIZER_VERSION,
    };
  }

  saveTags(
    id: string,
    applied: Array<[string, 'auto' | 'human']>,
    options: { fresh?: boolean; suggestion?: string; version?: number } = {}
  ): void {
    const b = this.bundle(id);
    b.tags = {
      applied: applied.map(([tagID, origin]) => ({ tagID, origin })),
      removed: [],
      dismissed: [],
      ...(options.suggestion === undefined
        ? {}
        : { suggestion: { name: options.suggestion, description: '' } }),
      taggerVersion: options.version ?? CURRENT_TAGGER_VERSION,
      fingerprint:
        (options.fresh ?? true) && b.transcript ? fingerprint(b.transcript) : '0000000000000000',
    };
  }

  saveInferences(id: string, entries: SpeakerInference[]): void {
    this.bundle(id).inferences = { entries };
  }

  saveLabels(id: string, labels: Labels): void {
    this.bundle(id).labels = labels.file;
  }

  saveTagList(list: TagListFile): void {
    this.tagListFile = list;
  }

  breakManifest(id: string): void {
    this.bundle(id).manifest = 'broken';
  }

  remove(id: string): void {
    this.bundles.delete(id.toLowerCase());
  }

  reader(): LibraryReader {
    const get = (id: string) => this.bundles.get(id);
    return {
      listMeetingIds: async () => [...this.bundles.keys()].sort(),
      manifest: async (id) => {
        const b = get(id);
        return b === undefined || b.manifest === 'broken' ? null : b.manifest;
      },
      transcript: async (id) => get(id)?.transcript ?? null,
      labels: async (id) => get(id)?.labels ?? null,
      inferences: async (id) => get(id)?.inferences ?? null,
      summary: async (id) => get(id)?.summary ?? null,
      meetingTags: async (id) => get(id)?.tags ?? null,
      tagList: async () => this.tagListFile,
    };
  }
}

export const suggesting = (
  name: string,
  target: SpeakerRef,
  options: {
    tier?: 'strong' | 'weak';
    kind?: 'self_introduction' | 'call_and_response';
    index?: number;
    quote?: string;
  } = {}
): SpeakerInference => ({
  ref: target,
  name,
  tier: options.tier ?? 'weak',
  status: 'suggested',
  evidence: [
    {
      kind: options.kind ?? 'self_introduction',
      utterance_index: options.index ?? 1,
      quote: options.quote ?? 'Hi, my name is Dominique.',
    },
  ],
});
