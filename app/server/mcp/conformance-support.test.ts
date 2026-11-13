import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { fixtureState, normalize, normalizeTool, readStore } from './conformance-support';

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

  it('is partial when only some of the three parts are there', () => {
    fs.writeFileSync(path.join(dir, 'script.json'), '{"version":1,"steps":[]}');
    expect(fixtureState(dir)).toEqual({ kind: 'partial', missing: ['store', 'expected.json'] });
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
