import { describe, expect, it } from 'vitest';

import { STARTER_TAG_LIST } from '../artifacts';
import { encodePayload, fit, MAX_CHARACTERS } from './budget';
import { editDistance, FuzzyQuery, FuzzyUtterance, phoneticKey, tokenize } from './fuzzy';
import { Queries } from './queries';
import { fingerprint, isBled } from './resolved';
import { FakeLibrary, Labels, ref, speaker, transcript, utterance } from './test-fixture';
import { includesCI, isoSeconds, timestamp } from './text';

const mic = ref('microphone', '0');

describe('ResponseBudget', () => {
  type Chunk = { text: string };
  const chunks = (n: number, size: number): Chunk[] =>
    Array.from({ length: n }, () => ({ text: 'x'.repeat(size) }));

  it('a result that fits is not truncated', () => {
    const items = Array.from({ length: 5 }, (_, i) => ({ text: `line ${i}` }));
    expect(fit(items, 0)).toEqual({ kept: items, truncated: false });
  });

  it('a result too large is cut, says so, and what survives fits under the cap', () => {
    const { kept, truncated } = fit(chunks(30, 1_000), 0);
    expect(truncated).toBe(true);
    expect(kept.length).toBeLessThan(30);
    expect(kept.length).toBeGreaterThan(0);
    expect(Buffer.byteLength(encodePayload(kept))).toBeLessThanOrEqual(MAX_CHARACTERS);
  });

  it('overhead is charged against the same budget', () => {
    expect(fit(chunks(30, 1_000), 10_000).kept.length).toBeLessThan(
      fit(chunks(30, 1_000), 0).kept.length
    );
  });

  it('a single item too large to fit is still returned, flagged', () => {
    expect(fit(chunks(1, 40_000), 0)).toMatchObject({ truncated: true });
    expect(fit(chunks(1, 40_000), 0).kept).toHaveLength(1);
  });

  it('encodes with sorted keys, no undefined, and escaped slashes, as Foundation does', () => {
    expect(encodePayload({ b: 1, a: { d: undefined, c: 'x/y' } })).toBe(
      '{"a":{"c":"x\\/y"},"b":1}'
    );
    expect(JSON.parse(encodePayload({ url: 'a/b' }))).toEqual({ url: 'a/b' });
  });
});

describe('FuzzyMatch', () => {
  it('tokenizes with edge punctuation shed and case kept', () => {
    expect(tokenize("Don't ship, plan.")).toEqual(["Don't", 'ship', 'plan']);
    expect(tokenize('  spaced   out ')).toEqual(['spaced', 'out']);
  });

  it('collapses the spellings ASR alternates between onto one key', () => {
    expect(phoneticKey('qlora')).toBe('klr');
    expect(phoneticKey('cuelura')).toBe('klr');
    expect(phoneticKey('phone')).toBe('fn');
    expect(phoneticKey('exam')).not.toBe(phoneticKey('evals'));
  });

  it('Levenshtein over words', () => {
    expect(editDistance('evals', 'evalves')).toBe(2);
    expect(editDistance('', 'abc')).toBe(3);
    expect(editDistance('same', 'same')).toBe(0);
  });

  it('aligns a query against the first run that fits, marking exactness', () => {
    const u = new FuzzyUtterance('we fine tuned with cue lura yesterday');
    expect(new FuzzyQuery('QLoRA').match(u)).toEqual({ start: 4, end: 6, exact: false });
    expect(new FuzzyQuery('fine tuned').match(u)).toEqual({ start: 1, end: 3, exact: true });
    expect(new FuzzyQuery('the').match(new FuzzyUtterance('they said'))).toBeNull();
    expect(new FuzzyQuery('').match(u)).toBeNull();
  });
});

describe('text helpers', () => {
  it('spells timestamps, instants and case-insensitive contains as Scribe does', () => {
    expect(timestamp(3661)).toBe('01:01:01');
    expect(timestamp(-5)).toBe('00:00:00');
    expect(isoSeconds(86_400_000)).toBe('1970-01-02T00:00:00Z');
    expect(isoSeconds(86_400_500)).toBe('1970-01-02T00:00:00Z');
    expect(includesCI('Design Review', 'design')).toBe(true);
    expect(includesCI('Design Review', '')).toBe(false);
  });
});

describe('fingerprint and bleed', () => {
  it('covers the resolved label as well as the words', () => {
    const base = transcript({
      speakers: [speaker(mic, 'Room 1')],
      utterances: [utterance('hello', mic, 0, 2)],
    });
    const renamed = { ...base, speakers: [speaker(mic, 'Dana')] };
    const reworded = { ...base, utterances: [utterance('hullo', mic, 0, 2)] };
    expect(fingerprint(base)).toMatch(/^[0-9a-f]{16}$/);
    expect(fingerprint(base)).not.toBe(fingerprint(renamed));
    expect(fingerprint(base)).not.toBe(fingerprint(reworded));
    expect(fingerprint(base)).toBe(fingerprint({ ...base }));
  });

  it('a span is bled when any part of it falls in a window over the threshold', () => {
    const windows = [{ start: 3.0, coefficient: 0.9, lag: 0.05 }];
    expect(isBled(0, 5, windows, 0.5)).toBe(true);
    expect(isBled(10, 12, windows, 0.5)).toBe(false);
    expect(isBled(0, 5, [{ start: 3.0, coefficient: 0.2, lag: 0.05 }], 0.5)).toBe(false);
  });
});

describe('summaries', () => {
  const standup = (lib: FakeLibrary, title = 'Standup', day = 1) =>
    lib.meeting({
      title,
      day,
      transcript: transcript({
        speakers: [speaker(mic, 'Speaker 2')],
        utterances: [utterance('we should ship', mic, 0, 2)],
      }),
    });

  it('get_meeting and list_meetings carry a fresh summary and withhold a stale one', async () => {
    const lib = new FakeLibrary();
    const fresh = standup(lib, 'Fresh', 1);
    lib.saveSummary(fresh, 'They agreed to ship on Friday.');
    const stale = standup(lib, 'Stale', 2);
    lib.saveSummary(stale, 'Speaker 2 pushed back.', { fresh: false });
    const oldVersion = standup(lib, 'Old', 3);
    lib.saveSummary(oldVersion, 'Written by an old summarizer.', { version: 1 });
    const none = standup(lib, 'None', 4);

    const q = new Queries(lib.reader());
    expect((await q.getMeeting(fresh)).summary).toBe('They agreed to ship on Friday.');
    expect((await q.getMeeting(stale)).summary).toBeUndefined();
    expect((await q.getMeeting(oldVersion)).summary).toBeUndefined();
    expect(encodePayload(await q.getMeeting(none))).not.toContain('"summary"');
    const rows = (await q.listMeetings({ limit: 50 })).meetings;
    expect(rows.find((r) => r.meeting_id === fresh)?.summary).toBe(
      'They agreed to ship on Friday.'
    );
    expect(rows.find((r) => r.meeting_id === stale)?.summary).toBeUndefined();
  });

  it('the two surfaces agree even when labels drift from the stored transcript', async () => {
    const lib = new FakeLibrary();
    const id = standup(lib);
    lib.saveSummary(id, 'They agreed.');
    lib.saveLabels(id, new Labels().set('Dana', mic));
    const q = new Queries(lib.reader());
    expect((await q.getMeeting(id)).summary).toBe('They agreed.');
    expect((await q.listMeetings({ limit: 50 })).meetings[0]!.summary).toBe('They agreed.');
  });

  it('summaries reduce how many meetings fit in a page', async () => {
    const lib = new FakeLibrary();
    const ids: string[] = [];
    for (let day = 1; day <= 200; day++) ids.push(standup(lib, `Meeting ${day}`, day));
    const q = new Queries(lib.reader());
    const without = (await q.listMeetings({ limit: 200 })).meetings.length;
    for (const id of ids) lib.saveSummary(id, 'A sentence about the meeting. '.repeat(3));
    const withSummaries = (await q.listMeetings({ limit: 200 })).meetings.length;
    expect(withSummaries).toBeLessThan(without);
    expect(withSummaries).toBeGreaterThan(0);
  });
});

describe('tags', () => {
  const tagged = (
    lib: FakeLibrary,
    title: string,
    day: number,
    applied: Array<[string, 'auto' | 'human']>,
    options: { fresh?: boolean; suggestion?: string } = {}
  ) => {
    const id = lib.meeting({
      title,
      day,
      transcript: transcript({
        speakers: [speaker(mic, 'Room 1')],
        utterances: [utterance('we should ship', mic, 0, 2)],
      }),
    });
    lib.saveTags(id, applied, options);
    return id;
  };

  it('get_meeting carries tags context first, with the suggestion, and flags stale ones', async () => {
    const lib = new FakeLibrary();
    lib.saveTagList(STARTER_TAG_LIST);
    const id = tagged(
      lib,
      'Loop',
      1,
      [
        ['starter-interview', 'auto'],
        ['starter-work', 'human'],
      ],
      {
        suggestion: 'Onsite',
      }
    );
    const detail = await new Queries(lib.reader()).getMeeting(id);
    expect(detail.tags).toEqual([
      { name: 'Work', tier: 'context', origin: 'human' },
      { name: 'Interview', tier: 'format', origin: 'auto' },
    ]);
    expect(detail.suggested_tag).toBe('Onsite');
    expect(detail.tags_stale).toBeUndefined();

    const stale = tagged(lib, 'Old', 2, [['starter-work', 'auto']], { fresh: false });
    const staleDetail = await new Queries(lib.reader()).getMeeting(stale);
    expect(staleDetail.tags?.map((t) => t.name)).toEqual(['Work']);
    expect(staleDetail.tags_stale).toBe(true);
  });

  it('an untagged meeting omits every tag key', async () => {
    const lib = new FakeLibrary();
    const json = encodePayload(
      await new Queries(lib.reader()).getMeeting(lib.meeting({ title: 'Standup', day: 1 }))
    );
    expect(json).not.toContain('"tags"');
    expect(json).not.toContain('suggested_tag');
    expect(json).not.toContain('tags_stale');
  });

  it('tags against the starter are served when no list is saved, and a legacy "type" tier reads as format', async () => {
    const lib = new FakeLibrary();
    const id = tagged(lib, 'Loop', 1, [
      ['starter-work', 'auto'],
      ['starter-standup', 'auto'],
    ]);
    const q = new Queries(lib.reader());
    expect((await q.getMeeting(id)).tags?.map((t) => t.name)).toEqual(['Work', 'Standup']);
    expect(
      (await q.listMeetings({ limit: 50, tags: ['work'] })).meetings.map((m) => m.title)
    ).toEqual(['Loop']);

    lib.saveTagList({
      tags: [{ id: 'starter-standup', name: 'Standup', tier: 'type', description: '' }],
    });
    expect((await q.getMeeting(id)).tags).toEqual([
      { name: 'Standup', tier: 'format', origin: 'auto' },
    ]);
  });

  it('list_meetings filters by every tag ignoring case; search_transcripts filters by tag', async () => {
    const lib = new FakeLibrary();
    lib.saveTagList(STARTER_TAG_LIST);
    tagged(lib, 'Loop', 1, [
      ['starter-work', 'auto'],
      ['starter-interview', 'auto'],
    ]);
    tagged(lib, 'Standup', 2, [
      ['starter-work', 'auto'],
      ['starter-standup', 'auto'],
    ]);
    tagged(lib, 'Session', 3, [['starter-personal', 'human']]);
    const q = new Queries(lib.reader());
    const work = await q.listMeetings({ limit: 50, tags: ['work'] });
    expect(work.meetings.map((m) => m.title)).toEqual(['Standup', 'Loop']);
    expect(work.meetings[0]!.tags?.map((t) => t.name)).toEqual(['Work', 'Standup']);
    expect(
      (await q.listMeetings({ limit: 50, tags: ['Work', 'INTERVIEW'] })).meetings.map(
        (m) => m.title
      )
    ).toEqual(['Loop']);
    const hits = await q.searchTranscripts({
      query: 'ship',
      match: 'literal',
      contextLines: 0,
      limit: 50,
      tags: ['interview'],
    });
    expect(hits.hits.map((h) => h.title)).toEqual(['Loop']);
  });

  it('a tags file without a tagger version reads as no tags, as Scribe fails to decode it', async () => {
    const lib = new FakeLibrary();
    lib.saveTagList(STARTER_TAG_LIST);
    const id = tagged(lib, 'Loop', 1, [['starter-work', 'auto']], {});
    lib.saveTags(id, [['starter-work', 'auto']], { version: undefined });
    // `saveTags` always writes a version; strip it to model the legacy file.
    const reader = lib.reader();
    const legacy = {
      ...reader,
      meetingTags: async () => ({
        applied: [{ tagID: 'starter-work', origin: 'auto' as const }],
        removed: [],
        dismissed: [],
        fingerprint: 'x',
      }),
    };
    expect((await new Queries(legacy).getMeeting(id)).tags).toBeUndefined();
  });
});
