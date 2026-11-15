/**
 * The wire contract, as Scribe's `Payloads.swift` declares it: snake case,
 * because these names are read by models and by people writing tool calls
 * by hand. A field typed `?:` is ABSENT from the JSON when it has no value
 * (Scribe encodes those with `encodeIfPresent`); a field typed `| null` is
 * written as an explicit null, because for it null is the documented way of
 * saying something ("fusion could not attribute this", "no enrolled voice").
 * Dates are ISO 8601 strings. Nothing here carries an embedding.
 */

export type LabelOriginPayload = 'human' | 'voiceprint' | 'inferred' | 'generated';
export type TitleOriginPayload = 'calendar' | 'window_title' | 'ad_hoc' | 'human';
export type TruncationReasonPayload = 'response_size_budget' | 'end_of_window';
export type MatchTypePayload = 'exact' | 'fuzzy';
export type InferenceTierPayload = 'strong' | 'weak';

export type TagPayload = { name: string; tier: string; origin: string };

export type MeetingRow = {
  meeting_id: string;
  title: string;
  started_at: string;
  ended_at?: string;
  duration_seconds: number;
  speaker_count: number;
  utterance_count: number;
  processed: boolean;
  summary?: string;
  tags?: TagPayload[];
  suggested_tag?: string;
  tags_stale?: boolean;
};

export type MeetingListPayload = {
  meetings: MeetingRow[];
  truncated: boolean;
  next_cursor?: string;
  truncation_reason?: TruncationReasonPayload;
};

export type TokenPayload = {
  text: string;
  start_seconds: number;
  end_seconds: number;
  confidence?: number;
};

export type UtterancePayload = {
  index: number;
  timestamp: string;
  start_seconds: number;
  end_seconds: number;
  speaker: string;
  text: string;
  speaker_confidence?: number;
  text_confidence?: number;
  overlapped?: boolean;
  stream?: string;
  bleed_suspected?: boolean;
  during_utterance_index?: number;
  cluster_id?: string | null;
  label_origin?: LabelOriginPayload;
  enrolled_voice_id?: string | null;
  tokens?: TokenPayload[];
};

export type TranscriptPayload = {
  meeting_id: string;
  title: string;
  started_at: string;
  utterances: UtterancePayload[];
  total_utterances: number;
  utterances_filtered_out?: number;
  truncated: boolean;
  next_offset?: number;
  truncation_reason?: TruncationReasonPayload;
};

export type SuggestionEvidencePayload = {
  kind: 'self_introduction' | 'call_and_response';
  quote: string;
  utterance_index: number;
};

export type SuggestionPayload = {
  name: string;
  tier: InferenceTierPayload;
  evidence: SuggestionEvidencePayload[];
};

export type SpeakerPayload = {
  label: string;
  stream: string;
  cluster_id: string | null;
  label_origin: LabelOriginPayload;
  enrolled_voice_id: string | null;
  utterance_count: number;
  speaking_seconds: number;
  speaking_share: number;
  suggestions?: SuggestionPayload[];
};

export type QualityPayload = {
  mic_duration: number;
  system_duration: number;
  stream_durations_measured: boolean;
  bleed_window_count: number;
  peak_bleed_coefficient?: number;
  low_confidence_utterance_share?: number;
};

export type MeetingDetailPayload = {
  meeting_id: string;
  title: string;
  started_at: string;
  ended_at?: string;
  duration_seconds: number;
  sample_rate: number;
  device_identifier: string;
  processed: boolean;
  utterance_count: number;
  speakers: SpeakerPayload[];
  quality: QualityPayload;
  attendee_names?: string[];
  attendee_kinds?: Array<string | null>;
  scheduled_start?: string;
  scheduled_end?: string;
  title_origin?: TitleOriginPayload;
  summary?: string;
  tags?: TagPayload[];
  suggested_tag?: string;
  tags_stale?: boolean;
};

export type SearchHitPayload = {
  meeting_id: string;
  title: string;
  started_at: string;
  utterance_index: number;
  timestamp: string;
  speaker: string;
  text: string;
  context_before: string[];
  context_after: string[];
  speaker_confidence: number;
  overlapped: boolean;
  match_type?: MatchTypePayload;
  matched_text?: string;
};

export type SearchPayload = {
  hits: SearchHitPayload[];
  meetings_searched: number;
  truncated: boolean;
  next_cursor?: string;
  truncation_reason?: TruncationReasonPayload;
};

export type SpeakerAppearancePayload = {
  meeting_id: string;
  title: string;
  started_at: string;
  speaking_seconds: number;
  utterance_count: number;
};

export type PersonPayload = {
  label: string;
  enrolled_voice_id: string | null;
  meeting_count: number;
  total_speaking_seconds: number;
  first_seen: string;
  last_seen: string;
  appearances: SpeakerAppearancePayload[];
  appearances_truncated: boolean;
  suggested_name?: string;
  tier?: InferenceTierPayload;
};

export type SpeakerListPayload = {
  people: PersonPayload[];
  truncated: boolean;
  next_cursor?: string;
  truncation_reason?: TruncationReasonPayload;
  note?: string;
};
