import { randomBytes, randomUUID } from 'crypto';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { blobAad, seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';
import { createLibraryReader, type LibraryReader } from './library-reader';

let h: Harness;
let client: VaultClient;
let owner: Owner;
let reader: LibraryReader;

const processed = randomUUID();
const unprocessed = randomUUID();
const deleted = randomUUID();
const noManifest = randomUUID();
const foreignKey = randomUUID();

/** Seals `value` as the Mac would and stores it as the meeting's first `kind` blob. */
async function putJson(meetingId: string, kind: string, value: unknown, key = owner.libraryKey) {
  const bytes = seal(
    key,
    Buffer.from(JSON.stringify(value)),
    blobAad(owner.libraryId, meetingId, kind, 1)
  );
  const res = await client.putMeetingBlob({
    token: owner.deviceToken,
    meetingId,
    kind,
    bytes,
    ifMatch: null,
  });
  expect(res.status).toBe(201);
}

beforeAll(async () => {
  h = await createHarness();
  client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code' });

  await putJson(processed, 'manifest', { meetingID: processed, title: 'Design Review' });
  await putJson(processed, 'transcript', { meetingID: processed, speakers: [], utterances: [] });
  await putJson(processed, 'labels', { entries: [] });
  await putJson(unprocessed, 'manifest', { meetingID: unprocessed, title: 'Still recording' });
  await putJson(deleted, 'manifest', { meetingID: deleted, title: 'Gone' });
  expect((await client.deleteMeeting(owner.deviceToken, deleted)).status).toBe(204);
  await putJson(noManifest, 'transcript', { meetingID: noManifest, speakers: [], utterances: [] });
  // Sealed under some other key: stored fine (the vault cannot tell), unreadable here.
  await putJson(foreignKey, 'manifest', { meetingID: foreignKey, title: 'Other' }, randomBytes(32));
  const list = seal(
    owner.libraryKey,
    Buffer.from(
      JSON.stringify({ tags: [{ id: 't', name: 'Work', tier: 'context', description: '' }] })
    ),
    blobAad(owner.libraryId, 'library', 'tag-list', 1)
  );
  expect(
    (
      await client.putLibraryBlob({
        token: owner.deviceToken,
        kind: 'tag-list',
        bytes: list,
        ifMatch: null,
      })
    ).status
  ).toBe(201);

  reader = createLibraryReader({
    prisma: h.prisma,
    blobStore: h.blobStore,
    libraryId: owner.libraryId,
    libraryKey: owner.libraryKey,
  });
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe('LibraryReader', () => {
  it('lists live meetings that have a manifest, sorted, whether or not the manifest opens', async () => {
    expect(await reader.listMeetingIds()).toEqual([processed, unprocessed, foreignKey].sort());
  });

  it('opens and parses each artifact under the AAD the Mac sealed it with', async () => {
    expect(await reader.manifest(processed)).toEqual({
      meetingID: processed,
      title: 'Design Review',
    });
    expect(await reader.transcript(processed)).toEqual({
      meetingID: processed,
      speakers: [],
      utterances: [],
    });
    expect(await reader.labels(processed)).toEqual({ entries: [] });
    expect(await reader.tagList()).toEqual({
      tags: [{ id: 't', name: 'Work', tier: 'context', description: '' }],
    });
  });

  it('answers null for an artifact that is not there', async () => {
    expect(await reader.transcript(unprocessed)).toBeNull();
    expect(await reader.inferences(processed)).toBeNull();
    expect(await reader.summary(processed)).toBeNull();
    expect(await reader.meetingTags(processed)).toBeNull();
    expect(await reader.manifest(randomUUID())).toBeNull();
    expect(await reader.manifest('library')).toBeNull();
  });

  it('answers null for a blob that does not open under this key', async () => {
    expect(await reader.manifest(foreignKey)).toBeNull();
  });

  it('reads nothing once the key has been zeroed', async () => {
    const key = Buffer.from(owner.libraryKey);
    const scoped = createLibraryReader({
      prisma: h.prisma,
      blobStore: h.blobStore,
      libraryId: owner.libraryId,
      libraryKey: key,
    });
    expect(await scoped.manifest(processed)).not.toBeNull();
    key.fill(0);
    expect(await scoped.manifest(processed)).toBeNull();
  });
});
