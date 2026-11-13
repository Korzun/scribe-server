/**
 * The five tools, their schemas, and the dispatch from a call to a query: a
 * port of Scribe's `ToolCatalog.swift`. The schemas and descriptions are
 * Scribe's byte for byte, which is what lets an agent see one Scribe through
 * either door; the conformance fixture compares them. Nothing here logs.
 */
import type { CallToolResult, Tool } from '@modelcontextprotocol/sdk/types.js';

import type { LibraryReader } from './library-reader';
import { Arguments } from './queries/arguments';
import { encodePayload } from './queries/budget';
import { QueryError } from './queries/errors';
import { MAX_APPEARANCES, MAX_CONTEXT_LINES, Queries } from './queries/queries';

type Property = Record<string, unknown>;

const schema = (properties: Record<string, Property>, required: string[] = []) => ({
  type: 'object' as const,
  properties,
  ...(required.length > 0 ? { required } : {}),
});

const property = (type: string, description: string): Property => ({ type, description });

const enumProperty = (cases: string[], description: string): Property => ({
  type: 'string',
  enum: cases,
  description,
});

const stringArray = (description: string): Property => ({
  type: 'array',
  items: { type: 'string' },
  description,
});

const READ_ONLY = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
};

const DATE_DESCRIPTION = 'ISO 8601 date or timestamp, e.g. 2026-08-31 or 2026-08-31T14:00:00Z.';

const TAGS_DESCRIPTION =
  'Only meetings carrying every one of these tags, ignoring case — ' +
  'e.g. ["Work", "Interview"]. Tags are one Context ' +
  '(like Work or Personal), at most one Format (like ' +
  'Standup or Interviewee) and at most one Topic (like ' +
  'Technical); see list_meetings for a ' +
  "meeting's tags.";

/** Scribe's multi-line literals, one line each, joined as the `\` continuation joins them. */
const lines = (...parts: string[]) => parts.join(' ');

export const TOOLS: Tool[] = [
  {
    name: 'search_transcripts',
    description: lines(
      'Search every meeting transcript for a phrase. Start here when you',
      'do not already know which meeting you want — it returns matching',
      'lines with surrounding context instead of whole transcripts.',
      'Matching is fuzzy by default, because transcripts are speech',
      'recognition output that mangles names and jargon — "evals"',
      'arrives as "evalves", "QLoRA" as "cue lura". Fuzzy hits carry',
      'match_type and, when the words differ from the query,',
      'matched_text — what was actually transcribed — so you can judge',
      'each one. Pass match="literal" for exact-phrase search. Each',
      'hit carries the meeting id and an utterance_index you can pass to',
      'get_transcript as `offset` to read on from that point.',
      'Responses are capped by total size, so a page may hold fewer',
      'hits than `limit` asked for. When truncated is true there are',
      'more hits — truncation_reason says why the page ended — and',
      'calling again with cursor=next_cursor gets them.'
    ),
    inputSchema: schema(
      {
        query: property('string', 'Case-insensitive phrase to find.'),
        match: enumProperty(
          ['fuzzy', 'literal'],
          '"fuzzy" (the default) also finds mangled transcriptions ' +
            'of the query; "literal" only exact substrings.'
        ),
        from: property('string', `Only meetings starting on or after this. ${DATE_DESCRIPTION}`),
        to: property('string', `Only meetings starting on or before this. ${DATE_DESCRIPTION}`),
        meeting_ids: stringArray('Restrict the search to these meeting ids.'),
        speaker: property('string', 'Only lines whose speaker name contains this.'),
        context_lines: property(
          'integer',
          'Utterances of context each side of a hit. Default 1, ' +
            `maximum ${MAX_CONTEXT_LINES}; larger values are clamped.`
        ),
        limit: property('integer', 'Maximum hits to return. Default 50.'),
        cursor: property('string', 'next_cursor from a previous call, to read on from there.'),
        tags: stringArray(TAGS_DESCRIPTION),
      },
      ['query']
    ),
    annotations: READ_ONLY,
  },
  {
    name: 'list_meetings',
    description: lines(
      'List recorded meetings, newest first. A meeting that is still',
      'recording or not yet transcribed is listed with processed=false',
      'and no speakers. Most rows carry a summary: a paragraph saying',
      'what that meeting was about, so a whole month can be scanned',
      'here rather than by reading transcripts. Titles are weak',
      'evidence: they come from calendar invites and window titles,',
      'and are often wrong, stale, or shared by unrelated meetings —',
      'to find a meeting by who was there or what was said, use',
      'search_transcripts instead. Each row also carries tags: one',
      'Context, at most one Format and at most one Topic, each with',
      'origin "human" (a',
      'person chose it) or "auto" (chosen on device, and may be wrong).'
    ),
    inputSchema: schema({
      from: property('string', `Only meetings starting on or after this. ${DATE_DESCRIPTION}`),
      to: property('string', `Only meetings starting on or before this. ${DATE_DESCRIPTION}`),
      title_contains: property(
        'string',
        'Only meetings whose title contains this, ignoring case. A ' +
          'weak hint, not a lookup: titles are often wrong, stale, ' +
          'or duplicated, so prefer search_transcripts to find a ' +
          'meeting by its people or its content.'
      ),
      limit: property('integer', 'Maximum meetings to return. Default 50.'),
      cursor: property('string', 'next_cursor from a previous call, to read on from there.'),
      tags: stringArray(TAGS_DESCRIPTION),
    }),
    annotations: READ_ONLY,
  },
  {
    name: 'get_transcript',
    description: lines(
      "Read one meeting's transcript. Supply either a time window",
      '(start_time/end_time, seconds from the start of the recording) or',
      'an utterance window (offset/limit) — not both. Use detail="full"',
      'to get what the pipeline knows about each line: how confident the',
      'speaker attribution was, whether the speech overlapped someone',
      'else, whether the speaker was in the room (stream="microphone")',
      'or on the call (stream="system"), and where their name came',
      'from — label_origin runs human (typed) > voiceprint',
      '(biometric) > inferred (heard in the conversation) > generated',
      '(placeholder), strongest first.',
      'Responses are capped by total size, so a page may hold fewer',
      'utterances than `limit` asked for; when truncated is true,',
      'truncation_reason says why the page ended, and calling again',
      'with offset=next_offset continues.'
    ),
    inputSchema: schema(
      {
        meeting_id: property(
          'string',
          "The meeting's UUID, from list_meetings or search_transcripts."
        ),
        start_time: property('number', 'Window start, seconds from the start of the recording.'),
        end_time: property('number', 'Window end, seconds from the start of the recording.'),
        offset: property('integer', 'First utterance index to return.'),
        limit: property('integer', 'Maximum utterances to return.'),
        min_duration_seconds: property(
          'number',
          'Drop lines shorter than this many seconds — backchannels ' +
            "like 'Yeah.' are typically under ~1.5s. The filtered " +
            'count comes back as utterances_filtered_out.'
        ),
        detail: enumProperty(
          ['text', 'full'],
          '"text" for speaker and words only; "full" to also get ' +
            'confidence, overlap, stream and label origin, plus ' +
            'bleed_suspected — the room was measurably echoing the ' +
            'call during this line, so if it reads oddly, that may ' +
            'be why; a hint, not a verdict — and ' +
            'during_utterance_index, the turn this line occurred ' +
            'entirely inside, which tells speech that interrupted a ' +
            'turn apart from listening noises within it. Default ' +
            '"text". "full" is cheap on a narrow window — pair ' +
            'it with offset/limit to check individual suspect lines.'
        ),
        include_tokens: property(
          'boolean',
          'Include per-word timings and confidences. Large; default false.'
        ),
      },
      ['meeting_id']
    ),
    annotations: READ_ONLY,
  },
  {
    name: 'get_meeting',
    description: lines(
      "One meeting's metadata: when it ran, what recorded it, who spoke",
      'and for how long, and a quality block saying how much to trust',
      'the transcript — per-stream durations, acoustic bleed from the',
      'speakers into the microphone, and the share of lines whose',
      'speaker attribution was weak. Cluster ids are assigned per',
      "stream, so a speaker's identity is the (stream, cluster_id)",
      'pair — the same cluster_id on two streams is two people. When',
      'the meeting was matched to a calendar event, the invitees',
      '(attendee_names, with attendee_kinds saying which of them are',
      'people, groups or rooms) and the scheduled slot (scheduled_start,',
      'scheduled_end) are returned too — the slot is what the calendar',
      'intended, where started_at/ended_at are what happened — and',
      'title_origin says whether the title is trustworthy: "calendar"',
      'came from the invite, everything else was guessed. A speaker',
      'nobody has named may carry suggestions — names heard in the',
      'conversation, each with tier ("strong" or "weak") and the',
      'quoted line it came from, whose utterance_index you can pass',
      'to get_transcript as `offset` to read around it. They are',
      'guesses with evidence attached: judge them by the quote.',
      'label_origin runs human (typed) > voiceprint (biometric) >',
      'inferred (heard in the conversation) > generated',
      '(placeholder), strongest first. tags, suggested_tag and',
      'tags_stale are as in list_meetings.'
    ),
    inputSchema: schema({ meeting_id: property('string', "The meeting's UUID.") }, ['meeting_id']),
    annotations: READ_ONLY,
  },
  {
    name: 'list_speakers',
    description: lines(
      'The corpus as people rather than meetings: who has spoken, in how',
      'many meetings, for how long, and when they were first and last',
      'heard. People are identified by enrolled_voice_id, the only key',
      'that links a speaker across meetings — a speaker with no enrolled',
      'voice cannot be linked, and appears as a separate entry per',
      'meeting. Such an entry is still findable by name when the',
      'conversation supplied one: name_contains matches names heard',
      'on tape as well as names on file, and an unenrolled entry',
      'carries suggested_name and tier when a name was only guessed',
      'at rather than applied. An empty result is still not proof of',
      'absence — search_transcripts for the name instead. Each entry',
      `lists at most ${MAX_APPEARANCES} of`,
      "that person's most recent meetings — meeting_count and",
      'total_speaking_seconds always cover all of them — and when',
      'truncated is true there are more people: call again with',
      'cursor=next_cursor.'
    ),
    inputSchema: schema({
      voice_id: property('string', 'Only this enrolled voice.'),
      name_contains: property('string', 'Only people whose name contains this, ignoring case.'),
      from: property('string', `Only meetings starting on or after this. ${DATE_DESCRIPTION}`),
      to: property('string', `Only meetings starting on or before this. ${DATE_DESCRIPTION}`),
      cursor: property('string', 'next_cursor from a previous call, to read on from there.'),
    }),
    annotations: READ_ONLY,
  },
];

/** One text block carrying the message, flagged as an error the model can read and correct. */
export const errorResult = (message: string): CallToolResult => ({
  content: [{ type: 'text', text: message }],
  isError: true,
});

/**
 * One text block of JSON, and nothing else: no `structuredContent` (the same
 * bytes twice doubled every response for clients that forward both, and no
 * tool declares an `outputSchema`).
 */
const reply = (payload: unknown): CallToolResult => ({
  content: [{ type: 'text', text: encodePayload(payload) }],
});

/**
 * Runs one tool call and reports which argument keys it looked at. Never
 * throws: a failure an agent caused is a result it can read and correct, and
 * an error escaping here would reach the transport as a protocol-level
 * failure with no useful message. Anything that is not a `QueryError` is a
 * bug on this side and is reported without its details: the message could
 * carry a path or a fragment of plaintext.
 */
export async function callToolRecordingAccess(
  reader: LibraryReader,
  name: string,
  rawArguments: Record<string, unknown> | undefined
): Promise<{ result: CallToolResult; read: Set<string> }> {
  const args = new Arguments(rawArguments);
  const queries = new Queries(reader);
  try {
    return { result: await dispatch(queries, name, args), read: args.read };
  } catch (err) {
    if (err instanceof QueryError) return { result: errorResult(err.message), read: args.read };
    return {
      result: errorResult('Something went wrong on the server while answering this call.'),
      read: args.read,
    };
  }
}

export async function callTool(
  reader: LibraryReader,
  name: string,
  rawArguments: Record<string, unknown> | undefined
): Promise<CallToolResult> {
  return (await callToolRecordingAccess(reader, name, rawArguments)).result;
}

async function dispatch(queries: Queries, name: string, a: Arguments): Promise<CallToolResult> {
  switch (name) {
    case 'search_transcripts':
      return reply(
        await queries.searchTranscripts({
          query: a.requiredString('query'),
          match: a.match('match'),
          from: a.date('from'),
          to: a.date('to'),
          meetingIds: a.strings('meeting_ids'),
          speaker: a.string('speaker'),
          contextLines: a.int('context_lines') ?? 1,
          limit: a.int('limit') ?? 50,
          cursor: a.string('cursor'),
          tags: a.strings('tags'),
        })
      );
    case 'list_meetings':
      return reply(
        await queries.listMeetings({
          from: a.date('from'),
          to: a.date('to'),
          titleContains: a.string('title_contains'),
          limit: a.int('limit') ?? 50,
          cursor: a.string('cursor'),
          tags: a.strings('tags'),
        })
      );
    case 'get_transcript':
      return reply(
        await queries.getTranscript({
          id: a.requiredString('meeting_id'),
          startTime: a.double('start_time'),
          endTime: a.double('end_time'),
          offset: a.int('offset'),
          limit: a.int('limit'),
          minDurationSeconds: a.double('min_duration_seconds'),
          detail: a.detail('detail'),
          includeTokens: a.bool('include_tokens') ?? false,
        })
      );
    case 'get_meeting':
      return reply(await queries.getMeeting(a.requiredString('meeting_id')));
    case 'list_speakers':
      return reply(
        await queries.listSpeakers({
          voiceId: a.string('voice_id'),
          nameContains: a.string('name_contains'),
          from: a.date('from'),
          to: a.date('to'),
          cursor: a.string('cursor'),
        })
      );
    default:
      throw QueryError.unknownTool(name);
  }
}
