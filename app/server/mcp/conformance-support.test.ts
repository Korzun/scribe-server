import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import {
  fixtureState,
  normalize,
  normalizeTool,
  readStore,
  runStep,
  sortKeys,
  type ToolCaller,
} from './conformance-support';

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'scribe-conformance-'));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('normalize', () => {
  it('drops cursors, lowercases UUIDs, reads dates as instants, and keeps nulls and order', () => {
    expect(
      normalize({
        next_cursor: '12#abc',
        meeting_id: '0F1E2D3C-4B5A-4978-8796-A5B4C3D2E1F0',
        started_at: '1970-01-02T00:00:00Z',
        ended_at: '1970-01-02T00:00:00.000Z',
        cluster_id: null,
        hits: [{ next_offset: 3, text: 'kept' }],
      })
    ).toEqual({
      meeting_id: '0f1e2d3c-4b5a-4978-8796-a5b4c3d2e1f0',
      started_at: 86_400_000,
      ended_at: 86_400_000,
      cluster_id: null,
      hits: [{ next_offset: 3, text: 'kept' }],
    });
    expect(normalize({ pages: [{ next_cursor: '1' }, { truncated: false }] })).toEqual({
      pages: [{}, { truncated: false }],
    });
  });

  it('leaves strings that merely look like a date or an id alone', () => {
    expect(normalize('2026-08-31')).toBe('2026-08-31');
    expect(normalize('not-a-uuid')).toBe('not-a-uuid');
  });

  it('drops null-valued keys of a tool entry', () => {
    expect(
      normalizeTool({ name: 'x', outputSchema: null, annotations: { readOnlyHint: true } })
    ).toEqual({
      name: 'x',
      annotations: { readOnlyHint: true },
    });
  });
});

describe('fixtureState', () => {
  it('is absent for a missing or empty directory', () => {
    expect(fixtureState(path.join(dir, 'nope'))).toEqual({ kind: 'absent' });
    expect(fixtureState(dir)).toEqual({ kind: 'absent' });
  });

  it('is absent while only the script (committed source) is there', () => {
    fs.writeFileSync(path.join(dir, 'script.json'), '{"version":1,"steps":[]}');
    expect(fixtureState(dir)).toEqual({ kind: 'absent' });
  });

  it('is partial when only one of the exported parts is there, or the script is gone', () => {
    fs.writeFileSync(path.join(dir, 'script.json'), '{"version":1,"steps":[]}');
    fs.mkdirSync(path.join(dir, 'store'));
    expect(fixtureState(dir)).toEqual({ kind: 'partial', missing: ['expected.json'] });
    fs.writeFileSync(path.join(dir, 'expected.json'), '{"version":1,"tools":[],"results":[]}');
    fs.rmSync(path.join(dir, 'script.json'));
    expect(fixtureState(dir)).toEqual({ kind: 'partial', missing: ['script.json'] });
  });

  it('is present with the parsed script and expectations', () => {
    fs.mkdirSync(path.join(dir, 'store'));
    fs.writeFileSync(
      path.join(dir, 'script.json'),
      '{"version":1,"steps":[{"name":"list_meetings"}]}'
    );
    fs.writeFileSync(
      path.join(dir, 'expected.json'),
      '{"version":1,"tools":[],"results":[{"payload":{}}]}'
    );
    const state = fixtureState(dir);
    expect(state.kind).toBe('present');
    if (state.kind !== 'present') return;
    expect(state.script.steps).toEqual([{ name: 'list_meetings' }]);
    expect(state.expected.results).toEqual([{ payload: {} }]);
  });
});

describe('readStore', () => {
  it('maps each bundle file to its blob kind, lowercases ids, and finds the tag list', () => {
    const id = '0F1E2D3C-4B5A-4978-8796-A5B4C3D2E1F0';
    const bundle = path.join(dir, 'Meetings', id);
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'manifest.json'), '{"m":1}');
    fs.writeFileSync(path.join(bundle, 'transcript.json'), '{"t":1}');
    fs.writeFileSync(path.join(bundle, 'mic.wav'), 'RIFF');
    fs.writeFileSync(path.join(dir, 'tags.json'), '{"tags":[]}');
    const store = readStore(dir);
    expect(store.meetings).toEqual([
      {
        id: id.toLowerCase(),
        files: [
          { kind: 'manifest', bytes: Buffer.from('{"m":1}') },
          { kind: 'transcript', bytes: Buffer.from('{"t":1}') },
        ],
      },
    ]);
    expect(store.tagList?.toString()).toBe('{"tags":[]}');
    expect(readStore(path.join(dir, 'empty'))).toEqual({ meetings: [], tagList: null });
  });
});

describe('runStep', () => {
  const calls: Array<[string, Record<string, unknown>]> = [];
  const door =
    (answers: Array<{ payload: unknown } | { error: string }>): ToolCaller =>
    async (name, args) => {
      calls.push([name, args]);
      return answers.shift() ?? { error: 'ran out of answers' };
    };
  beforeEach(() => calls.splice(0));

  it('calls a plain step once with its arguments, or with none', async () => {
    expect(await runStep(door([{ payload: { ok: 1 } }]), { name: 'get_meeting' })).toEqual({
      payload: { ok: 1 },
    });
    expect(calls).toEqual([['get_meeting', {}]]);
  });

  it('walks pages by feeding the followed field back as cursor or offset', async () => {
    const pages = [
      { payload: { rows: [1], next_cursor: 'a' } },
      { payload: { rows: [2], next_cursor: 'b' } },
      { payload: { rows: [3], next_cursor: null } },
    ];
    expect(
      await runStep(door(pages), {
        name: 'list_meetings',
        arguments: { limit: 1 },
        follow: 'next_cursor',
      })
    ).toEqual({
      pages: [
        { rows: [1], next_cursor: 'a' },
        { rows: [2], next_cursor: 'b' },
        { rows: [3], next_cursor: null },
      ],
    });
    expect(calls.map(([, args]) => args)).toEqual([
      { limit: 1 },
      { limit: 1, cursor: 'a' },
      { limit: 1, cursor: 'b' },
    ]);

    await runStep(door([{ payload: { next_offset: 2 } }, { payload: {} }]), {
      name: 'get_transcript',
      arguments: { meeting_id: 'm' },
      follow: 'next_offset',
    });
    expect(calls.slice(3).map(([, args]) => args)).toEqual([
      { meeting_id: 'm' },
      { meeting_id: 'm', offset: 2 },
    ]);
  });

  it('records an error that ends a walk as the error, not as pages', async () => {
    expect(
      await runStep(door([{ payload: { next_cursor: 'a' } }, { error: 'bad cursor' }]), {
        name: 'list_speakers',
        follow: 'next_cursor',
      })
    ).toEqual({ error: 'bad cursor' });
  });
});

describe('sortKeys', () => {
  it('sorts keys at every depth and leaves arrays in order', () => {
    expect(JSON.stringify(sortKeys({ b: [{ z: 1, a: 2 }], a: null }))).toBe(
      '{"a":null,"b":[{"a":2,"z":1}]}'
    );
  });
});
