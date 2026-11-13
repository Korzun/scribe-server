import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { parseSecretKey } from './crypto/codes';
import { deriveAccountKeys } from './crypto/kdf';
import { blobAad, keyWrapAad, open, seal } from './crypto/seal';
import { MEETING_KINDS } from './services/blob-kinds';
import { createHarness, type Harness } from './test-support/harness';
import { createOwner, VaultClient, writeSetupCode } from './test-support/vault-client';

const MiB = 1024 * 1024;
const DAY_MS = 24 * 60 * 60 * 1000;
const sha256 = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Every file the blob store holds, wherever it is sharded. */
function blobFiles(root: string): string[] {
  return fs
    .readdirSync(root, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.join(e.parentPath, e.name));
}

/**
 * The whole vault in one story, as two Macs would live it (spec §14, "usable
 * with a small test client"): every request goes through the real routes,
 * every blob is sealed with the real Library Key under the AAD the Mac would
 * use, and every step checks the state the next step relies on.
 */
describe('the vault, end to end', () => {
  let h: Harness;

  beforeEach(async () => {
    h = await createHarness();
  });

  afterEach(async () => {
    await h.close();
  });

  it('carries one meeting from one Mac to another, through deletion and the sweep', async () => {
    const client = new VaultClient(h.app);
    writeSetupCode(h.dataDir, 'e2e-setup-code');

    // Device A creates the library.
    const a = await createOwner(client, { setupCode: 'e2e-setup-code', name: 'Mac A' });
    expect(a.deviceToken).not.toBe('');
    expect((await client.status()).body.libraryExists).toBe(true);

    // Device B joins with the password and the Secret Key, and unwraps the
    // Library Key itself: the vault never sees it.
    const enrolled = await client.enrol({
      password: a.password,
      secretKey: a.secretKey,
      name: 'Mac B',
    });
    expect(enrolled.status).toBe(201);
    expect(enrolled.body.libraryId).toBe(a.libraryId);
    const bToken = enrolled.body.deviceToken!;
    const salts = await client.salts();
    const bKeys = deriveAccountKeys({
      secret: Buffer.from(a.password, 'utf8'),
      secretKey: parseSecretKey(a.secretKey)!,
      salt: Buffer.from(salts.body.passwordSalt!, 'base64'),
    });
    const bLibraryKey = open(
      bKeys.kek,
      Buffer.from(enrolled.body.passwordWrap!, 'base64'),
      keyWrapAad(a.libraryId, 'password')
    );
    expect(bLibraryKey.equals(a.libraryKey)).toBe(true);
    const devices = await client.devices(a.deviceToken);
    expect(devices.body.devices?.map((d) => d.name).sort()).toEqual(['Mac A', 'Mac B']);

    // A writes all eight non-audio artifacts of one meeting, each a first write.
    const meetingId = crypto.randomUUID();
    const kinds = MEETING_KINDS.filter((k) => !k.startsWith('audio-'));
    expect(kinds).toHaveLength(8);
    const plaintexts = new Map<string, Buffer>();
    for (const kind of kinds) {
      const plaintext = Buffer.from(JSON.stringify({ kind, meetingId, note: `the ${kind}` }));
      plaintexts.set(kind, plaintext);
      const sealed = seal(a.libraryKey, plaintext, blobAad(a.libraryId, meetingId, kind, 1));
      const put = await client.putMeetingBlob({
        token: a.deviceToken,
        meetingId,
        kind,
        bytes: sealed,
        ifMatch: null,
      });
      expect(put.status).toBe(201);
      expect(put.body.revision).toBe(1);
    }

    // B pages the log from the start: exactly those eight, and each blob opens
    // under B's own copy of the key to the bytes A wrote.
    const bFirst = await client.changes(bToken, 0);
    expect(bFirst.status).toBe(200);
    expect(bFirst.body.hasMore).toBe(false);
    const seen = bFirst.body.changes!;
    expect(seen).toHaveLength(8);
    expect(seen.map((c) => c.kind).sort()).toEqual([...kinds].sort());
    expect(seen.every((c) => c.meetingId === meetingId && c.revision === 1 && !c.deleted)).toBe(
      true
    );
    expect(seen.every((c) => c.deviceId === a.deviceId)).toBe(true);
    for (const change of seen) {
      const got = await client.getMeetingBlob({ token: bToken, meetingId, kind: change.kind });
      expect(got.status).toBe(200);
      expect(got.sha256).toBe(change.sha256);
      const opened = open(bLibraryKey, got.bytes, blobAad(a.libraryId, meetingId, change.kind, 1));
      expect(opened.equals(plaintexts.get(change.kind)!)).toBe(true);
    }
    const bLastSeq = bFirst.body.nextSince!;
    expect(bLastSeq).toBe(Math.max(...seen.map((c) => c.seq)));

    // B renames a speaker: a new `labels` over revision 1.
    const labels = Buffer.from(JSON.stringify({ speakers: { S1: 'Ada' } }));
    const relabel = await client.putMeetingBlob({
      token: bToken,
      meetingId,
      kind: 'labels',
      bytes: seal(bLibraryKey, labels, blobAad(a.libraryId, meetingId, 'labels', 2)),
      ifMatch: 1,
    });
    expect(relabel.status).toBe(200);
    expect(relabel.body.revision).toBe(2);

    // A, polling from where B had read to, sees exactly that one change.
    const aNext = await client.changes(a.deviceToken, bLastSeq);
    expect(aNext.body.changes).toHaveLength(1);
    const [relabelled] = aNext.body.changes!;
    expect(relabelled).toMatchObject({
      meetingId,
      kind: 'labels',
      revision: 2,
      deleted: false,
      deviceId: enrolled.body.deviceId,
    });
    expect(relabelled!.seq).toBeGreaterThan(bLastSeq);
    const aLabels = await client.getMeetingBlob({
      token: a.deviceToken,
      meetingId,
      kind: 'labels',
    });
    expect(
      open(a.libraryKey, aLabels.bytes, blobAad(a.libraryId, meetingId, 'labels', 2)).equals(labels)
    ).toBe(true);

    // A uploads 40 MiB of microphone audio in 16 MiB parts: three of them.
    const audio = seal(
      a.libraryKey,
      crypto.randomBytes(40 * MiB),
      blobAad(a.libraryId, meetingId, 'audio-mic', 1)
    );
    const begun = await client.beginUpload(a.deviceToken, {
      meetingId,
      kind: 'audio-mic',
      size: audio.length,
      sha256: sha256(audio),
      partSize: 16 * MiB,
      ifMatch: null,
    });
    expect(begun.status).toBe(201);
    // Aborted at once: this session only proves the part arithmetic before
    // `client.upload` does the real thing below.
    const probe = await client.inspectUpload(a.deviceToken, begun.body.uploadId!);
    expect(probe.body.missing).toEqual([0, 1, 2]);
    expect((await client.abortUpload(a.deviceToken, begun.body.uploadId!)).status).toBe(204);
    const uploaded = await client.upload({
      token: a.deviceToken,
      meetingId,
      kind: 'audio-mic',
      bytes: audio,
      partSize: 16 * MiB,
      ifMatch: null,
    });
    expect(uploaded.status).toBe(201);
    expect(uploaded.body).toMatchObject({ revision: 1, sha256: sha256(audio), size: audio.length });

    // B lists the meeting and finds the audio with A's size and hash.
    const listed = await client.listMeetings(bToken);
    expect(listed.body.meetings).toHaveLength(1);
    const entry = listed.body.meetings![0]!;
    expect(entry.id).toBe(meetingId);
    expect(entry.blobs).toHaveLength(9);
    expect(entry.blobs.find((b) => b.kind === 'audio-mic')).toEqual({
      kind: 'audio-mic',
      revision: 1,
      sha256: sha256(audio),
      size: audio.length,
    });
    const storedFiles = blobFiles(h.blobsDir);
    // Nine files: the replaced `labels` revision 1 was released when 2 landed.
    expect(storedFiles).toHaveLength(9);
    const beforeDelete = await client.libraryInfo(a.deviceToken);
    expect(beforeDelete.body.storage).toMatchObject({ blobCount: 9, meetingCount: 1 });

    // A deletes the meeting; B's next poll carries the tombstone.
    const afterUpload = await client.changes(bToken, relabelled!.seq);
    expect(afterUpload.body.changes?.map((c) => c.kind)).toEqual(['audio-mic']);
    expect((await client.deleteMeeting(a.deviceToken, meetingId)).status).toBe(204);
    const tombstone = await client.changes(bToken, afterUpload.body.nextSince!);
    expect(tombstone.body.changes).toHaveLength(1);
    expect(tombstone.body.changes![0]).toMatchObject({
      meetingId,
      kind: 'meeting',
      deleted: true,
      deviceId: a.deviceId,
    });
    expect((await client.listMeetings(bToken)).body.meetings).toEqual([]);
    const inBin = await client.libraryInfo(a.deviceToken);
    expect(inBin.body.storage).toMatchObject({ meetingCount: 0, deletedMeetingCount: 1 });

    // Eight days on, the sweep collects the blobs and keeps the history.
    h.now.value += 8 * DAY_MS;
    const swept = await h.gc.sweep();
    expect(swept.purgedMeetings).toBe(1);
    expect(blobFiles(h.blobsDir)).toEqual([]);
    for (const file of storedFiles) expect(fs.existsSync(file)).toBe(false);
    const meetingRow = await h.prisma.meeting.findUnique({ where: { id: meetingId } });
    expect(meetingRow?.deletedAt).not.toBeNull();
    expect(await h.prisma.change.count()).toBe(8 + 1 + 1 + 1);
    expect(await h.prisma.blob.count()).toBe(0);
    const emptied = await client.libraryInfo(a.deviceToken);
    expect(emptied.body.storage).toEqual({
      blobBytes: 0,
      blobCount: 0,
      meetingCount: 0,
      deletedMeetingCount: 0,
    });
  }, 300_000);
});
