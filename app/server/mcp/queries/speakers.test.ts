import { describe, expect, it } from 'vitest';

import { encodePayload, MAX_CHARACTERS } from './budget';
import { MAX_APPEARANCES, Queries } from './queries';
import {
  DAY_MS,
  FakeLibrary,
  Labels,
  ref,
  speaker,
  suggesting,
  TEXT_LARGER_THAN_THE_BUDGET,
  transcript,
  utterance,
  voiceprint,
} from './test-fixture';

const mic = ref('microphone', '0');

const list = (
  lib: FakeLibrary,
  input: {
    voiceId?: string;
    nameContains?: string;
    from?: number;
    to?: number;
    cursor?: string;
  } = {}
) => new Queries(lib.reader()).listSpeakers(input);

/** A meeting in which `voice` speaks for `seconds`, enrolled under `name`. */
const meetingWith = (
  lib: FakeLibrary,
  title: string,
  day: number,
  name: string,
  voice: string,
  seconds: number,
  lines = 1
) => {
  const each = seconds / lines;
  return lib.meeting({
    title,
    day,
    transcript: transcript({
      speakers: [speaker(mic, 'Room 1')],
      utterances: Array.from({ length: lines }, (_, i) =>
        utterance(`line ${i}`, mic, i * each, i * each + each)
      ),
    }),
    labels: new Labels().set(name, mic, voiceprint(voice)),
  });
};

describe('list_speakers', () => {
  it('one enrolled voice in three meetings is one person', async () => {
    const lib = new FakeLibrary();
    meetingWith(lib, 'A', 1, 'Dana', 'v1', 10);
    meetingWith(lib, 'B', 2, 'Dana', 'v1', 20);
    meetingWith(lib, 'C', 3, 'Dana', 'v1', 30);
    const { people } = await list(lib);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({
      label: 'Dana',
      enrolled_voice_id: 'v1',
      meeting_count: 3,
      total_speaking_seconds: 60,
      first_seen: '1970-01-02T00:00:00Z',
      last_seen: '1970-01-04T00:00:00Z',
      appearances_truncated: false,
    });
    expect(people[0]!.appearances).toHaveLength(3);
    expect(people[0]!.appearances.map((a) => a.title)).toEqual(['C', 'B', 'A']);
  });

  it('two unenrolled Room 1s are not assumed to be the same person', async () => {
    const lib = new FakeLibrary();
    for (const day of [1, 2]) {
      lib.meeting({
        title: `Day ${day}`,
        day,
        transcript: transcript({
          speakers: [speaker(mic, 'Room 1')],
          utterances: [utterance('hello', mic, 0, 5)],
        }),
      });
    }
    const { people } = await list(lib);
    expect(people).toHaveLength(2);
    expect(people.every((p) => p.enrolled_voice_id === null && p.meeting_count === 1)).toBe(true);
    expect(encodePayload(people[0])).toContain('"enrolled_voice_id":null');
  });

  it('filters by voice, by name ignoring case, and by date', async () => {
    const lib = new FakeLibrary();
    meetingWith(lib, 'A', 1, 'Dana', 'v1', 10);
    meetingWith(lib, 'B', 5, 'Dana', 'v1', 20);
    meetingWith(lib, 'C', 2, 'Sam', 'v2', 20);
    expect((await list(lib, { voiceId: 'v2' })).people.map((p) => p.label)).toEqual(['Sam']);
    expect((await list(lib, { nameContains: 'dana' })).people.map((p) => p.label)).toEqual([
      'Dana',
    ]);
    const ranged = await list(lib, { from: 4 * DAY_MS });
    expect(ranged.people[0]).toMatchObject({
      label: 'Dana',
      meeting_count: 1,
      total_speaking_seconds: 20,
    });
  });

  it('orders people by how much they talked, and lists nobody for an unprocessed corpus', async () => {
    const lib = new FakeLibrary();
    meetingWith(lib, 'A', 1, 'Quiet', 'v1', 5);
    meetingWith(lib, 'B', 2, 'Loud', 'v2', 500);
    expect((await list(lib)).people.map((p) => p.label)).toEqual(['Loud', 'Quiet']);
    const empty = new FakeLibrary();
    empty.meeting({ title: 'In progress', day: 1 });
    expect((await list(empty)).people).toEqual([]);
  });

  it('a renamed voice reports the name it was last given', async () => {
    const lib = new FakeLibrary();
    lib.meeting({
      title: 'Earlier',
      day: 1,
      transcript: transcript({
        id: '00000000-0000-0000-0000-000000000001',
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('hello', mic, 0, 5)],
      }),
      labels: new Labels().set('Dana Old', mic, voiceprint('v1')),
    });
    lib.meeting({
      title: 'Later',
      day: 5,
      transcript: transcript({
        id: 'ffffffff-ffff-ffff-ffff-ffffffffffff',
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('hello', mic, 0, 5)],
      }),
      labels: new Labels().set('Dana New', mic, voiceprint('v1')),
    });
    const { people } = await list(lib);
    expect(people).toHaveLength(1);
    expect(people[0]!.label).toBe('Dana New');
  });

  it('one voice on two clusters in a meeting is one meeting', async () => {
    const lib = new FakeLibrary();
    const first = ref('microphone', '0');
    const second = ref('microphone', '1');
    lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(first, 'Room 1'), speaker(second, 'Room 2')],
        utterances: [utterance('morning', first, 0, 4), utterance('all', second, 4, 10)],
      }),
      labels: new Labels()
        .set('Dana', first, voiceprint('v1'))
        .set('Dana', second, voiceprint('v1')),
    });
    const { people } = await list(lib);
    expect(people).toHaveLength(1);
    expect(people[0]).toMatchObject({ meeting_count: 1, total_speaking_seconds: 10 });
    expect(people[0]!.appearances).toHaveLength(1);
    expect(people[0]!.appearances[0]).toMatchObject({ speaking_seconds: 10, utterance_count: 2 });
  });

  it('a person in many meetings carries their most recent ones and says so', async () => {
    const lib = new FakeLibrary();
    for (let day = 1; day <= 30; day++) meetingWith(lib, `Day ${day}`, day, 'Dana', 'v1', 10);
    const dana = (await list(lib)).people[0]!;
    expect(dana.appearances).toHaveLength(MAX_APPEARANCES);
    expect(dana.appearances_truncated).toBe(true);
    expect(dana.meeting_count).toBe(30);
    expect(dana.total_speaking_seconds).toBe(300);
    expect(dana.first_seen).toBe('1970-01-02T00:00:00Z');
    expect(dana.last_seen).toBe('1970-01-31T00:00:00Z');
    expect(dana.appearances[0]!.title).toBe('Day 30');
    expect(dana.appearances[dana.appearances.length - 1]!.title).toBe('Day 11');
  });

  it('an empty filtered list explains that absence is not proof; an unfiltered or matching one carries no note', async () => {
    const lib = new FakeLibrary();
    const remote = ref('system', '1');
    lib.meeting({
      title: 'Standup',
      day: 1,
      transcript: transcript({
        speakers: [speaker(remote, 'Remote 1')],
        utterances: [utterance('hello', remote, 0, 2)],
      }),
    });
    const byName = await list(lib, { nameContains: 'Priya' });
    expect(byName.people).toEqual([]);
    expect(byName.note).toContain('search_transcripts');
    expect(byName.note).toContain('inferred');
    expect((await list(lib, { voiceId: 'v-unknown' })).note).toBeDefined();

    const empty = new FakeLibrary();
    empty.meeting({ title: 'In progress', day: 1 });
    expect((await list(empty)).note).toBeUndefined();

    meetingWith(lib, 'A', 2, 'Dana', 'v1', 10);
    const matching = await list(lib, { nameContains: 'Dana' });
    expect(matching.people.map((p) => p.label)).toEqual(['Dana']);
    expect(encodePayload(matching)).not.toContain('"note"');
  });

  it('paging through the speaker list loses nobody and repeats nobody', async () => {
    const lib = new FakeLibrary();
    const count = 120;
    for (let person = 1; person <= count; person++) {
      meetingWith(lib, `Meeting ${person}`, person, `Person ${person}`, `v${person}`, person);
    }
    meetingWith(lib, 'Last', count + 1, TEXT_LARGER_THAN_THE_BUDGET, 'v-last', 0.5);

    const first = await list(lib);
    expect(first.truncated).toBe(true);
    expect(first.people.length).toBeLessThan(count);

    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await list(lib, { cursor });
      expect(page.truncated).toBe(page.next_cursor !== undefined);
      if (page.next_cursor !== undefined && page.people.length === 0)
        throw new Error('cursor but no rows');
      seen.push(...page.people.map((p) => p.label));
      cursor = page.next_cursor;
    } while (cursor !== undefined);
    const expected = Array.from({ length: count }, (_, i) => `Person ${count - i}`);
    expected.push(TEXT_LARGER_THAN_THE_BUDGET);
    expect(seen).toEqual(expected);
  });

  it('a person too large for the budget is delivered with a way on', async () => {
    const lib = new FakeLibrary();
    meetingWith(lib, 'A', 1, 'Dana', 'v1', 10);
    meetingWith(lib, 'B', 2, TEXT_LARGER_THAN_THE_BUDGET, 'v2', 1);
    const first = await list(lib);
    expect(first.people.map((p) => p.label)).toEqual(['Dana']);
    expect(first.truncated).toBe(true);
    const second = await list(lib, { cursor: first.next_cursor });
    expect(second.people[0]!.label).toBe(TEXT_LARGER_THAN_THE_BUDGET);
    expect(encodePayload(second.people[0]).length).toBeGreaterThan(MAX_CHARACTERS);
    expect(second.truncated).toBe(true);
    expect(second.truncation_reason).toBe('response_size_budget');
    const third = await list(lib, { cursor: second.next_cursor });
    expect(third.people).toEqual([]);
    expect(third.truncated).toBe(false);
    expect(third.next_cursor).toBeUndefined();
  });

  describe('inferred names', () => {
    const remote = ref('system', '0');
    const meetingWithInference = (
      lib: FakeLibrary,
      inferences: ReturnType<typeof suggesting>[],
      options: { labels?: Labels; remoteLabel?: string } = {}
    ) => {
      const id = lib.meeting({
        title: 'Intro round',
        day: 1,
        transcript: transcript({
          speakers: [speaker(mic, 'Room 1'), speaker(remote, options.remoteLabel ?? 'Remote 1')],
          utterances: [
            utterance('Go ahead.', mic, 0, 3),
            utterance('Hi, my name is Dominique.', remote, 20, 22),
          ],
        }),
        labels: options.labels,
      });
      lib.saveInferences(id, inferences);
      return id;
    };

    it('an unenrolled speaker is findable by the name the conversation offered', async () => {
      const lib = new FakeLibrary();
      meetingWithInference(lib, [suggesting('Dominique', remote)]);
      const payload = await list(lib, { nameContains: 'Dominique' });
      expect(payload.people).toHaveLength(1);
      expect(payload.people[0]).toMatchObject({
        label: 'Remote 1',
        suggested_name: 'Dominique',
        tier: 'weak',
        enrolled_voice_id: null,
      });
      expect(payload.note).toBeUndefined();
    });

    it('an applied inferred name is found because it is the label', async () => {
      const lib = new FakeLibrary();
      meetingWithInference(lib, [], {
        labels: new Labels().set('Dominique', remote, { inferred: {} }),
        remoteLabel: 'Dominique',
      });
      expect((await list(lib, { nameContains: 'dominique' })).people.map((p) => p.label)).toEqual([
        'Dominique',
      ]);
    });

    it('a speaker with nothing suggested carries neither key', async () => {
      const lib = new FakeLibrary();
      meetingWithInference(lib, []);
      const payload = await list(lib);
      const json = encodePayload(payload);
      expect(json).not.toContain('suggested_name');
      expect(json).not.toContain('tier');
    });

    it('a dismissed name is not findable, and the strongest earliest suggestion wins', async () => {
      const lib = new FakeLibrary();
      const id = meetingWithInference(lib, [
        { ...suggesting('Dominique', remote), status: 'dismissed', evidence: [] },
        suggesting('Dom', remote, { tier: 'weak', index: 1 }),
        suggesting('Dominik', remote, { tier: 'strong', index: 1 }),
      ]);
      expect((await list(lib, { nameContains: 'Dominique' })).people).toEqual([]);
      expect((await list(lib)).people.find((p) => p.label === 'Remote 1')).toMatchObject({
        suggested_name: 'Dominik',
        tier: 'strong',
      });
      const meeting = await new Queries(lib.reader()).getMeeting(id);
      const names = meeting.speakers
        .find((s) => s.stream === 'system')!
        .suggestions!.map((s) => s.name);
      expect(names).toEqual(['Dom', 'Dominik']);
    });
  });
});
