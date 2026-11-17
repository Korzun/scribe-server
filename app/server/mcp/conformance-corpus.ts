/**
 * The corpus the MCP conformance fixture is exported from (spec §10, "Keeping
 * them honest"), written as a Scribe store on disk: `Meetings/<UUID>/` bundles
 * holding the JSON files `ScribeStore` writes, plus the library's `tags.json`.
 * `scripts/export-mcp-conformance.ts` points Scribe's stdio server at it
 * (`SCRIBE_STORE_ROOT`) to record what that server answers, and
 * `conformance.test.ts` seals the same files into a vault library.
 *
 * Deterministic in every id, date and word, so a re-export is a no-op diff
 * when nothing changed, and shaped so each tool has something to say:
 * processed and unprocessed meetings, every label origin, a suggestion and a
 * dismissal, fresh and stale summaries and tags, a legacy manifest, calendar
 * context with and without attendee kinds, two meetings starting at the same
 * instant, bleed, overlap, tokens, an unattributed line, mangled
 * transcriptions for fuzzy search, and one meeting too long for a single page.
 *
 * The files are spelled the way Swift's `JSONEncoder` spells them for the
 * `Codable` types in `ScribeCore` and `ScribeStore`: optional fields absent
 * rather than null, dates ISO 8601 without fractional seconds (which Swift's
 * `.iso8601` decoder refuses), UUIDs uppercase, keys sorted.
 *
 * The ids below are the ones `test/conformance/script.json` names; change one
 * here and change it there.
 */
import * as fs from 'fs';
import * as path from 'path';

import type {
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
  TimedToken,
  TitleOrigin,
  Transcript,
  Utterance,
} from './artifacts';
import { CURRENT_SUMMARIZER_VERSION, CURRENT_TAGGER_VERSION, STARTER_TAG_LIST } from './artifacts';
import { sortKeys } from './conformance-support';
import { fingerprint } from './queries/resolved';

export const CORPUS_IDS = {
  designReview: '0F1E2D3C-4B5A-4978-8796-A5B4C3D2E1F0',
  standup: '22222222-2222-4222-8222-222222222222',
  syncOne: '33333333-3333-4333-8333-333333333333',
  syncTwo: '44444444-4444-4444-8444-444444444444',
  weekly: '55555555-5555-4555-8555-555555555555',
  inProgress: '66666666-6666-4666-8666-666666666666',
  long: '77777777-7777-4777-8777-777777777777',
} as const;

const DAY_MS = 86_400_000;
const STALE_FINGERPRINT = '0000000000000000';

const mic: SpeakerRef = { stream: 'microphone', cluster: '0' };
const mic2: SpeakerRef = { stream: 'microphone', cluster: '2' };
const remote: SpeakerRef = { stream: 'system', cluster: '1' };
const nobody: SpeakerRef = { stream: 'microphone' };

/** ISO 8601 as Swift's `.iso8601` strategy writes and reads it: whole seconds, `Z`. */
const iso = (ms: number): string => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');

/** Swift's `JSONEncoder` with `.sortedKeys` and `.prettyPrinted`, near enough. */
export const encodeStoreFile = (value: unknown): string =>
  `${JSON.stringify(sortKeys(value), null, 2)}\n`;

const utterance = (
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

const speaker = (ref: SpeakerRef, label: string): SpeakerInfo => ({ ref, label });

const transcript = (id: string, speakers: SpeakerInfo[], utterances: Utterance[]): Transcript => ({
  meetingID: id,
  speakers,
  utterances,
});

const human: LabelOrigin = { human: {} };
const inferred: LabelOrigin = { inferred: {} };
const voiceprint = (id: string): LabelOrigin => ({ voiceprint: { id } });

const labels = (
  ...entries: Array<[name: string, ref: SpeakerRef, origin: LabelOrigin]>
): SpeakerLabelsFile => ({
  entries: entries.map(([name, ref, origin]) => ({ ref, name, origin })),
  refusals: [],
});

const inference = (
  ref: SpeakerRef,
  name: string,
  tier: 'strong' | 'weak',
  status: 'applied' | 'suggested' | 'dismissed',
  evidence: Array<[index: number, quote: string]> = []
): SpeakerInference => ({
  ref,
  name,
  tier,
  status,
  evidence: evidence.map(([utterance_index, quote]) => ({
    kind: 'self_introduction',
    utterance_index,
    quote,
  })),
});

type MeetingSpec = {
  id: string;
  title: string;
  /** Whole days from the epoch, so date-range steps read plainly. */
  day: number;
  duration?: number;
  micDuration?: number;
  systemDuration?: number;
  bleedWindows?: BleedWindow[];
  transcript?: Transcript;
  labels?: SpeakerLabelsFile;
  inferences?: SpeakerInferencesFile;
  summary?: { text: string; fresh: boolean; version?: number };
  tags?: Omit<MeetingTagsFile, 'removed' | 'dismissed' | 'taggerVersion' | 'fingerprint'> & {
    fresh: boolean;
  };
  /** A manifest written before per-stream durations existed. */
  legacyManifest?: boolean;
  /** A recording still in progress: no end, no durations, nothing but the manifest. */
  inProgress?: boolean;
  titleOrigin?: TitleOrigin;
  scheduledStart?: number;
  scheduledEnd?: number;
  attendeeNames?: string[];
  attendeeKinds?: Array<string | null>;
};

function manifestOf(spec: MeetingSpec): Manifest {
  const startedAt = spec.day * DAY_MS;
  const duration = spec.inProgress ? 0 : (spec.duration ?? 600);
  const manifest: Manifest = {
    meetingID: spec.id,
    title: spec.title,
    startedAt: iso(startedAt),
    duration,
    sampleRate: 16_000,
    deviceIdentifier: 'Apple M3',
    bleedWindows: spec.bleedWindows ?? [],
  };
  if (!spec.inProgress) manifest.endedAt = iso(startedAt + duration * 1000);
  if (!spec.legacyManifest) {
    manifest.micDuration = spec.micDuration ?? duration;
    manifest.systemDuration = spec.systemDuration ?? duration;
  }
  if (spec.titleOrigin !== undefined) manifest.titleOrigin = spec.titleOrigin;
  if (spec.scheduledStart !== undefined) manifest.scheduledStart = iso(spec.scheduledStart);
  if (spec.scheduledEnd !== undefined) manifest.scheduledEnd = iso(spec.scheduledEnd);
  if (spec.attendeeNames !== undefined) manifest.attendeeNames = spec.attendeeNames;
  if (spec.attendeeKinds !== undefined) manifest.attendeeKinds = spec.attendeeKinds;
  return manifest;
}

/** The bundle's files by name, as `RecordingBundle` names them. */
export function bundleFiles(spec: MeetingSpec): Record<string, unknown> {
  const files: Record<string, unknown> = { 'manifest.json': manifestOf(spec) };
  if (spec.transcript) files['transcript.json'] = spec.transcript;
  if (spec.labels) files['labels.json'] = spec.labels;
  if (spec.inferences) files['inferences.json'] = spec.inferences;
  const fresh = (wanted: boolean) =>
    wanted && spec.transcript ? fingerprint(spec.transcript) : STALE_FINGERPRINT;
  if (spec.summary) {
    const summary: MeetingSummaryFile = {
      meetingID: spec.id,
      text: spec.summary.text,
      generatedAt: iso(0),
      transcriptFingerprint: fresh(spec.summary.fresh),
      summarizerVersion: spec.summary.version ?? CURRENT_SUMMARIZER_VERSION,
    };
    files['summary.json'] = summary;
  }
  if (spec.tags) {
    const { fresh: tagsFresh, ...rest } = spec.tags;
    const tags: MeetingTagsFile = {
      ...rest,
      removed: [],
      dismissed: [],
      taggerVersion: CURRENT_TAGGER_VERSION,
      fingerprint: fresh(tagsFresh),
    };
    files['tags.json'] = tags;
  }
  return files;
}

export function corpus(): MeetingSpec[] {
  const { designReview, standup, syncOne, syncTwo, weekly, inProgress, long } = CORPUS_IDS;
  return [
    // Design Review, day 2: the richest meeting. Dana by voiceprint, calendar
    // context with kinds, bleed, a backchannel inside a long turn, overlap,
    // tokens, an unattributed line, and the mangled transcriptions fuzzy
    // search exists for.
    {
      id: designReview,
      title: 'Design Review',
      day: 2,
      duration: 600,
      micDuration: 598,
      systemDuration: 412,
      bleedWindows: [
        { start: 0, coefficient: 0.3, lag: 0.01 },
        { start: 5, coefficient: 0.82, lag: 0.02 },
      ],
      transcript: transcript(
        designReview,
        [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1'), speaker(mic2, 'Room 2')],
        [
          utterance('morning all, the migration ships Friday', mic, 0, 3, {
            tokens: [
              { text: 'morning', start: 0, end: 0.5, confidence: 0.95 },
              { text: 'all', start: 0.5, end: 0.8 },
            ],
          }),
          utterance('the evalves finished overnight', remote, 3, 6, { speakerConfidence: 0.42 }),
          utterance('yeah', mic2, 4, 4.5, { overlapped: true }),
          utterance('we fine tuned with cue lura yesterday', mic, 6, 9),
          utterance('Halcion signed the contract', remote, 9, 12, { speakerConfidence: 0.2 }),
          utterance('mumble', nobody, 12, 13, { speakerConfidence: 0.1, textConfidence: null }),
          utterance('those evils keep regressing, hello', mic, 13, 16),
          utterance('emails are stuck in the queue again', remote, 16, 19),
        ]
      ),
      labels: labels(['Dana', mic, voiceprint('v1')]),
      titleOrigin: 'calendar',
      scheduledStart: 2 * DAY_MS,
      scheduledEnd: 2 * DAY_MS + 1_800_000,
      attendeeNames: ['Ana Okafor', 'Boardroom 4', 'louis.byrne@example.com'],
      attendeeKinds: ['person', 'room', null],
      summary: { text: 'They agreed to ship the migration on Friday.', fresh: true },
      tags: {
        applied: [
          { tagID: 'starter-interview', origin: 'auto' },
          { tagID: 'starter-work', origin: 'human' },
        ],
        suggestion: { name: 'Onsite', description: '' },
        fresh: true,
      },
    },

    // Standup, day 3: the same voice under a later name, a weak suggestion
    // and a dismissal on the remote speaker, a stale summary, stale tags.
    {
      id: standup,
      title: 'Standup',
      day: 3,
      transcript: transcript(
        standup,
        [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
        [
          utterance('Go ahead.', mic, 0, 3),
          utterance('Hi, my name is Dominique.', remote, 20, 22),
          utterance('we should ship the migration', mic, 22, 30),
        ]
      ),
      labels: labels(['Dana Okafor', mic, voiceprint('v1')]),
      inferences: {
        entries: [
          inference(remote, 'Dominique', 'weak', 'suggested', [[1, 'Hi, my name is Dominique.']]),
          inference(remote, 'Dom', 'weak', 'dismissed'),
        ],
      },
      summary: { text: 'Speaker 2 pushed back.', fresh: false },
      tags: { applied: [{ tagID: 'starter-work', origin: 'auto' }], fresh: false },
    },

    // Two syncs at the same instant, day 1: one a legacy manifest, the other
    // with a summary an old summarizer wrote.
    {
      id: syncOne,
      title: 'Sync 1',
      day: 1,
      transcript: transcript(
        syncOne,
        [speaker(mic, 'Room 1')],
        [utterance('hello from sync one', mic, 0, 2)]
      ),
      legacyManifest: true,
    },
    {
      id: syncTwo,
      title: 'Sync 2',
      day: 1,
      transcript: transcript(
        syncTwo,
        [speaker(mic, 'Room 1')],
        [utterance('hello from sync two', mic, 0, 2)]
      ),
      summary: { text: 'Written by an old summarizer.', fresh: true, version: 1 },
    },

    // Weekly, day 5: an inferred name that applied itself, a typed name,
    // attendee names with no kinds, no tags file.
    {
      id: weekly,
      title: 'Weekly sync',
      day: 5,
      transcript: transcript(
        weekly,
        [speaker(mic, 'Room 1'), speaker(remote, 'Dominique')],
        [utterance('hello everyone', mic, 0, 2), utterance('hello, Dominique here', remote, 2, 4)]
      ),
      labels: labels(['Dominique', remote, inferred], ['Sam', mic, human]),
      inferences: {
        entries: [
          inference(remote, 'Dominique', 'strong', 'applied', [[1, 'hello, Dominique here']]),
        ],
      },
      attendeeNames: ['Sam Byrne'],
    },

    // In progress, day 4: a manifest and nothing else.
    { id: inProgress, title: 'In progress', day: 4, inProgress: true },

    // Long, day 0: four hundred lines of thirty words, so the budget cuts
    // every page of its transcript and of a search through it.
    {
      id: long,
      title: 'Long',
      day: 0,
      duration: 400,
      transcript: transcript(
        long,
        [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
        Array.from({ length: 400 }, (_, i) =>
          utterance(`${'word '.repeat(30)}${i}`, i % 2 === 0 ? mic : remote, i, i + 1)
        )
      ),
    },
  ];
}

/**
 * Writes the corpus as a Scribe store under `root`, replacing whatever was
 * there. Returns the paths written, relative to `root`, in order.
 */
export function writeCorpus(root: string): string[] {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(path.join(root, 'Meetings'), { recursive: true });
  const written: string[] = [];
  const put = (relative: string, value: unknown) => {
    const target = path.join(root, relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, encodeStoreFile(value));
    written.push(relative);
  };
  // `TagList.starter` as `Store.saveTagList` writes it: every tag automatic,
  // no colours chosen yet.
  put('tags.json', { tags: STARTER_TAG_LIST.tags.map((t) => ({ ...t, isAutomatic: true })) });
  for (const spec of corpus()) {
    for (const [name, value] of Object.entries(bundleFiles(spec))) {
      put(path.join('Meetings', spec.id, name), value);
    }
  }
  return written;
}
