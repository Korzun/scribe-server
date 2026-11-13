import { describe, expect, it } from 'vitest';

import { encodePayload } from './budget';
import { containerIndex, Queries, utterancePayload, type Detail } from './queries';
import { ResolvedTranscript } from './resolved';
import {
  FakeLibrary,
  Labels,
  ref,
  speaker,
  transcript,
  utterance,
  voiceprint,
} from './test-fixture';

const mic = ref('microphone', '0');
const remote = ref('system', '1');

const get = (
  lib: FakeLibrary,
  id: string,
  input: {
    startTime?: number;
    endTime?: number;
    offset?: number;
    limit?: number;
    minDurationSeconds?: number;
    detail?: Detail;
    includeTokens?: boolean;
  } = {}
) =>
  new Queries(lib.reader()).getTranscript({
    id,
    ...input,
    detail: input.detail ?? 'text',
    includeTokens: input.includeTokens ?? false,
  });

/** Ten one-second utterances, alternating speakers, starting at t=0. */
const tenLines = (lib: FakeLibrary) =>
  lib.meeting({
    title: 'Ten lines',
    day: 1,
    transcript: transcript({
      speakers: [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
      utterances: Array.from({ length: 10 }, (_, i) =>
        utterance(`line ${i}`, i % 2 === 0 ? mic : remote, i, i + 1)
      ),
    }),
  });

/** Long turns at even indices, half-second backchannels at odd ones. */
const backchannels = (lib: FakeLibrary) =>
  lib.meeting({
    title: 'Backchannels',
    day: 1,
    transcript: transcript({
      speakers: [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
      utterances: Array.from({ length: 10 }, (_, i) =>
        i % 2 === 0
          ? utterance(`turn ${i}`, mic, i * 3, i * 3 + 2)
          : utterance('yeah', remote, i * 3, i * 3 + 0.5)
      ),
    }),
  });

/** One long turn, with backchannels and an interjection inside it. */
const interrupted = (lib: FakeLibrary) => {
  const a = ref('microphone', '0');
  const b = ref('system', '1');
  const c = ref('microphone', '2');
  return lib.meeting({
    title: 'Interrupted',
    day: 1,
    duration: 120,
    transcript: transcript({
      speakers: [speaker(a, 'Room 1'), speaker(b, 'Remote 1'), speaker(c, 'Room 2')],
      utterances: [
        utterance('the long turn', a, 0, 100),
        utterance('mm-hmm', b, 10, 12),
        utterance('wait, one question', b, 40, 60),
        utterance('good question', c, 45, 50),
        utterance('as I was saying', a, 95, 99),
        utterance('thanks, bye', b, 99, 105),
      ],
    }),
  });
};

describe('get_transcript', () => {
  it('a whole transcript comes back when it fits, with no truncation reason', async () => {
    const lib = new FakeLibrary();
    const payload = await get(lib, tenLines(lib));
    expect(payload.utterances).toHaveLength(10);
    expect(payload.total_utterances).toBe(10);
    expect(payload.truncated).toBe(false);
    expect(payload.title).toBe('Ten lines');
    expect(payload.started_at).toBe('1970-01-02T00:00:00Z');
    expect(encodePayload(payload)).not.toContain('truncation_reason');
  });

  it('an offset window starts where it was asked and says the window ended', async () => {
    const lib = new FakeLibrary();
    const payload = await get(lib, tenLines(lib), { offset: 4, limit: 3 });
    expect(payload.utterances.map((u) => u.text)).toEqual(['line 4', 'line 5', 'line 6']);
    expect(payload.utterances.map((u) => u.index)).toEqual([4, 5, 6]);
    expect(payload.next_offset).toBe(7);
    expect(payload.truncated).toBe(true);
    expect(payload.truncation_reason).toBe('end_of_window');
  });

  it('the last window reports no next offset; past the end is empty, not an error', async () => {
    const lib = new FakeLibrary();
    const id = tenLines(lib);
    const last = await get(lib, id, { offset: 8, limit: 5 });
    expect(last.utterances.map((u) => u.text)).toEqual(['line 8', 'line 9']);
    expect(last.next_offset).toBeUndefined();
    expect(last.truncated).toBe(false);
    const past = await get(lib, id, { offset: 99 });
    expect(past.utterances).toEqual([]);
    expect(past.total_utterances).toBe(10);
  });

  it('a time window keeps anything that overlaps it and keeps whole-transcript indices', async () => {
    const lib = new FakeLibrary();
    const id = tenLines(lib);
    expect(
      (await get(lib, id, { startTime: 3.5, endTime: 5.5 })).utterances.map((u) => u.text)
    ).toEqual(['line 3', 'line 4', 'line 5']);
    expect((await get(lib, id, { startTime: 8 })).utterances.map((u) => u.text)).toEqual([
      'line 8',
      'line 9',
    ]);
    expect(
      (await get(lib, id, { startTime: 7, endTime: 8.5 })).utterances.map((u) => u.index)
    ).toEqual([7, 8]);
  });

  it('refuses both window forms at once, and reads an unprocessed meeting as empty', async () => {
    const lib = new FakeLibrary();
    await expect(get(lib, tenLines(lib), { startTime: 1, offset: 2 })).rejects.toThrow(
      'Supply either start_time/end_time or offset/limit, not both.'
    );
    const empty = await get(lib, lib.meeting({ title: 'In progress', day: 1 }));
    expect(empty.utterances).toEqual([]);
    expect(empty.total_utterances).toBe(0);
    expect(empty.truncated).toBe(false);
  });

  it('bleed suspicion reaches the transcript from the manifest, only at full detail, only on the mic', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Echoing room',
      day: 1,
      bleedWindows: [{ start: 3.0, coefficient: 0.9, lag: 0.05 }],
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1'), speaker(remote, 'Remote 1')],
        utterances: [
          utterance('So sound good? Yeah. I love that.', mic, 0, 5),
          utterance('Yeah. I love that.', remote, 3, 4),
          utterance('moving on', mic, 10, 12),
        ],
      }),
    });
    const full = await get(lib, id, { detail: 'full' });
    expect(full.utterances[0]!.bleed_suspected).toBe(true);
    expect(full.utterances[1]!.bleed_suspected).toBeUndefined();
    expect(full.utterances[2]!.bleed_suspected).toBeUndefined();
    const json = encodePayload(full);
    expect(json).toContain('"bleed_suspected":true');
    expect(json).not.toContain('bleed_suspected":false');
    expect((await get(lib, id)).utterances[0]!.bleed_suspected).toBeUndefined();
  });

  it('the duration filter drops short lines without renumbering, and says how many', async () => {
    const lib = new FakeLibrary();
    const id = backchannels(lib);
    const payload = await get(lib, id, { minDurationSeconds: 1.0 });
    expect(payload.utterances.map((u) => u.index)).toEqual([0, 2, 4, 6, 8]);
    expect(payload.utterances_filtered_out).toBe(5);
    expect(payload.total_utterances).toBe(10);

    const harmless = await get(lib, id, { minDurationSeconds: 0.1 });
    expect(harmless.utterances).toHaveLength(10);
    expect(encodePayload(harmless)).not.toContain('utterances_filtered_out');
  });

  it('the duration filter narrows a time window rather than conflicting with it', async () => {
    const lib = new FakeLibrary();
    const payload = await get(lib, backchannels(lib), {
      startTime: 2.5,
      endTime: 9.2,
      minDurationSeconds: 1.0,
    });
    expect(payload.utterances.map((u) => u.index)).toEqual([2]);
    expect(payload.utterances_filtered_out).toBe(2);
  });

  it('the duration filter thins an offset window without moving its end', async () => {
    const lib = new FakeLibrary();
    const id = backchannels(lib);
    const payload = await get(lib, id, { offset: 1, limit: 4, minDurationSeconds: 1.0 });
    expect(payload.utterances.map((u) => u.index)).toEqual([2, 4]);
    expect(payload.utterances_filtered_out).toBe(2);
    expect(payload.truncated).toBe(true);
    expect(payload.next_offset).toBe(5);

    const emptied = await get(lib, id, { offset: 1, limit: 1, minDurationSeconds: 1.0 });
    expect(emptied.utterances).toEqual([]);
    expect(emptied.utterances_filtered_out).toBe(1);
    expect(emptied.truncated).toBe(true);
    expect(emptied.next_offset).toBe(2);
  });

  it('pagination with the duration filter walks the whole transcript', async () => {
    const lib = new FakeLibrary();
    const id = backchannels(lib);
    const texts: string[] = [];
    let offset: number | undefined;
    let pages = 0;
    do {
      const page = await get(lib, id, { offset, limit: 3, minDurationSeconds: 1.0 });
      texts.push(...page.utterances.map((u) => u.text));
      offset = page.next_offset;
      pages += 1;
    } while (offset !== undefined && pages < 10);
    expect(pages).toBeLessThan(10);
    expect(texts).toEqual(['turn 0', 'turn 2', 'turn 4', 'turn 6', 'turn 8']);
  });

  it("a line inside another speaker's turn says which turn, the outermost wins, and a speaker's own turn never counts", async () => {
    const lib = new FakeLibrary();
    const id = interrupted(lib);
    const full = await get(lib, id, { detail: 'full' });
    expect(full.utterances.map((u) => u.during_utterance_index)).toEqual([
      undefined,
      0,
      0,
      0,
      undefined,
      undefined,
    ]);
    const paged = await get(lib, id, { offset: 3, limit: 1, detail: 'full' });
    expect(paged.utterances[0]!.during_utterance_index).toBe(0);
    const text = await get(lib, id);
    expect(text.utterances.every((u) => u.during_utterance_index === undefined)).toBe(true);
    const json = encodePayload(full);
    expect(json).toContain('"during_utterance_index":0');
    expect(json).not.toContain('during_utterance_index":null');
  });

  it('a transcript too large for one result is cut, resumable, and names the budget', async () => {
    const lib = new FakeLibrary();
    const id = lib.meeting({
      title: 'Long',
      day: 1,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: Array.from({ length: 400 }, (_, i) =>
          utterance(`${'word '.repeat(30)}${i}`, mic, i, i + 1)
        ),
      }),
    });
    const payload = await get(lib, id);
    expect(payload.truncated).toBe(true);
    expect(payload.total_utterances).toBe(400);
    expect(payload.utterances.length).toBeLessThan(400);
    expect(payload.truncation_reason).toBe('response_size_budget');
    expect(payload.next_offset).toBe(payload.utterances.length);
    expect((await get(lib, id, { offset: payload.next_offset })).utterances[0]!.index).toBe(
      payload.next_offset
    );
    // Both reasons hold at once; the budget outranks the limit.
    expect((await get(lib, id, { limit: 399 })).truncation_reason).toBe('response_size_budget');
  });
});

describe('utterancePayload', () => {
  const build = (
    u: ReturnType<typeof utterance>,
    resolved: ResolvedTranscript,
    detail: Detail,
    extra: {
      includeTokens?: boolean;
      bleed?: { start: number; coefficient: number; lag: number }[];
    } = {}
  ) =>
    utterancePayload(u, 0, resolved, {
      detail,
      includeTokens: extra.includeTokens ?? false,
      bleed: extra.bleed ?? [],
      duringUtteranceIndex: undefined,
    });

  it('text detail carries nothing a machine would want', () => {
    const resolved = new ResolvedTranscript(
      transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('hello', mic, 0, 2)],
      }),
      null
    );
    const payload = build(resolved.transcript.utterances[0]!, resolved, 'text');
    expect(payload).toEqual({
      index: 0,
      timestamp: '00:00:00',
      start_seconds: 0,
      end_seconds: 2,
      speaker: 'Room 1',
      text: 'hello',
    });
  });

  it('full detail says whether someone was in the room or on the call, and where the name came from', () => {
    const resolved = new ResolvedTranscript(
      transcript({
        speakers: [speaker(remote, 'Remote 1')],
        utterances: [
          utterance('hi', remote, 3661, 3663, {
            speakerConfidence: 0.42,
            textConfidence: 0.7,
            overlapped: true,
          }),
        ],
      }),
      null
    );
    const payload = build(resolved.transcript.utterances[0]!, resolved, 'full');
    expect(payload).toMatchObject({
      stream: 'system',
      cluster_id: '1',
      speaker_confidence: 0.42,
      text_confidence: 0.7,
      overlapped: true,
      label_origin: 'generated',
      enrolled_voice_id: null,
      timestamp: '01:01:01',
    });
  });

  it('a typed name, a voiceprint match and an inferred name are three different facts', () => {
    const t = transcript({
      speakers: [speaker(mic, 'Room 1')],
      utterances: [utterance('hello', mic, 0, 2)],
    });
    const typed = new ResolvedTranscript(t, new Labels().set('Dana', mic).file);
    expect(build(typed.transcript.utterances[0]!, typed, 'full')).toMatchObject({
      speaker: 'Dana',
      label_origin: 'human',
      enrolled_voice_id: null,
    });
    const matched = new ResolvedTranscript(
      t,
      new Labels().set('Dana', mic, voiceprint('voice-7')).file
    );
    expect(build(matched.transcript.utterances[0]!, matched, 'full')).toMatchObject({
      label_origin: 'voiceprint',
      enrolled_voice_id: 'voice-7',
    });
    const heard = new ResolvedTranscript(
      t,
      new Labels().set('Dominique', mic, { inferred: {} }).file
    );
    expect(build(heard.transcript.utterances[0]!, heard, 'full')).toMatchObject({
      speaker: 'Dominique',
      label_origin: 'inferred',
      enrolled_voice_id: null,
    });
    // A file written before origins existed holds names a person typed.
    const legacy = new ResolvedTranscript(t, { entries: [{ ref: mic, name: 'Dana' }] });
    expect(build(legacy.transcript.utterances[0]!, legacy, 'full').label_origin).toBe('human');
  });

  it('speech nobody can attribute is still speech that happened', () => {
    const nobody = ref('microphone', null);
    const resolved = new ResolvedTranscript(
      transcript({ speakers: [], utterances: [utterance('mumble', nobody, 0, 1)] }),
      null
    );
    expect(build(resolved.transcript.utterances[0]!, resolved, 'full')).toMatchObject({
      speaker: 'Unknown',
      cluster_id: null,
      text: 'mumble',
    });
  });

  it('tokens are absent unless asked for, and carry no confidence key when the recognizer gave none', () => {
    const resolved = new ResolvedTranscript(
      transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [
          utterance('hello', mic, 0, 1, {
            tokens: [
              { text: 'hello', start: 0, end: 1, confidence: 0.9 },
              { text: 'there', start: 1, end: 2 },
            ],
          }),
        ],
      }),
      null
    );
    const u = resolved.transcript.utterances[0]!;
    expect(build(u, resolved, 'full').tokens).toBeUndefined();
    const withTokens = build(u, resolved, 'full', { includeTokens: true });
    expect(withTokens.tokens).toEqual([
      { text: 'hello', start_seconds: 0, end_seconds: 1, confidence: 0.9 },
      { text: 'there', start_seconds: 1, end_seconds: 2 },
    ]);
    expect(encodePayload(withTokens)).not.toContain('"confidence":null');
  });
});

describe('containerIndex', () => {
  it('finds the outermost other-speaker turn a line fell entirely inside', () => {
    const a = ref('microphone', '0');
    const b = ref('system', '1');
    const all = [
      utterance('the long turn', a, 0, 100),
      utterance('wait', b, 40, 60),
      utterance('good question', ref('microphone', '2'), 45, 50),
      utterance('as I was saying', a, 95, 99),
      utterance('bye', b, 99, 105),
    ];
    expect(containerIndex(all[0]!, all)).toBeUndefined();
    expect(containerIndex(all[1]!, all)).toBe(0);
    expect(containerIndex(all[2]!, all)).toBe(0);
    expect(containerIndex(all[3]!, all)).toBeUndefined();
    expect(containerIndex(all[4]!, all)).toBeUndefined();
  });
});
