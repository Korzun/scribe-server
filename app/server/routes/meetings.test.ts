import * as crypto from 'crypto';
import { once } from 'events';
import * as fs from 'fs';
import * as http from 'http';
import type { AddressInfo } from 'net';
import * as path from 'path';

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

/** Seals `text` exactly as the Mac would for this meeting, kind and revision. */
function sealed(meetingId: string, kind: string, revision: number, text: string): Buffer {
  return seal(
    owner.libraryKey,
    Buffer.from(text, 'utf8'),
    blobAad(owner.libraryId, meetingId, kind, revision)
  );
}

/** Every file under blobsDir, as relative paths. */
function blobFiles(): string[] {
  return fs
    .readdirSync(h.blobsDir, { recursive: true, withFileTypes: true })
    .filter((e) => e.isFile())
    .map((e) => path.relative(h.blobsDir, path.join(e.parentPath, e.name)))
    .sort();
}

const fileFor = (sha256: string) => path.join(h.blobsDir, sha256.slice(0, 2), sha256);

const put = (meetingId: string, kind: string, bytes: Buffer, ifMatch?: number | null) =>
  client.putMeetingBlob({ token: owner.deviceToken, meetingId, kind, bytes, ifMatch });

describe('PUT /api/v1/meetings/:id/blobs/:kind', () => {
  it('first write needs If-None-Match and returns revision 1', async () => {
    const id = crypto.randomUUID();
    const bytes = sealed(id, 'manifest', 1, '{"title":"Standup"}');

    const withIfMatch = await put(id, 'manifest', bytes, 1);
    expect(withIfMatch.status).toBe(409);
    expect(withIfMatch.body).toEqual({ error: 'Revision conflict', currentRevision: 0 });

    const res = await put(id, 'manifest', bytes, null);
    expect(res.status).toBe(201);
    expect(res.body).toEqual({
      revision: 1,
      seq: expect.any(Number),
      sha256: sha(bytes),
      size: bytes.length,
    });
    expect(fs.readFileSync(fileFor(sha(bytes))).equals(bytes)).toBe(true);

    const again = await put(id, 'manifest', bytes, null);
    expect(again.status).toBe(409);
    expect(again.body).toEqual({ error: 'Revision conflict', currentRevision: 1 });

    const change = await h.prisma.change.findFirst({ where: { meetingId: id } });
    expect(change).toMatchObject({
      kind: 'manifest',
      revision: 1,
      sha256: sha(bytes),
      size: bytes.length,
      deleted: false,
      deviceId: owner.deviceId,
      at: h.now.value,
    });
  });

  it('second write with If-Match 1 returns revision 2 and a higher seq', async () => {
    const id = crypto.randomUUID();
    const first = await put(id, 'transcript', sealed(id, 'transcript', 1, 'one'), null);
    const second = await put(id, 'transcript', sealed(id, 'transcript', 2, 'two'), 1);

    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    expect(second.body.revision).toBe(2);
    expect(second.body.seq).toBeGreaterThan(first.body.seq!);
  });

  it('stale If-Match is 409 with currentRevision', async () => {
    const id = crypto.randomUUID();
    await put(id, 'labels', sealed(id, 'labels', 1, 'a'), null);
    await put(id, 'labels', sealed(id, 'labels', 2, 'b'), 1);

    const stale = await put(id, 'labels', sealed(id, 'labels', 2, 'c'), 1);
    expect(stale.status).toBe(409);
    expect(stale.body).toEqual({ error: 'Revision conflict', currentRevision: 2 });
  });

  it('accepts the quoted ETag form in If-Match', async () => {
    const id = crypto.randomUUID();
    await put(id, 'tags', sealed(id, 'tags', 1, 'a'), null);
    const bytes = sealed(id, 'tags', 2, 'b');
    const res = await request(h.app)
      .put(`/api/v1/meetings/${id}/blobs/tags`)
      .set('Authorization', `Bearer ${owner.deviceToken}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Scribe-Sha256', sha(bytes))
      .set('If-Match', '"1"')
      .send(bytes);

    expect(res.status).toBe(200);
    expect(res.body.revision).toBe(2);
  });

  it('a body whose hash differs from X-Scribe-Sha256 is 400 and leaves no blob row, file or change', async () => {
    const id = crypto.randomUUID();
    const bytes = sealed(id, 'summary', 1, 'the real summary');
    const filesBefore = blobFiles();
    const changesBefore = await h.prisma.change.count();

    const res = await client.putMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'summary',
      bytes,
      ifMatch: null,
      sha256: sha(Buffer.from('what the Mac meant to send')),
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Hash mismatch' });
    expect(await h.prisma.blob.count({ where: { scope: id } })).toBe(0);
    expect(await h.prisma.meeting.count({ where: { id } })).toBe(0);
    expect(await h.prisma.change.count()).toBe(changesBefore);
    expect(blobFiles()).toEqual(filesBefore);
  });

  it('plaintext JSON is 400 Not a sealed blob', async () => {
    const id = crypto.randomUUID();
    const filesBefore = blobFiles();

    const res = await put(id, 'manifest', Buffer.from('{"title":"in the clear"}'), null);

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Not a sealed blob' });
    expect(await h.prisma.blob.count({ where: { scope: id } })).toBe(0);
    expect(blobFiles()).toEqual(filesBefore);
  });

  it('missing both precondition headers is 412', async () => {
    const id = crypto.randomUUID();
    const bytes = sealed(id, 'manifest', 1, 'x');

    const neither = await put(id, 'manifest', bytes);
    expect(neither.status).toBe(412);
    expect(neither.body).toEqual({ error: 'Precondition required' });

    const both = await request(h.app)
      .put(`/api/v1/meetings/${id}/blobs/manifest`)
      .set('Authorization', `Bearer ${owner.deviceToken}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Scribe-Sha256', sha(bytes))
      .set('If-Match', '1')
      .set('If-None-Match', '*')
      .send(bytes);
    expect(both.status).toBe(412);

    const notANumber = await request(h.app)
      .put(`/api/v1/meetings/${id}/blobs/manifest`)
      .set('Authorization', `Bearer ${owner.deviceToken}`)
      .set('Content-Type', 'application/octet-stream')
      .set('X-Scribe-Sha256', sha(bytes))
      .set('If-Match', 'abc')
      .send(bytes);
    expect(notANumber.status).toBe(412);
    expect(await h.prisma.blob.count({ where: { scope: id } })).toBe(0);
  });

  it('unknown kinds, non-UUID ids, and a missing or malformed hash header are 400 Invalid request', async () => {
    const id = crypto.randomUUID();
    const bytes = sealed(id, 'manifest', 1, 'x');
    const filesBefore = blobFiles();

    for (const [meetingId, kind] of [
      [id, 'notes'],
      [id, 'tag-list'],
      ['not-a-uuid', 'manifest'],
      [id.toUpperCase(), 'manifest'],
    ] as const) {
      const res = await put(meetingId, kind, bytes, null);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
    for (const header of ['', 'zz', sha(bytes).toUpperCase()]) {
      const res = await client.putMeetingBlob({
        token: owner.deviceToken,
        meetingId: id,
        kind: 'manifest',
        bytes,
        ifMatch: null,
        sha256: header,
      });
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
    const json = await client.putMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'manifest',
      bytes,
      ifMatch: null,
      contentType: 'application/json',
    });
    expect(json.status).toBe(400);
    expect(blobFiles()).toEqual(filesBefore);
  });

  it('a tombstoned meeting is 410', async () => {
    const id = crypto.randomUUID();
    await put(id, 'manifest', sealed(id, 'manifest', 1, 'x'), null);
    await h.prisma.meeting.update({ where: { id }, data: { deletedAt: h.now.value } });

    const res = await put(id, 'manifest', sealed(id, 'manifest', 2, 'y'), 1);
    expect(res.status).toBe(410);
    expect(res.body).toEqual({ error: 'Meeting deleted' });
    expect(
      (await h.prisma.blob.findUnique({ where: { scope_kind: { scope: id, kind: 'manifest' } } }))
        ?.revision
    ).toBe(1);
  });

  it('two concurrent PUTs with the same If-Match: one 200 and one 409, one change row', async () => {
    const id = crypto.randomUUID();
    await put(id, 'labels', sealed(id, 'labels', 1, 'base'), null);
    const before = await h.prisma.change.count({ where: { meetingId: id } });

    const [a, b] = await Promise.all([
      put(id, 'labels', sealed(id, 'labels', 2, 'mine'), 1),
      put(id, 'labels', sealed(id, 'labels', 2, 'theirs'), 1),
    ]);

    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const loser = a.status === 409 ? a : b;
    expect(loser.body).toEqual({ error: 'Revision conflict', currentRevision: 2 });
    expect(await h.prisma.change.count({ where: { meetingId: id } })).toBe(before + 1);
  });

  it('a session caller writes with no device id', async () => {
    const browser = new VaultClient(h.app);
    await browser.login({ password: owner.password, secretKey: owner.secretKey });
    const id = crypto.randomUUID();

    const res = await client.putMeetingBlob({
      token: browser.asSession(),
      meetingId: id,
      kind: 'manifest',
      bytes: sealed(id, 'manifest', 1, 'x'),
      ifMatch: null,
    });

    expect(res.status).toBe(201);
    const row = await h.prisma.blob.findUnique({
      where: { scope_kind: { scope: id, kind: 'manifest' } },
    });
    expect(row?.deviceId).toBeNull();
    expect((await h.prisma.change.findFirst({ where: { meetingId: id } }))?.deviceId).toBeNull();
  });

  it('no credential is 401', async () => {
    const id = crypto.randomUUID();
    const res = await client.putMeetingBlob({
      token: '',
      meetingId: id,
      kind: 'manifest',
      bytes: sealed(id, 'manifest', 1, 'x'),
      ifMatch: null,
    });
    expect(res.status).toBe(401);
  });

  it('overwriting frees the old file unless another kind shares the hash', async () => {
    const id = crypto.randomUUID();
    // The same sealed bytes under two kinds: one file, two rows.
    const shared = sealed(id, 'markdown', 1, 'shared');
    await put(id, 'markdown', shared, null);
    await put(id, 'inferences', shared, null);

    await put(id, 'markdown', sealed(id, 'markdown', 2, 'replaced'), 1);
    expect(fs.existsSync(fileFor(sha(shared)))).toBe(true);

    const last = sealed(id, 'inferences', 2, 'replaced too');
    await put(id, 'inferences', last, 1);
    expect(fs.existsSync(fileFor(sha(shared)))).toBe(false);
    expect(fs.existsSync(fileFor(sha(last)))).toBe(true);
  });
});

describe('GET /api/v1/meetings/:id/blobs/:kind', () => {
  it('GET returns the bytes with ETag and 304 on If-None-Match', async () => {
    const id = crypto.randomUUID();
    await put(id, 'summary', sealed(id, 'summary', 1, 'one'), null);
    const bytes = sealed(id, 'summary', 2, 'two');
    await put(id, 'summary', bytes, 1);

    const res = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'summary',
    });
    expect(res.status).toBe(200);
    expect(res.bytes.equals(bytes)).toBe(true);
    expect(res.etag).toBe('"2"');
    expect(res.sha256).toBe(sha(bytes));
    expect(res.contentType).toBe('application/octet-stream');
    expect(res.contentLength).toBe(String(bytes.length));
    expect(
      open(owner.libraryKey, res.bytes, blobAad(owner.libraryId, id, 'summary', 2)).toString()
    ).toBe('two');

    const cached = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'summary',
      ifNoneMatch: '"2"',
    });
    expect(cached.status).toBe(304);
    expect(cached.bytes.length).toBe(0);

    const stale = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'summary',
      ifNoneMatch: '"1"',
    });
    expect(stale.status).toBe(200);
  });

  it('an absent blob is 404', async () => {
    const res = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId: crypto.randomUUID(),
      kind: 'summary',
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('a row whose file is gone answers 304 to a matching If-None-Match and 404 otherwise', async () => {
    const id = crypto.randomUUID();
    const bytes = sealed(id, 'summary', 1, 'orphan');
    await put(id, 'summary', bytes, null);
    fs.rmSync(fileFor(sha(bytes)));

    // The 304 never needs the file, so it must neither open it nor take the process down.
    const cached = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'summary',
      ifNoneMatch: '"1"',
    });
    expect(cached.status).toBe(304);

    // The file is opened before any header goes out, so a missing one is a clean 404.
    const res = await client.getMeetingBlob({
      token: owner.deviceToken,
      meetingId: id,
      kind: 'summary',
    });
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Not found' });
  });

  it('an aborted download closes the source stream', async () => {
    const id = crypto.randomUUID();
    // Large enough that the socket applies backpressure long before the end.
    await put(id, 'audio-mic', sealed(id, 'audio-mic', 1, 'x'.repeat(8 * 1024 * 1024)), null);

    const opened: fs.ReadStream[] = [];
    const real = h.blobStore.createReadStream;
    const spy = vi.spyOn(h.blobStore, 'createReadStream').mockImplementation((sha256) => {
      const stream = real(sha256);
      opened.push(stream);
      return stream;
    });
    const server = h.app.listen(0);
    try {
      await once(server, 'listening');
      const { port } = server.address() as AddressInfo;
      await new Promise<void>((resolve, reject) => {
        const req = http.get(
          {
            port,
            path: `/api/v1/meetings/${id}/blobs/audio-mic`,
            headers: { Authorization: `Bearer ${owner.deviceToken}` },
          },
          (res) => {
            expect(res.statusCode).toBe(200);
            res.once('data', () => {
              req.destroy();
              resolve();
            });
          }
        );
        req.on('error', (err) => {
          if (!req.destroyed) reject(err);
        });
      });

      expect(opened).toHaveLength(1);
      await vi.waitFor(() => expect(opened[0]!.destroyed).toBe(true), { timeout: 2000 });
    } finally {
      spy.mockRestore();
      server.closeAllConnections();
      server.close();
    }
  });
});

describe('GET /api/v1/meetings', () => {
  it('lists meetings in id order with their blobs, a page at a time', async () => {
    const ids = [crypto.randomUUID(), crypto.randomUUID(), crypto.randomUUID()];
    for (const id of ids) {
      await put(id, 'manifest', sealed(id, 'manifest', 1, id), null);
      await put(id, 'audio-mic', sealed(id, 'audio-mic', 1, 'flac'), null);
    }

    const seen: string[] = [];
    const entries = new Map<string, { createdAt: number; blobs: unknown }>();
    let after: string | undefined;
    for (;;) {
      const page = await client.listMeetings(owner.deviceToken, { after, limit: 2 });
      expect(page.status).toBe(200);
      expect(page.body.meetings!.length).toBeLessThanOrEqual(2);
      for (const m of page.body.meetings!) {
        seen.push(m.id);
        entries.set(m.id, m);
      }
      if (page.body.nextAfter === null) break;
      after = page.body.nextAfter!;
    }

    expect(seen).toEqual([...seen].sort());
    expect(new Set(seen).size).toBe(seen.length);
    for (const id of ids) {
      expect(entries.get(id)).toEqual({
        id,
        createdAt: h.now.value,
        blobs: [
          { kind: 'audio-mic', revision: 1, sha256: expect.any(String), size: expect.any(Number) },
          { kind: 'manifest', revision: 1, sha256: expect.any(String), size: expect.any(Number) },
        ],
      });
    }
  });

  it('omits deleted meetings, and GET /meetings/:id is 404 for them', async () => {
    const id = crypto.randomUUID();
    await put(id, 'manifest', sealed(id, 'manifest', 1, 'x'), null);
    expect((await client.getMeeting(owner.deviceToken, id)).status).toBe(200);

    await h.prisma.meeting.update({ where: { id }, data: { deletedAt: h.now.value } });

    const list = await client.listMeetings(owner.deviceToken, { limit: 500 });
    expect(list.body.meetings!.map((m) => m.id)).not.toContain(id);
    const one = await client.getMeeting(owner.deviceToken, id);
    expect(one.status).toBe(404);
    expect(one.body).toEqual({ error: 'Not found' });
  });

  it('GET /meetings/:id returns one entry', async () => {
    const id = crypto.randomUUID();
    const bytes = sealed(id, 'diarization', 1, 'x');
    await put(id, 'diarization', bytes, null);

    const res = await client.getMeeting(owner.deviceToken, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id,
      createdAt: h.now.value,
      blobs: [{ kind: 'diarization', revision: 1, sha256: sha(bytes), size: bytes.length }],
    });
    expect((await client.getMeeting(owner.deviceToken, crypto.randomUUID())).status).toBe(404);
  });

  it('bad paging parameters are 400', async () => {
    for (const opts of [{ limit: 'x' }, { limit: 0 }, { limit: '1.5' }, { after: 'nope' }]) {
      const res = await client.listMeetings(owner.deviceToken, opts);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
  });
});
