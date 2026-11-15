import { randomUUID } from 'crypto';

import { describe, expect, it } from 'vitest';

import { encodePayload, MAX_CHARACTERS } from './budget';
import { MAX_CONTEXT_LINES, Queries, type SearchMatch } from './queries';
import { DAY_MS, FakeLibrary, Labels, ref, speaker, transcript, utterance } from './test-fixture';

const mic = ref('microphone', '0');

const search = (
  lib: FakeLibrary,
  query: string,
  input: {
    match?: SearchMatch;
    from?: number;
    to?: number;
    meetingIds?: string[];
    speaker?: string;
    contextLines?: number;
    limit?: number;
    cursor?: string;
    tags?: string[];
  } = {}
) =>
  new Queries(lib.reader()).searchTranscripts({
    query,
    match: input.match ?? 'fuzzy',
    from: input.from,
    to: input.to,
    meetingIds: input.meetingIds,
    speaker: input.speaker,
    contextLines: input.contextLines ?? 1,
    limit: input.limit ?? 50,
    cursor: input.cursor,
    tags: input.tags,
  });

/** One meeting whose every line matches, so hits can be counted off exactly. */
const meetingOfMatchingLines = (
  lib: FakeLibrary,
  title: string,
  day: number,
  lines: number,
  textLength = 10
) =>
  lib.meeting({
    title,
    day,
    transcript: transcript({
      speakers: [speaker(mic, 'Room 1')],
      utterances: Array.from({ length: lines }, (_, i) =>
        utterance(`migration ${i} ${'x'.repeat(textLength)}`, mic, i, i + 1)
      ),
    }),
  });

/** The mangled transcriptions this feature exists for. */
const meetingOfMangledLines = (lib: FakeLibrary) =>
  lib.meeting({
    title: 'Weekly sync',
    day: 1,
    transcript: transcript({
      speakers: [speaker(mic, 'Room 1')],
      utterances: [
        utterance('the evalves finished overnight', mic, 0, 2),
        utterance('those evils keep regressing', mic, 2, 4),
        utterance('emails are stuck in the queue again', mic, 4, 6),
        utterance('we fine tuned with cue lura yesterday', mic, 6, 8),
        utterance('Halcion signed the contract', mic, 8, 10),
      ],
    }),
  });

describe('search_transcripts', () => {
  it('finds a line and says where it is', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Design Review',
      day: 2,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [
          utterance('morning all', mic, 0, 2),
          utterance('the migration ships Friday', mic, 2, 5),
          utterance('any questions', mic, 5, 7),
        ],
      }),
    });
    const payload = await search(lib, 'migration');
    expect(payload.hits).toHaveLength(1);
    expect(payload.hits[0]).toMatchObject({
      meeting_id: id,
      title: 'Design Review',
      utterance_index: 1,
      timestamp: '00:00:02',
      speaker: 'Room 1',
      context_before: ['morning all'],
      context_after: ['any questions'],
      speaker_confidence: 0.9,
      overlapped: false,
      match_type: 'exact',
    });
    expect(encodePayload(payload)).not.toContain('matched_text');
  });

  it('ignores case and clamps context at the edges', async () => {
    const lib = new FakeLibrary();
    lib.meeting({
      title: 'Short',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('Migration is done', mic, 0, 2)],
      }),
    });
    expect((await search(lib, 'MIGRATION')).hits).toHaveLength(1);
    const hit = (await search(lib, 'migration', { contextLines: 3 })).hits[0]!;
    expect(hit.context_before).toEqual([]);
    expect(hit.context_after).toEqual([]);
  });

  it('skips a meeting still recording rather than failing the search', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'In progress', day: 1 });
    lib.meeting({
      title: 'Done',
      day: 2,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('migration', mic, 0, 2)],
      }),
    });
    const payload = await search(lib, 'migration');
    expect(payload.hits).toHaveLength(1);
    expect(payload.meetings_searched).toBe(1);
  });

  it('a speaker filter matches the resolved name', async () => {
    const lib = new FakeLibrary();
    const remote = ref('system', '1');
    lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
        utterances: [
          utterance('migration ships', mic, 0, 2),
          utterance('migration blocked', remote, 2, 4),
        ],
      }),
      labels: new Labels().set('Dana', mic),
    });
    expect((await search(lib, 'migration', { speaker: 'dana' })).hits.map((h) => h.text)).toEqual([
      'migration ships',
    ]);
  });

  it('can be confined to named meetings, in either case, and refuses a non-UUID', async () => {
    const lib = new FakeLibrary();
    const wanted = lib.meeting({
      title: 'Wanted',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('migration here', mic, 0, 2)],
      }),
    });
    lib.meeting({
      title: 'Other',
      day: 2,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('migration there', mic, 0, 2)],
      }),
    });
    expect(
      (await search(lib, 'migration', { meetingIds: [wanted.toUpperCase()] })).hits.map(
        (h) => h.text
      )
    ).toEqual(['migration here']);
    await expect(search(lib, 'migration', { meetingIds: ['banana'] })).rejects.toThrow(
      "'banana' is not a valid meeting id"
    );
  });

  it('a date range narrows which meetings are scanned, and hits arrive newest first', async () => {
    const lib = new FakeLibrary();
    for (const day of [1, 3, 2, 5]) {
      lib.meeting({
        title: `Day ${day}`,
        day,
        transcript: transcript({
          speakers: [speaker(mic, 'Room 1')],
          utterances: [utterance(`migration on day ${day}`, mic, 0, 2)],
        }),
      });
    }
    const ranged = await search(lib, 'migration', { from: 4 * DAY_MS });
    expect(ranged.hits.map((h) => h.text)).toEqual(['migration on day 5']);
    expect(ranged.meetings_searched).toBe(1);
    expect((await search(lib, 'migration')).hits.map((h) => h.title)).toEqual([
      'Day 5',
      'Day 3',
      'Day 2',
      'Day 1',
    ]);
  });

  it('a limit stops the scan and says it was cut by the window', async () => {
    const lib = new FakeLibrary();
    meetingOfMatchingLines(lib, 'Many', 1, 10);
    const payload = await search(lib, 'migration', { limit: 3 });
    expect(payload.hits).toHaveLength(3);
    expect(payload.truncated).toBe(true);
    expect(payload.truncation_reason).toBe('end_of_window');
  });

  it('a query that matches nothing is an empty result, not an error', async () => {
    const lib = new FakeLibrary();
    lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('hello', mic, 0, 2)],
      }),
    });
    const payload = await search(lib, 'aardvark');
    expect(payload.hits).toEqual([]);
    expect(payload.truncated).toBe(false);
    expect(payload.meetings_searched).toBe(1);
    expect(encodePayload(payload)).not.toContain('truncation_reason');
  });

  it('a hit can be followed straight into the transcript', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Retro',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [
          utterance('line zero', mic, 0, 1),
          utterance('line one', mic, 1, 2),
          utterance('line two', mic, 2, 3),
          utterance('the migration ships Friday', mic, 3, 4),
          utterance('line four', mic, 4, 5),
        ],
      }),
    });
    const hit = (await search(lib, 'migration')).hits[0]!;
    expect(hit.utterance_index).toBe(3);
    const followed = await new Queries(lib.reader()).getTranscript({
      id,
      offset: hit.utterance_index,
      limit: 1,
      detail: 'text',
      includeTokens: false,
    });
    expect(followed.utterances[0]!.text).toBe(hit.text);
  });

  it('context is clamped so one hit cannot flood the response', async () => {
    const lib = new FakeLibrary();
    const filler = 'x'.repeat(200);
    lib.meeting({
      title: 'Long',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: Array.from({ length: 200 }, (_, i) =>
          utterance(i === 100 ? 'the migration ships Friday' : filler, mic, i, i + 1)
        ),
      }),
    });
    const payload = await search(lib, 'migration', { contextLines: 400, limit: 5 });
    expect(payload.hits[0]!.context_before).toHaveLength(MAX_CONTEXT_LINES);
    expect(payload.hits[0]!.context_after).toHaveLength(MAX_CONTEXT_LINES);
    expect(Buffer.byteLength(encodePayload(payload))).toBeLessThanOrEqual(MAX_CHARACTERS);
  });

  it('a search cut short by the limit resumes where it stopped', async () => {
    const lib = new FakeLibrary();
    meetingOfMatchingLines(lib, 'Older', 1, 3);
    meetingOfMatchingLines(lib, 'Newer', 2, 4);
    const whole = await search(lib, 'migration');
    expect(whole.hits).toHaveLength(7);
    expect(whole.truncated).toBe(false);
    expect(whole.next_cursor).toBeUndefined();

    const paged = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await search(lib, 'migration', { limit: 2, cursor });
      expect(page.hits.length).toBeLessThanOrEqual(2);
      paged.push(...page.hits);
      cursor = page.next_cursor;
      expect(page.truncated).toBe(cursor !== undefined);
      pages += 1;
    } while (cursor !== undefined && pages < 10);
    expect(paged).toEqual(whole.hits);
  });

  it('a search cut short by the budget resumes where it stopped', async () => {
    const lib = new FakeLibrary();
    meetingOfMatchingLines(lib, 'Long', 1, 40, 1_000);
    const first = await search(lib, 'migration', { contextLines: 0, limit: 40 });
    expect(first.truncated).toBe(true);
    expect(first.hits.length).toBeLessThan(40);
    expect(first.truncation_reason).toBe('response_size_budget');
    const second = await search(lib, 'migration', {
      contextLines: 0,
      limit: 40,
      cursor: first.next_cursor,
    });
    expect(second.hits[0]!.utterance_index).toBe(
      first.hits[first.hits.length - 1]!.utterance_index + 1
    );

    const paged: number[] = [];
    let cursor: string | undefined;
    let pages = 0;
    do {
      const page = await search(lib, 'migration', { contextLines: 0, limit: 40, cursor });
      paged.push(...page.hits.map((h) => h.utterance_index));
      cursor = page.next_cursor;
      pages += 1;
    } while (cursor !== undefined && pages < 20);
    expect(paged).toEqual(Array.from({ length: 40 }, (_, i) => i));
  });

  it('finds every misheard form of evals and quotes what matched', async () => {
    const lib = new FakeLibrary();
    meetingOfMangledLines(lib);
    const payload = await search(lib, 'evals');
    expect(payload.hits).toHaveLength(3);
    expect(payload.hits.every((h) => h.match_type === 'fuzzy')).toBe(true);
    expect(payload.hits.map((h) => h.matched_text)).toEqual(['evalves', 'evils', 'emails']);
  });

  it('finds a name heard as two words, and a company name spelled another way', async () => {
    const lib = new FakeLibrary();
    meetingOfMangledLines(lib);
    const qlora = await search(lib, 'QLoRA');
    expect(qlora.hits.map((h) => h.text)).toEqual(['we fine tuned with cue lura yesterday']);
    expect(qlora.hits[0]).toMatchObject({ match_type: 'fuzzy', matched_text: 'cue lura' });
    const halcyon = await search(lib, 'Halcyon');
    expect(halcyon.hits.map((h) => h.text)).toEqual(['Halcion signed the contract']);
    expect(halcyon.hits[0]!.matched_text).toBe('Halcion');
  });

  it('an exact or partial-word hit is marked exact and quotes nothing', async () => {
    const lib = new FakeLibrary();
    lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [
          utterance('the evals finished', mic, 0, 2),
          utterance('the migration ships', mic, 2, 4),
        ],
      }),
    });
    for (const q of ['evals', 'migrat']) {
      const hit = (await search(lib, q)).hits[0]!;
      expect(hit.match_type).toBe('exact');
      expect(hit.matched_text).toBeUndefined();
    }
  });

  it('literal is the old substring behaviour and carries no marking', async () => {
    const lib = new FakeLibrary();
    meetingOfMangledLines(lib);
    expect((await search(lib, 'evals', { match: 'literal' })).hits).toEqual([]);
    const hits = (await search(lib, 'evalve', { match: 'literal' })).hits;
    expect(hits).toHaveLength(1);
    expect(hits[0]!.match_type).toBeUndefined();
    expect(encodePayload(hits[0])).not.toContain('match_type');
  });

  it('a fuzzy search pages with nothing repeated and nothing lost', async () => {
    const lib = new FakeLibrary();
    meetingOfMangledLines(lib);
    const whole = await search(lib, 'evals');
    const paged = [];
    let cursor: string | undefined;
    do {
      const page = await search(lib, 'evals', { limit: 1, cursor });
      paged.push(...page.hits);
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    expect(paged).toEqual(whole.hits);
  });

  it('an unreadable cursor restarts the scan, as the stdio server does', async () => {
    const lib = new FakeLibrary();
    meetingOfMatchingLines(lib, 'Many', 1, 3);
    expect((await search(lib, 'migration', { cursor: 'garbage' })).hits).toHaveLength(3);
  });

  it('a meeting id that is unknown simply matches nothing', async () => {
    const lib = new FakeLibrary();
    meetingOfMatchingLines(lib, 'Many', 1, 3);
    expect((await search(lib, 'migration', { meetingIds: [randomUUID()] })).hits).toEqual([]);
  });
});
