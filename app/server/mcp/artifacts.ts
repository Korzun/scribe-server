/**
 * The plaintext JSON Scribe writes into a meeting's bundle, as the vault
 * reads it back once a blob is opened (spec §6): `manifest.json`,
 * `transcript.json`, `labels.json`, `inferences.json`, `summary.json`,
 * `tags.json` and the library-wide `tags.json`. These shapes mirror the Swift
 * `Codable` types in Scribe (`ScribeCore`, `ScribeStore`): optional fields
 * are absent, never null, and dates are ISO 8601 strings. Nothing here reads
 * audio, and nothing here carries a voiceprint or an embedding.
 */

export type AudioStream = 'microphone' | 'system';

/** `cluster` absent means the utterance could not be attributed to any cluster. */
export type SpeakerRef = { stream: AudioStream; cluster?: string };

export const sameRef = (a: SpeakerRef, b: SpeakerRef): boolean =>
  a.stream === b.stream && (a.cluster ?? null) === (b.cluster ?? null);

export type BleedWindow = { start: number; coefficient: number; lag: number };

export type TitleOrigin = 'calendar' | 'windowTitle' | 'adHoc' | 'human';

/** `RecordingManifest`. Only the fields the tools read are named. */
export type Manifest = {
  meetingID: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  duration: number;
  micDuration?: number;
  systemDuration?: number;
  sampleRate: number;
  deviceIdentifier?: string;
  bleedWindows: BleedWindow[];
  titleOrigin?: TitleOrigin;
  scheduledStart?: string;
  scheduledEnd?: string;
  attendeeNames?: string[];
  attendeeKinds?: Array<string | null>;
};

export type TimedToken = { text: string; start: number; end: number; confidence?: number };

export type SpeakerInfo = { ref: SpeakerRef; label: string; enrolledVoiceID?: string };

export type Utterance = {
  start: number;
  end: number;
  speaker: SpeakerRef;
  text: string;
  speakerConfidence: number;
  textConfidence?: number;
  overlapped: boolean;
  tokens: TimedToken[];
};

export type Transcript = { meetingID: string; speakers: SpeakerInfo[]; utterances: Utterance[] };

/**
 * `LabelOrigin`, as Swift's synthesized `Codable` writes an enum with
 * associated values: the case name as the one key, its payload as the value
 * (an empty object when there is none). A file written before origins
 * existed has no `origin` and reads as human.
 */
export type LabelOrigin = { human: object } | { voiceprint: { id: string } } | { inferred: object };

export type SpeakerLabelsFile = {
  entries: Array<{ ref: SpeakerRef; name: string; origin?: LabelOrigin }>;
  refusals?: Array<{ ref: SpeakerRef; voiceID: string }>;
};

export type EvidenceKind = 'self_introduction' | 'call_and_response';
export type InferenceTier = 'strong' | 'weak';
export type InferenceStatus = 'applied' | 'suggested' | 'dismissed';

export type SpeakerInference = {
  ref: SpeakerRef;
  name: string;
  tier: InferenceTier;
  status: InferenceStatus;
  evidence: Array<{ kind: EvidenceKind; quote: string; utterance_index: number }>;
};

export type SpeakerInferencesFile = { entries: SpeakerInference[] };

export type MeetingSummaryFile = {
  meetingID: string;
  text: string;
  generatedAt: string;
  transcriptFingerprint: string;
  /** Absent in a file written before versions existed, which reads as stale. */
  summarizerVersion?: number;
};

/** `MeetingSummary.currentSummarizerVersion` in Scribe. */
export const CURRENT_SUMMARIZER_VERSION = 2;

export type TagOrigin = 'auto' | 'human';
export type TagTier = 'context' | 'format' | 'topic';

export type MeetingTagsFile = {
  applied: Array<{ tagID: string; origin: TagOrigin }>;
  removed: string[];
  dismissed: string[];
  suggestion?: { name: string; description: string };
  taggerVersion?: number;
  fingerprint: string;
};

/** `MeetingTags.currentTaggerVersion` in Scribe. */
export const CURRENT_TAGGER_VERSION = 3;

export type Tag = {
  id: string;
  name: string;
  /** Lists saved before topics existed spell formats as `type`. */
  tier: TagTier | 'type';
  description: string;
};

export type TagListFile = { tags: Tag[] };

/** `TagList.starter`: what a library with no saved list reads as. Fixed ids. */
export const STARTER_TAG_LIST: TagListFile = {
  tags: [
    {
      id: 'starter-work',
      name: 'Work',
      tier: 'context',
      description: 'Anything to do with my job.',
    },
    {
      id: 'starter-personal',
      name: 'Personal',
      tier: 'context',
      description: 'Life outside work: health, family, friends.',
    },
    {
      id: 'starter-standup',
      name: 'Standup',
      tier: 'format',
      description: 'A short, recurring team status meeting.',
    },
    {
      id: 'starter-one-on-one',
      name: '1:1',
      tier: 'format',
      description: 'A private meeting between me and one colleague.',
    },
    {
      id: 'starter-interview',
      name: 'Interview',
      tier: 'format',
      description: 'I am interviewing a candidate.',
    },
    {
      id: 'starter-interviewee',
      name: 'Interviewee',
      tier: 'format',
      description: 'I am the candidate being interviewed.',
    },
    {
      id: 'starter-therapy',
      name: 'Therapy',
      tier: 'format',
      description: 'A therapy or counselling session: me alone with a therapist.',
    },
    {
      id: 'starter-technical',
      name: 'Technical',
      tier: 'topic',
      description: 'Deep technical discussion: code, system design, debugging.',
    },
  ],
};
