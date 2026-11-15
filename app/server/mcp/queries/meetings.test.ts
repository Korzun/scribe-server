import { randomUUID } from 'crypto';

import { describe, expect, it } from 'vitest';

import { encodePayload, MAX_CHARACTERS } from './budget';
import { Queries } from './queries';
import {
  DAY_MS,
  FakeLibrary,
  Labels,
  ref,
  speaker,
  TEXT_LARGER_THAN_THE_BUDGET,
  transcript,
  utterance,
  voiceprint,
} from './test-fixture';

const list = (lib: FakeLibrary, input: Partial<Parameters<Queries['listMeetings']>[0]> = {}) =>
  new Queries(lib.reader()).listMeetings({ limit: 50, ...input });

const mic = ref('microphone', '0');
const remote = ref('system', '1');

/** Every row from the first page to no cursor, holding each page to the cut/uncut rule. */
async function walkPages<Row>(
  expecting: number,
  page: (cursor: string | undefined) => Promise<{ rows: Row[]; truncated: boolean; next?: string }>
): Promise<Row[]> {
  const seen: Row[] = [];
  let cursor: string | undefined;
  do {
    const p = await page(cursor);
    seen.push(...p.rows);
    expect(p.truncated).toBe(p.next !== undefined);
    if (p.next !== undefined && p.rows.length === 0)
      throw new Error('a page offered a cursor but no rows');
    if (seen.length > expecting) throw new Error('more rows came back than the corpus holds');
    cursor = p.next;
  } while (cursor !== undefined);
  return seen;
}

describe('list_meetings', () => {
  it('comes back newest first', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Old', day: 1 });
    lib.meeting({ title: 'New', day: 3 });
    lib.meeting({ title: 'Middle', day: 2 });
    expect((await list(lib)).meetings.map((m) => m.title)).toEqual(['New', 'Middle', 'Old']);
  });

  it('lists a meeting still recording as unprocessed rather than hiding it', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'In progress', day: 1 });
    const { meetings } = await list(lib);
    expect(meetings).toHaveLength(1);
    expect(meetings[0]).toMatchObject({ processed: false, utterance_count: 0, speaker_count: 0 });
    expect(meetings[0]!.ended_at).toBeDefined();
  });

  it('reports speakers and lines of a processed meeting', async () => {
    const lib = new FakeLibrary();
    lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
        utterances: [utterance('hello', mic, 0, 2), utterance('hi', remote, 2, 4)],
      }),
    });
    expect((await list(lib)).meetings[0]).toMatchObject({
      processed: true,
      speaker_count: 2,
      utterance_count: 2,
    });
  });

  it('excludes what falls outside a date range, and matches titles ignoring case', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'January', day: 1 });
    lib.meeting({ title: 'Design Review', day: 3 });
    lib.meeting({ title: 'May', day: 5 });
    expect(
      (await list(lib, { from: 2 * DAY_MS, to: 4 * DAY_MS })).meetings.map((m) => m.title)
    ).toEqual(['Design Review']);
    expect((await list(lib, { titleContains: 'design' })).meetings.map((m) => m.title)).toEqual([
      'Design Review',
    ]);
  });

  it('a limit reports a cursor that resumes without repeating', async () => {
    const lib = new FakeLibrary();
    for (let day = 1; day <= 5; day++) lib.meeting({ title: `Day ${day}`, day });
    const first = await list(lib, { limit: 2 });
    expect(first.meetings.map((m) => m.title)).toEqual(['Day 5', 'Day 4']);
    expect(first.truncated).toBe(true);
    expect(first.truncation_reason).toBe('end_of_window');
    const second = await list(lib, { limit: 2, cursor: first.next_cursor });
    expect(second.meetings.map((m) => m.title)).toEqual(['Day 3', 'Day 2']);
  });

  it('a meeting landing mid-scroll does not shift the next page', async () => {
    const lib = new FakeLibrary();
    for (let day = 1; day <= 4; day++) lib.meeting({ title: `Day ${day}`, day });
    const first = await list(lib, { limit: 2 });
    lib.meeting({ title: 'Day 5', day: 5 });
    const second = await list(lib, { limit: 2, cursor: first.next_cursor });
    expect(second.meetings.map((m) => m.title)).toEqual(['Day 2', 'Day 1']);
  });

  it('a cursor survives its own meeting being deleted', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Day 1', day: 1 });
    lib.meeting({ title: 'Day 2', day: 2 });
    const anchor = lib.meeting({ title: 'Day 3', day: 3 });
    lib.meeting({ title: 'Day 4', day: 4 });
    const first = await list(lib, { limit: 2 });
    expect(first.meetings.map((m) => m.title)).toEqual(['Day 4', 'Day 3']);
    lib.remove(anchor);
    const second = await list(lib, { limit: 2, cursor: first.next_cursor });
    expect(second.meetings.map((m) => m.title)).toEqual(['Day 2', 'Day 1']);
  });

  it('meetings starting at the same moment page without repeating or skipping', async () => {
    const lib = new FakeLibrary();
    for (let n = 1; n <= 3; n++) lib.meeting({ title: `Sync ${n}`, day: 1 });
    const seen = await walkPages(3, async (cursor) => {
      const page = await list(lib, { limit: 1, cursor });
      return {
        rows: page.meetings.map((m) => m.title),
        truncated: page.truncated,
        next: page.next_cursor,
      };
    });
    expect(seen.sort()).toEqual(['Sync 1', 'Sync 2', 'Sync 3']);
  });

  it('refuses a cursor from somewhere else rather than reinterpreting it', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Day 1', day: 1 });
    await expect(list(lib, { cursor: '5' })).rejects.toThrow(
      "'5' is not a cursor from this listing"
    );
    await expect(list(lib, { cursor: 'abc#x' })).rejects.toThrow('not a cursor');
    await expect(list(lib, { cursor: '12#' })).rejects.toThrow('not a cursor');
  });

  it('a meeting too large for the budget is delivered with a way on', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Standup', day: 2 });
    lib.meeting({ title: TEXT_LARGER_THAN_THE_BUDGET, day: 1 });

    const first = await list(lib);
    expect(first.meetings.map((m) => m.title)).toEqual(['Standup']);
    expect(first.truncated).toBe(true);
    expect(first.truncation_reason).toBe('response_size_budget');

    const second = await list(lib, { cursor: first.next_cursor });
    expect(second.meetings[0]!.title).toBe(TEXT_LARGER_THAN_THE_BUDGET);
    expect(encodePayload(second.meetings[0]).length).toBeGreaterThan(MAX_CHARACTERS);
    expect(second.truncated).toBe(true);
    expect(second.next_cursor).toBeDefined();

    const third = await list(lib, { cursor: second.next_cursor });
    expect(third.meetings).toEqual([]);
    expect(third.truncated).toBe(false);
    expect(third.next_cursor).toBeUndefined();
    expect(third.truncation_reason).toBeUndefined();
  });

  it('paging through the list loses nothing and repeats nothing', async () => {
    const lib = new FakeLibrary();
    const count = 40;
    const padding = '-'.repeat(2_000);
    for (let day = 1; day <= count; day++) lib.meeting({ title: `Meeting ${day} ${padding}`, day });
    lib.meeting({ title: TEXT_LARGER_THAN_THE_BUDGET, day: 0 });

    const first = await list(lib);
    expect(first.truncated).toBe(true);
    expect(first.meetings.length).toBeLessThan(count);

    const seen = await walkPages(count + 1, async (cursor) => {
      const page = await list(lib, { cursor });
      return {
        rows: page.meetings.map((m) => m.title),
        truncated: page.truncated,
        next: page.next_cursor,
      };
    });
    const expected = Array.from({ length: count }, (_, i) => `Meeting ${count - i} ${padding}`);
    expected.push(TEXT_LARGER_THAN_THE_BUDGET);
    expect(seen).toEqual(expected);
  });

  it('one unreadable manifest does not hide the corpus', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Good', day: 1 });
    lib.breakManifest(lib.meeting({ title: 'Broken', day: 2 }));
    expect((await list(lib)).meetings.map((m) => m.title)).toEqual(['Good']);
  });

  it('a fresh library lists nothing rather than failing', async () => {
    const page = await list(new FakeLibrary());
    expect(page.meetings).toEqual([]);
    expect(page.truncated).toBe(false);
  });

  it('spells its keys in snake case, dates as ISO 8601 seconds, and omits an absent end', async () => {
    const lib = new FakeLibrary();
    lib.meeting({ title: 'Standup', day: 1 });
    const json = encodePayload(await list(lib));
    expect(json).toContain('"meeting_id"');
    expect(json).toContain('"started_at":"1970-01-02T00:00:00Z"');
    expect(json).not.toContain('meetingID');
    expect(json).not.toContain('next_cursor');
  });
});

describe('get_meeting', () => {
  const get = (lib: FakeLibrary, id: string) => new Queries(lib.reader()).getMeeting(id);

  it('a malformed id says so, an unknown id is named', async () => {
    const lib = new FakeLibrary();
    await expect(get(lib, 'banana')).rejects.toThrow("'banana' is not a valid meeting id");
    const missing = randomUUID().toUpperCase();
    await expect(get(lib, missing)).rejects.toThrow(`No meeting with id ${missing}`);
  });

  it('accepts an uppercase id and answers with the canonical lowercase one', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({ title: 'Standup', day: 1 });
    expect((await get(lib, id.toUpperCase())).meeting_id).toBe(id);
  });

  it('the roster counts who spoke and for how long', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
        utterances: [
          utterance('a', mic, 0, 10),
          utterance('b', mic, 20, 25),
          utterance('c', remote, 30, 33),
        ],
      }),
      labels: new Labels().set('Dana', mic, voiceprint('voice-7')),
    });
    const detail = await get(lib, id);
    const dana = detail.speakers.find((s) => s.label === 'Dana')!;
    expect(dana).toMatchObject({
      utterance_count: 2,
      speaking_seconds: 15,
      stream: 'microphone',
      cluster_id: '0',
      label_origin: 'voiceprint',
      enrolled_voice_id: 'voice-7',
    });
    expect(Math.abs(dana.speaking_share - 15 / 18)).toBeLessThan(0.0001);
    const other = detail.speakers.find((s) => s.label === 'Remote 1')!;
    expect(Math.abs(other.speaking_share - 3 / 18)).toBeLessThan(0.0001);
    expect(other.enrolled_voice_id).toBeNull();
    expect(other.label_origin).toBe('generated');
    expect(encodePayload(detail)).toContain('"enrolled_voice_id":null');
  });

  it('carries calendar context when the manifest has it, and omits it otherwise', async () => {
    const lib = new FakeLibrary();
    const withCalendar = lib.meeting({
      title: 'Design Review',
      day: 1,
      titleOrigin: 'calendar',
      scheduledStart: DAY_MS,
      scheduledEnd: DAY_MS + 1_800_000,
      attendeeNames: ['Ana', 'Ben'],
    });
    const detail = await get(lib, withCalendar);
    expect(detail).toMatchObject({
      attendee_names: ['Ana', 'Ben'],
      scheduled_start: '1970-01-02T00:00:00Z',
      scheduled_end: '1970-01-02T00:30:00Z',
      title_origin: 'calendar',
    });
    expect(detail.attendee_kinds).toBeUndefined();

    const adHoc = await get(lib, lib.meeting({ title: 'Ad hoc', day: 1 }));
    const json = encodePayload(adHoc);
    for (const key of ['attendee_names', 'scheduled_start', 'scheduled_end', 'title_origin']) {
      expect(json).not.toContain(key);
    }
  });

  it('attendee kinds run parallel to the names, unknown ones as null', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Standup',
      day: 1,
      attendeeNames: ['Ana Okafor', 'Boardroom 4', 'louis.byrne@example.com'],
      attendeeKinds: ['person', 'room', null],
    });
    const detail = await get(lib, id);
    expect(detail.attendee_kinds).toEqual(['person', 'room', null]);
  });

  it('a legacy manifest admits its stream durations were never measured', async () => {
    const lib = new FakeLibrary();
    const legacy = await get(
      lib,
      lib.meeting({ title: 'Old', day: 1, duration: 600, legacyManifest: true })
    );
    expect(legacy.quality).toMatchObject({
      mic_duration: 600,
      system_duration: 600,
      stream_durations_measured: false,
    });
    const modern = await get(
      lib,
      lib.meeting({ title: 'New', day: 1, duration: 600, micDuration: 598, systemDuration: 412 })
    );
    expect(modern.quality).toMatchObject({
      mic_duration: 598,
      system_duration: 412,
      stream_durations_measured: true,
    });
  });

  it('summarises bleed and the share of weakly attributed lines', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Hard room',
      day: 1,
      bleedWindows: [
        { start: 0, coefficient: 0.3, lag: 0.01 },
        { start: 5, coefficient: 0.82, lag: 0.02 },
      ],
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [
          utterance('a', mic, 0, 1, { speakerConfidence: 0.9 }),
          utterance('b', mic, 1, 2, { speakerConfidence: 0.2 }),
          utterance('c', mic, 2, 3, { speakerConfidence: 0.1 }),
          utterance('d', mic, 3, 4, { speakerConfidence: 0.95 }),
          // Unattributed speech is neither weak nor strong.
          utterance('mumble', ref('microphone', null), 4, 5, { speakerConfidence: 0 }),
        ],
      }),
    });
    const detail = await get(lib, id);
    expect(detail.quality).toMatchObject({
      bleed_window_count: 2,
      peak_bleed_coefficient: 0.82,
      low_confidence_utterance_share: 0.5,
    });
  });

  it('an unprocessed meeting has no roster and no confidence share', async () => {
    const lib = new FakeLibrary();
    const detail = await get(lib, lib.meeting({ title: 'In progress', day: 1 }));
    expect(detail.processed).toBe(false);
    expect(detail.speakers).toEqual([]);
    expect(detail.quality.low_confidence_utterance_share).toBeUndefined();
    expect(detail.quality.peak_bleed_coefficient).toBeUndefined();
    expect(detail.device_identifier).toBe('Apple M3');
  });
});
