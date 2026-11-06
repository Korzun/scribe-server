import * as crypto from 'crypto';
import * as fs from 'fs';

import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { blobAad, open, seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

let h: Harness;
let client: VaultClient;
let owner: Owner;
beforeAll(async () => {
  h = await createHarness();
  client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'code');
  owner = await createOwner(client, { setupCode: 'code' });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');

/** Seals `text` as the Mac would for a library-wide kind and revision. */
function sealed(kind: string, revision: number, text: string): Buffer {
  return seal(
    owner.libraryKey,
    Buffer.from(text, 'utf8'),
    blobAad(owner.libraryId, 'library', kind, revision)
  );
}

const put = (kind: string, bytes: Buffer, ifMatch?: number | null) =>
  client.putLibraryBlob({ token: owner.deviceToken, kind, bytes, ifMatch });
const get = (kind: string, ifNoneMatch?: string) =>
  client.getLibraryBlob({ token: owner.deviceToken, kind, ifNoneMatch });

/** Every entry under blobsDir, recursively: the filesystem as the vault left it. */
const listing = () => fs.readdirSync(h.blobsDir, { recursive: true }).map(String).sort();

describe('PUT|GET /api/v1/library/blobs/{*kind}', () => {
  it('tag-list and voice/<uuid> round-trip with revisions', async () => {
    const voice = `voice/${crypto.randomUUID()}`;
    for (const kind of ['tag-list', voice]) {
      const one = sealed(kind, 1, `${kind} one`);
      const first = await put(kind, one, null);
      expect(first.status).toBe(201);
      expect(first.body).toEqual({
        revision: 1,
        seq: expect.any(Number),
        sha256: sha(one),
        size: one.length,
      });

      const conflict = await put(kind, sealed(kind, 1, 'again'), null);
      expect(conflict.status).toBe(409);
      expect(conflict.body).toEqual({ error: 'Revision conflict', currentRevision: 1 });

      const two = sealed(kind, 2, `${kind} two`);
      const second = await put(kind, two, 1);
      expect(second.status).toBe(200);
      expect(second.body.revision).toBe(2);
      expect(second.body.seq).toBeGreaterThan(first.body.seq!);

      const res = await get(kind);
      expect(res.status).toBe(200);
      expect(res.etag).toBe('"2"');
      expect(res.sha256).toBe(sha(two));
      expect(res.contentType).toBe('application/octet-stream');
      expect(
        open(owner.libraryKey, res.bytes, blobAad(owner.libraryId, 'library', kind, 2)).toString()
      ).toBe(`${kind} two`);
      expect((await get(kind, '"2"')).status).toBe(304);

      const change = await h.prisma.change.findFirst({ where: { seq: second.body.seq } });
      expect(change).toMatchObject({ meetingId: null, kind, revision: 2, deleted: false });
    }
  });

  it('an uppercase voice id names the same blob as the lowercase one, and the log carries lowercase', async () => {
    const voiceId = crypto.randomUUID();
    const bytes = sealed(`voice/${voiceId}`, 1, 'voiceprint');

    const res = await put(`voice/${voiceId.toUpperCase()}`, bytes, null);
    expect(res.status).toBe(201);

    const lower = await get(`voice/${voiceId}`);
    expect(lower.status).toBe(200);
    expect(lower.bytes.equals(bytes)).toBe(true);
    const change = await h.prisma.change.findFirst({ where: { seq: res.body.seq } });
    expect(change?.kind).toBe(`voice/${voiceId}`);
    expect((await put(`voice/${voiceId}`, sealed(`voice/${voiceId}`, 2, 'v2'), 1)).status).toBe(
      200
    );
  });

  it('voice/../x, voice/not-a-uuid, and an empty kind are 400 and nothing is written under blobsDir', async () => {
    const bytes = sealed('tag-list', 1, 'x');
    const before = listing();
    const rowsBefore = await h.prisma.blob.count();

    for (const kind of [
      'voice/../x',
      'voice/..%2Fx',
      'voice/not-a-uuid',
      '',
      'voice',
      'voice/',
      `voice/${crypto.randomUUID()}/x`,
      'manifest',
    ]) {
      const res = await put(kind, bytes, null);
      expect(res.status, kind).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
      const got = await get(kind);
      expect(got.status, kind).toBe(400);
      expect(got.body).toEqual({ error: 'Invalid request' });
    }
    expect(listing()).toEqual(before);
    expect(await h.prisma.blob.count()).toBe(rowsBefore);
  });

  it('shares the meeting routes header rules: 412 without a precondition, 400 on a bad hash or plaintext', async () => {
    const kind = `voice/${crypto.randomUUID()}`;
    const bytes = sealed(kind, 1, 'x');
    expect((await put(kind, bytes)).status).toBe(412);
    const mismatch = await client.putLibraryBlob({
      token: owner.deviceToken,
      kind,
      bytes,
      ifMatch: null,
      sha256: sha(Buffer.from('other')),
    });
    expect(mismatch.status).toBe(400);
    expect(mismatch.body).toEqual({ error: 'Hash mismatch' });
    const plain = await put(kind, Buffer.from('{"plain":true}'), null);
    expect(plain.status).toBe(400);
    expect(plain.body).toEqual({ error: 'Not a sealed blob' });
    expect((await get(kind)).status).toBe(404);
  });

  it('no credential is 401', async () => {
    const res = await request(h.app).get('/api/v1/library/blobs/tag-list');
    expect(res.status).toBe(401);
  });
});

describe('DELETE /api/v1/library/blobs/voice/:voiceId', () => {
  it('deleting a voice appends a deleted change and GET is 404', async () => {
    const voiceId = crypto.randomUUID();
    const kind = `voice/${voiceId}`;
    await put(kind, sealed(kind, 1, 'one'), null);
    const two = sealed(kind, 2, 'two');
    await put(kind, two, 1);
    const lastSeq = (await h.prisma.change.findFirst({ orderBy: { seq: 'desc' } }))!.seq;

    const res = await client.deleteVoice(owner.deviceToken, voiceId.toUpperCase());
    expect(res.status).toBe(204);

    const changes = await h.prisma.change.findMany({ where: { seq: { gt: lastSeq } } });
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      meetingId: null,
      kind,
      revision: 2,
      deleted: true,
      deviceId: owner.deviceId,
      at: h.now.value,
    });
    expect(await h.prisma.blob.count({ where: { scope: 'library', kind } })).toBe(0);
    expect(await h.blobStore.exists(sha(two))).toBe(false);

    const got = await get(kind);
    expect(got.status).toBe(404);
    expect(got.body).toEqual({ error: 'Not found' });

    const again = await client.deleteVoice(owner.deviceToken, voiceId);
    expect(again.status).toBe(404);
    expect(await h.prisma.change.count({ where: { seq: { gt: lastSeq } } })).toBe(1);
  });

  it('a voice sharing its bytes with another blob keeps the file', async () => {
    const a = `voice/${crypto.randomUUID()}`;
    const b = `voice/${crypto.randomUUID()}`;
    const shared = sealed(a, 1, 'same');
    await put(a, shared, null);
    await put(b, shared, null);

    expect((await client.deleteVoice(owner.deviceToken, a.slice('voice/'.length))).status).toBe(
      204
    );
    expect(await h.blobStore.exists(sha(shared))).toBe(true);
    expect((await get(b)).bytes.equals(shared)).toBe(true);
  });

  it('deleting tag-list is 405', async () => {
    if ((await get('tag-list')).status === 404)
      await put('tag-list', sealed('tag-list', 1, 't'), null);
    const before = await h.prisma.change.count();

    const res = await client.deleteLibraryBlob(owner.deviceToken, 'tag-list');
    expect(res.status).toBe(405);
    expect(res.body).toEqual({ error: 'Method not allowed' });
    expect(await h.prisma.change.count()).toBe(before);
    expect((await get('tag-list')).status).toBe(200);
  });

  it('a malformed voice id is 400', async () => {
    for (const kind of ['voice/not-a-uuid', 'voice/../x', 'nope']) {
      const res = await client.deleteLibraryBlob(owner.deviceToken, kind);
      expect(res.status, kind).toBe(400);
    }
  });
});
