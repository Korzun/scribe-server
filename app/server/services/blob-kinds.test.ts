import { describe, expect, it } from 'vitest';

import {
  isCanonicalUuid,
  isMeetingKind,
  libraryKindName,
  MEETING_KINDS,
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

  it('refuses a voice id that is not canonical lowercase, rather than normalising it', () => {
    // Swift's `UUID().uuidString` is uppercase; the client must lowercase it,
    // because the AAD it seals under is built from the id it sends.
    expect(parseLibraryKind(`voice/${VOICE.toUpperCase()}`)).toBeNull();
    expect(
      parseLibraryKind(`voice/${VOICE.slice(0, 4).toUpperCase()}${VOICE.slice(4)}`)
    ).toBeNull();
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

  it('isCanonicalUuid accepts only the canonical lowercase 8-4-4-4-12 form', () => {
    expect(isCanonicalUuid(VOICE)).toBe(true);
    for (const s of [
      '',
      'not-a-uuid',
      VOICE.toUpperCase(),
      VOICE.replace(/-/g, ''),
      `${VOICE}\n`,
      ` ${VOICE}`,
      `{${VOICE}}`,
      `../${VOICE}`,
    ]) {
      expect(isCanonicalUuid(s)).toBe(false);
    }
  });
});
