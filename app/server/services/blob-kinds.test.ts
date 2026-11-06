import { describe, expect, it } from 'vitest';

import {
  isMeetingKind,
  isUuid,
  libraryKindName,
  MEETING_KINDS,
  normalizeUuid,
  parseLibraryKind,
} from './blob-kinds';

const VOICE = '3f2b8c1e-9a4d-4e7b-8c2a-1d5e6f7a8b9c';

describe('blob kinds', () => {
  it('knows every meeting kind of spec §6 and nothing else', () => {
    expect(MEETING_KINDS).toHaveLength(10);
    for (const kind of MEETING_KINDS) expect(isMeetingKind(kind)).toBe(true);
    for (const kind of ['', 'Manifest', 'tag-list', 'voice', '../manifest', 'audio']) {
      expect(isMeetingKind(kind)).toBe(false);
    }
  });

  it('parses tag-list and voice/<uuid>', () => {
    expect(parseLibraryKind('tag-list')).toEqual({ kind: 'tag-list' });
    expect(parseLibraryKind(`voice/${VOICE}`)).toEqual({ kind: 'voice', voiceId: VOICE });
  });

  it('accepts a voice id in any case and hands back the lowercase one', () => {
    // Swift's `UUID().uuidString` is uppercase; the vault keys on lowercase.
    expect(parseLibraryKind(`voice/${VOICE.toUpperCase()}`)).toEqual({
      kind: 'voice',
      voiceId: VOICE,
    });
    expect(libraryKindName({ kind: 'voice', voiceId: VOICE })).toBe(`voice/${VOICE}`);
    expect(libraryKindName({ kind: 'tag-list' })).toBe('tag-list');
  });

  it('refuses every other shape', () => {
    for (const kind of [
      '',
      'voice',
      'voice/',
      'voice/../x',
      'voice/not-a-uuid',
      `voice/${VOICE}/x`,
      'Tag-List',
      `/voice/${VOICE}`,
      'tag-list/',
      'manifest',
    ]) {
      expect(parseLibraryKind(kind)).toBeNull();
    }
  });

  it('isUuid accepts only the canonical lowercase form', () => {
    expect(isUuid(VOICE)).toBe(true);
    expect(isUuid(VOICE.toUpperCase())).toBe(false);
    expect(isUuid(VOICE.replace(/-/g, ''))).toBe(false);
    expect(isUuid(`${VOICE}\n`)).toBe(false);
  });

  it('normalizeUuid lowercases any-case UUIDs and refuses everything else', () => {
    expect(normalizeUuid(VOICE)).toBe(VOICE);
    expect(normalizeUuid(VOICE.toUpperCase())).toBe(VOICE);
    for (const s of ['', 'not-a-uuid', VOICE.replace(/-/g, ''), `${VOICE}\n`, `../${VOICE}`]) {
      expect(normalizeUuid(s)).toBeNull();
    }
  });
});
