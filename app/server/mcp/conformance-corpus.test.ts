import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import type {
  Manifest,
  MeetingSummaryFile,
  MeetingTagsFile,
  SpeakerLabelsFile,
  TagListFile,
  Transcript,
} from './artifacts';
import { CORPUS_IDS, corpus, writeCorpus } from './conformance-corpus';
import { readStore } from './conformance-support';
import type { LibraryReader } from './library-reader';
import { fingerprint } from './queries/resolved';
import { payloadOf } from './test-support';
import { callTool } from './tools';

let root: string;
beforeEach(() => {
  root = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-corpus-')), 'store');
});
afterEach(() => {
  fs.rmSync(path.dirname(root), { recursive: true, force: true });
});

const read = <T>(...parts: string[]): T =>
  JSON.parse(fs.readFileSync(path.join(root, ...parts), 'utf8')) as T;

const bundle = (id: string): string[] => fs.readdirSync(path.join(root, 'Meetings', id)).sort();

/** The store on disk behind the vault's reader interface, as a sealed library would present it. */
function readerOver(dir: string): LibraryReader {
  const file = <T>(kind: string) => {
    const name = Object.entries({
      manifest: 'manifest.json',
      transcript: 'transcript.json',
      labels: 'labels.json',
      inferences: 'inferences.json',
      summary: 'summary.json',
      tags: 'tags.json',
    }).find(([k]) => k === kind)![1];
    return async (meetingId: string): Promise<T | null> => {
      const target = path.join(dir, 'Meetings', meetingId.toUpperCase(), name);
      return fs.existsSync(target) ? (JSON.parse(fs.readFileSync(target, 'utf8')) as T) : null;
    };
  };
  return {
    listMeetingIds: async () =>
      readStore(dir)
        .meetings.map((m) => m.id)
        .sort(),
    manifest: file('manifest'),
    transcript: file('transcript'),
    labels: file('labels'),
    inferences: file('inferences'),
    summary: file('summary'),
    meetingTags: file('tags'),
    tagList: async () => {
      const target = path.join(dir, 'tags.json');
      return fs.existsSync(target)
        ? (JSON.parse(fs.readFileSync(target, 'utf8')) as TagListFile)
        : null;
    },
  };
}

describe('the conformance corpus', () => {
  it('names exactly the meetings the script names, in uppercase bundle directories', () => {
    writeCorpus(root);
    const script = JSON.parse(
      fs.readFileSync(path.resolve(__dirname, '../../../test/conformance/script.json'), 'utf8')
    ) as { steps: Array<{ arguments?: Record<string, unknown> }> };
    const named = new Set<string>();
    for (const step of script.steps) {
      const id = step.arguments?.meeting_id;
      if (typeof id === 'string' && /^[0-9a-f-]{36}$/i.test(id)) named.add(id.toUpperCase());
      for (const m of (step.arguments?.meeting_ids as unknown[]) ?? []) {
        if (typeof m === 'string' && /^[0-9a-f-]{36}$/i.test(m)) named.add(m.toUpperCase());
      }
    }
    const written = fs.readdirSync(path.join(root, 'Meetings')).sort();
    expect(written).toEqual(Object.values(CORPUS_IDS).slice().sort());
    // The script also asks after one id that must not exist.
    named.delete('99999999-9999-4999-8999-999999999999');
    for (const id of named) expect(written).toContain(id);
  });

  it('gives each meeting the files its role calls for', () => {
    writeCorpus(root);
    expect(fs.existsSync(path.join(root, 'tags.json'))).toBe(true);
    expect(bundle(CORPUS_IDS.designReview)).toEqual([
      'labels.json',
      'manifest.json',
      'summary.json',
      'tags.json',
      'transcript.json',
    ]);
    expect(bundle(CORPUS_IDS.standup)).toEqual([
      'inferences.json',
      'labels.json',
      'manifest.json',
      'summary.json',
      'tags.json',
      'transcript.json',
    ]);
    expect(bundle(CORPUS_IDS.syncOne)).toEqual(['manifest.json', 'transcript.json']);
    expect(bundle(CORPUS_IDS.syncTwo)).toEqual([
      'manifest.json',
      'summary.json',
      'transcript.json',
    ]);
    expect(bundle(CORPUS_IDS.weekly)).toEqual([
      'inferences.json',
      'labels.json',
      'manifest.json',
      'transcript.json',
    ]);
    expect(bundle(CORPUS_IDS.inProgress)).toEqual(['manifest.json']);
    expect(bundle(CORPUS_IDS.long)).toEqual(['manifest.json', 'transcript.json']);
  });

  it("spells the files the way Swift's Codable reads them", () => {
    writeCorpus(root);
    const review = read<Manifest>('Meetings', CORPUS_IDS.designReview, 'manifest.json');
    expect(review).toMatchObject({
      meetingID: CORPUS_IDS.designReview,
      startedAt: '1970-01-03T00:00:00Z',
      endedAt: '1970-01-03T00:10:00Z',
      micDuration: 598,
      systemDuration: 412,
      titleOrigin: 'calendar',
      scheduledEnd: '1970-01-03T00:30:00Z',
      attendeeKinds: ['person', 'room', null],
    });
    // Swift's .iso8601 decoder refuses fractional seconds; absent is absent, not null.
    for (const file of fs.readdirSync(path.join(root, 'Meetings', CORPUS_IDS.designReview))) {
      const text = fs.readFileSync(
        path.join(root, 'Meetings', CORPUS_IDS.designReview, file),
        'utf8'
      );
      expect(text, file).not.toMatch(/\d{2}:\d{2}:\d{2}\.\d+Z/);
    }
    const legacy = read<Manifest>('Meetings', CORPUS_IDS.syncOne, 'manifest.json');
    expect(legacy).not.toHaveProperty('micDuration');
    expect(legacy).not.toHaveProperty('systemDuration');
    const provisional = read<Manifest>('Meetings', CORPUS_IDS.inProgress, 'manifest.json');
    expect(provisional).not.toHaveProperty('endedAt');
    expect(provisional.duration).toBe(0);

    const transcript = read<Transcript>('Meetings', CORPUS_IDS.designReview, 'transcript.json');
    const unattributed = transcript.utterances.find((u) => u.text === 'mumble')!;
    expect(unattributed.speaker).toEqual({ stream: 'microphone' });
    expect(unattributed).not.toHaveProperty('textConfidence');
    expect(transcript.utterances[0]!.tokens[1]).toEqual({ text: 'all', start: 0.5, end: 0.8 });

    const labels = read<SpeakerLabelsFile>('Meetings', CORPUS_IDS.designReview, 'labels.json');
    expect(labels.entries[0]!.origin).toEqual({ voiceprint: { id: 'v1' } });
    const weeklyLabels = read<SpeakerLabelsFile>('Meetings', CORPUS_IDS.weekly, 'labels.json');
    expect(weeklyLabels.entries.map((e) => e.origin)).toEqual([{ inferred: {} }, { human: {} }]);
  });

  it('writes fresh and stale summaries and tags as it says', () => {
    writeCorpus(root);
    const freshOf = (id: string) =>
      fingerprint(read<Transcript>('Meetings', id, 'transcript.json'));
    const review = read<MeetingSummaryFile>('Meetings', CORPUS_IDS.designReview, 'summary.json');
    expect(review.transcriptFingerprint).toBe(freshOf(CORPUS_IDS.designReview));
    expect(review.summarizerVersion).toBe(2);
    const standup = read<MeetingSummaryFile>('Meetings', CORPUS_IDS.standup, 'summary.json');
    expect(standup.transcriptFingerprint).not.toBe(freshOf(CORPUS_IDS.standup));
    const old = read<MeetingSummaryFile>('Meetings', CORPUS_IDS.syncTwo, 'summary.json');
    expect(old.transcriptFingerprint).toBe(freshOf(CORPUS_IDS.syncTwo));
    expect(old.summarizerVersion).toBe(1);

    const reviewTags = read<MeetingTagsFile>('Meetings', CORPUS_IDS.designReview, 'tags.json');
    expect(reviewTags).toEqual({
      applied: [
        { tagID: 'starter-interview', origin: 'auto' },
        { tagID: 'starter-work', origin: 'human' },
      ],
      removed: [],
      dismissed: [],
      suggestion: { name: 'Onsite', description: '' },
      taggerVersion: 3,
      fingerprint: freshOf(CORPUS_IDS.designReview),
    });
    const standupTags = read<MeetingTagsFile>('Meetings', CORPUS_IDS.standup, 'tags.json');
    expect(standupTags.fingerprint).toBe('0000000000000000');
  });

  it('is deterministic and replaces what was there', () => {
    writeCorpus(root);
    fs.writeFileSync(path.join(root, 'Meetings', 'debris.txt'), 'x');
    const first = Object.fromEntries(
      writeCorpus(root).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')])
    );
    expect(fs.existsSync(path.join(root, 'Meetings', 'debris.txt'))).toBe(false);
    const second = Object.fromEntries(
      writeCorpus(root).map((f) => [f, fs.readFileSync(path.join(root, f), 'utf8')])
    );
    expect(second).toEqual(first);
    // The tag list, seven manifests, and sixteen other artifacts across the bundles.
    expect(Object.keys(first)).toHaveLength(1 + corpus().length + 16);
  });

  it("is a library the vault's own tools can read end to end", async () => {
    writeCorpus(root);
    const reader = readerOver(root);
    const listed = payloadOf(await callTool(reader, 'list_meetings', {})) as {
      meetings: Array<{ title: string }>;
    };
    expect(listed.meetings.map((m) => m.title)).toEqual([
      'Weekly sync',
      'In progress',
      'Standup',
      'Design Review',
      'Sync 1',
      'Sync 2',
      'Long',
    ]);
    const hits = payloadOf(await callTool(reader, 'search_transcripts', { query: 'QLoRA' })) as {
      hits: Array<{ text: string }>;
    };
    expect(hits.hits.map((h) => h.text)).toContain('we fine tuned with cue lura yesterday');
  });
});
