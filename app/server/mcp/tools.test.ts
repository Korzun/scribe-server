import { describe, expect, it } from 'vitest';

import {
  FakeLibrary,
  Labels,
  ref,
  speaker,
  suggesting,
  transcript,
  utterance,
  voiceprint,
} from './queries/test-fixture';
import { callTool, callToolRecordingAccess, TOOLS } from './tools';

const mic = ref('microphone', '0');

const textOf = (result: Awaited<ReturnType<typeof callTool>>): string =>
  result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('');

const errorText = (result: Awaited<ReturnType<typeof callTool>>): string | undefined =>
  result.isError === true ? textOf(result) : undefined;

/** A transcript to ask badly-formed questions of. */
const oneMeeting = (lib: FakeLibrary) =>
  lib.meeting({
    title: 'Standup',
    day: 1,
    transcript: transcript({
      speakers: [speaker(mic, 'Room 1')],
      utterances: [
        utterance('morning all', mic, 0, 3),
        utterance('the migration ships Friday', mic, 3, 6),
      ],
    }),
  });

describe('the catalog', () => {
  it('declares the five tools the spec names, every one read-only', () => {
    expect(TOOLS.map((t) => t.name)).toEqual([
      'search_transcripts',
      'list_meetings',
      'get_transcript',
      'get_meeting',
      'list_speakers',
    ]);
    for (const tool of TOOLS) {
      expect(tool.annotations).toEqual({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      });
      expect(tool.description).toBeTruthy();
      expect(tool.description).not.toContain('\n');
    }
  });

  it('every schema is an object whose properties are described', () => {
    for (const tool of TOOLS) {
      expect(tool.inputSchema.type).toBe('object');
      const properties = tool.inputSchema.properties as Record<
        string,
        { type: string; description: string }
      >;
      expect(Object.keys(properties).length).toBeGreaterThan(0);
      for (const [key, property] of Object.entries(properties)) {
        expect(property.type, `${tool.name}.${key}`).toBeTruthy();
        expect(property.description, `${tool.name}.${key}`).toBeTruthy();
      }
      for (const required of tool.inputSchema.required ?? []) {
        expect(properties[required], `${tool.name} requires ${required}`).toBeDefined();
      }
    }
  });

  it('every declared parameter is one the handler actually reads', async () => {
    const lib = new FakeLibrary();
    const id = oneMeeting(lib);
    for (const tool of TOOLS) {
      const args: Record<string, unknown> = { meeting_id: id, query: 'morning' };
      const { read } = await callToolRecordingAccess(lib.reader(), tool.name, args);
      for (const key of Object.keys(tool.inputSchema.properties ?? {})) {
        expect(read.has(key), `${tool.name} never reads ${key}`).toBe(true);
      }
    }
  });

  it('an unknown tool is an error result rather than a crash', async () => {
    const result = await callTool(new FakeLibrary().reader(), 'delete_everything', undefined);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toBe("Unknown tool 'delete_everything'.");
  });

  it('a tool call returns one text block and no structured content', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Standup', day: 1 });
    const result = await callTool(lib.reader(), 'list_meetings', undefined);
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    expect(result.content).toHaveLength(1);
    expect(textOf(result)).toContain('Standup');
    expect(textOf(result)).toContain('meeting_id');
  });

  it('arguments survive being sent as strings, and null means absent', async () => {
    const lib = new FakeLibrary();
    for (let day = 1; day <= 5; day++) lib.meeting({ title: `Day ${day}`, day });
    const text = textOf(await callTool(lib.reader(), 'list_meetings', { limit: '2' }));
    expect(text).toContain('Day 5');
    expect(text).not.toContain('Day 3');
    const nulls = await callTool(lib.reader(), 'list_meetings', {
      limit: null,
      title_contains: null,
    });
    expect(nulls.isError).toBeUndefined();
    expect(textOf(nulls)).toContain('Day 1');
  });

  it('a bad meeting id, a missing argument and an ISO date are handled as Scribe handles them', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Day 1', day: 1 });
    lib.meeting({ title: 'Day 5', day: 5 });
    expect(errorText(await callTool(lib.reader(), 'get_meeting', { meeting_id: 'banana' }))).toBe(
      "'banana' is not a valid meeting id. Meeting ids are UUIDs, as returned by list_meetings."
    );
    expect(errorText(await callTool(lib.reader(), 'get_transcript', undefined))).toBe(
      "Required argument 'meeting_id' is missing."
    );
    const text = textOf(await callTool(lib.reader(), 'list_meetings', { from: '1970-01-04' }));
    expect(text).toContain('Day 5');
    expect(text).not.toContain('Day 1');
    expect(errorText(await callTool(lib.reader(), 'list_meetings', { from: 'yesterday' }))).toBe(
      "'yesterday' is not a date. 'from' takes an ISO 8601 date such as 2026-08-31."
    );
  });

  it('refuses an unreadable argument rather than reading it as absent', async () => {
    const lib = new FakeLibrary();
    const id = oneMeeting(lib);
    const r = lib.reader();
    expect(errorText(await callTool(r, 'get_transcript', { meeting_id: id, detail: 'FULL' }))).toBe(
      "'FULL' is not a valid 'detail'. It takes one of: text, full."
    );
    expect(
      errorText(await callTool(r, 'get_transcript', { meeting_id: id, start_time: 'abc' }))
    ).toBe("'start_time' takes a number; 'abc' is not one.");
    expect(errorText(await callTool(r, 'list_meetings', { limit: 'lots' }))).toBe(
      "'limit' takes a whole number; 'lots' is not one."
    );
    expect(
      errorText(await callTool(r, 'get_transcript', { meeting_id: id, include_tokens: 'maybe' }))
    ).toBe("'include_tokens' takes true or false; 'maybe' is not one.");
    expect(
      errorText(await callTool(r, 'search_transcripts', { query: 'migration', meeting_ids: id }))
    ).toContain("'meeting_ids' takes an array of strings");
    expect(
      errorText(
        await callTool(r, 'search_transcripts', { query: 'migration', meeting_ids: [{ id: 'x' }] })
      )
    ).toBeDefined();
    expect(
      errorText(
        await callTool(r, 'search_transcripts', { query: 'migration', meeting_ids: ['banana'] })
      )
    ).toContain('banana');
    expect(
      errorText(await callTool(r, 'search_transcripts', { query: 'migration', match: 'strict' }))
    ).toBe("'strict' is not a valid 'match'. It takes one of: fuzzy, literal.");
    expect(errorText(await callTool(r, 'search_transcripts', { query: '' }))).toBe(
      "Required argument 'query' is missing."
    );
  });

  it('wires the duration filter and the match argument through to the queries', async () => {
    const lib = new FakeLibrary();
    const id = oneMeeting(lib);
    lib.meeting({
      title: 'Sync',
      day: 2,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('the evalves finished', mic, 0, 2)],
      }),
    });
    const r = lib.reader();
    const filtered = textOf(
      await callTool(r, 'get_transcript', { meeting_id: id, min_duration_seconds: 600 })
    );
    expect(filtered).not.toContain('morning all');
    expect(filtered).toContain('utterances_filtered_out');
    expect(textOf(await callTool(r, 'search_transcripts', { query: 'evals' }))).toContain(
      'evalves'
    );
    expect(
      textOf(await callTool(r, 'search_transcripts', { query: 'evals', match: 'literal' }))
    ).not.toContain('evalves');
  });

  it('no payload ever carries a voice embedding, and every date is ISO 8601', async () => {
    const lib = new FakeLibrary();
    const system = ref('system', '0');
    const id = lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1', 'v1'), speaker(system, 'Remote 1')],
        utterances: [
          utterance('hello', mic, 0, 2, {
            tokens: [{ text: 'hello', start: 0, end: 2, confidence: 0.9 }],
          }),
          utterance('Hi, my name is Dominique.', system, 3, 5),
        ],
      }),
      labels: new Labels().set('Dana', mic, voiceprint('v1')),
    });
    lib.saveInferences(id, [suggesting('Dominique', system, { index: 1 })]);
    const r = lib.reader();
    const calls: Array<[string, Record<string, unknown> | undefined]> = [
      ['list_meetings', undefined],
      ['get_meeting', { meeting_id: id }],
      ['get_transcript', { meeting_id: id, detail: 'full', include_tokens: true }],
      ['search_transcripts', { query: 'hello' }],
      ['list_speakers', undefined],
    ];
    const dateKeys = new Set([
      'started_at',
      'ended_at',
      'first_seen',
      'last_seen',
      'scheduled_start',
      'scheduled_end',
    ]);
    const datesIn = (value: unknown, found: unknown[] = []): unknown[] => {
      if (Array.isArray(value)) value.forEach((v) => datesIn(v, found));
      else if (value !== null && typeof value === 'object') {
        for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
          if (dateKeys.has(key)) found.push(nested);
          else datesIn(nested, found);
        }
      }
      return found;
    };
    for (const [name, args] of calls) {
      const result = await callTool(r, name, args);
      expect(result.isError, name).toBeUndefined();
      const text = textOf(result);
      expect(text, name).not.toContain('embedding');
      expect(text, name).not.toContain('centroid');
      for (const date of datesIn(JSON.parse(text))) {
        expect(typeof date, name).toBe('string');
        expect(Number.isFinite(Date.parse(date as string)), `${name}: ${String(date)}`).toBe(true);
      }
    }
    const meeting = textOf(await callTool(r, 'get_meeting', { meeting_id: id }));
    expect(meeting).toContain('suggestions');
    expect(meeting).toContain('Dominique');
  });
});
