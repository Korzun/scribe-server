import * as crypto from 'crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { blobAad, seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

// A fresh vault per file, so the log starts empty and seq values are predictable in order.
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

describe('GET /api/v1/changes', () => {
  it('changes page in seq order with nextSince and hasMore', async () => {
    const id = crypto.randomUUID();
    const written: Array<{ kind: string; bytes: Buffer; at: number }> = [];
    for (const kind of ['manifest', 'transcript', 'diarization', 'labels', 'summary']) {
      h.now.value += 1000;
      const bytes = seal(
        owner.libraryKey,
        Buffer.from(kind),
        blobAad(owner.libraryId, id, kind, 1)
      );
      const res = await client.putMeetingBlob({
        token: owner.deviceToken,
        meetingId: id,
        kind,
        bytes,
        ifMatch: null,
      });
      expect(res.status).toBe(201);
      written.push({ kind, bytes, at: h.now.value });
    }

    const first = await client.changes(owner.deviceToken, 0, 2);
    expect(first.status).toBe(200);
    expect(first.body.changes).toHaveLength(2);
    expect(first.body.hasMore).toBe(true);
    expect(first.body.nextSince).toBe(first.body.changes![1]!.seq);
    expect(first.body.changes![0]).toEqual({
      seq: expect.any(Number),
      meetingId: id,
      kind: 'manifest',
      revision: 1,
      sha256: sha(written[0]!.bytes),
      size: written[0]!.bytes.length,
      deleted: false,
      deviceId: owner.deviceId,
      at: new Date(written[0]!.at).toISOString(),
    });

    const rows = [...first.body.changes!];
    let since = first.body.nextSince!;
    for (;;) {
      const page = await client.changes(owner.deviceToken, since, 2);
      rows.push(...page.body.changes!);
      if (!page.body.hasMore) {
        expect(page.body.nextSince).toBe(rows[rows.length - 1]!.seq);
        break;
      }
      since = page.body.nextSince!;
    }

    expect(rows.map((r) => r.kind)).toEqual(written.map((w) => w.kind));
    const seqs = rows.map((r) => r.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));

    // Caught up: an empty page keeps the caller where it is.
    const caughtUp = await client.changes(owner.deviceToken, since + 1000);
    expect(caughtUp.body).toEqual({ changes: [], nextSince: since + 1000, hasMore: false });

    // `since` defaults to 0, the whole log.
    const all = await client.changes(owner.deviceToken);
    expect(all.body.changes!.map((r) => r.seq)).toEqual(seqs);
  });

  it('limit above 1000 is clamped', async () => {
    await h.prisma.change.createMany({
      data: Array.from({ length: 1100 }, (_, i) => ({
        meetingId: crypto.randomUUID(),
        kind: 'manifest',
        revision: 1,
        sha256: sha(Buffer.from(String(i))),
        size: 1,
        deleted: false,
        deviceId: null,
        at: h.now.value,
      })),
    });

    const res = await client.changes(owner.deviceToken, 0, 5000);
    expect(res.status).toBe(200);
    expect(res.body.changes).toHaveLength(1000);
    expect(res.body.hasMore).toBe(true);

    const byDefault = await client.changes(owner.deviceToken, 0);
    expect(byDefault.body.changes).toHaveLength(500);
  });

  it('non-integer since or limit is 400', async () => {
    for (const [since, limit] of [
      ['abc', undefined],
      ['1.5', undefined],
      ['-1', undefined],
      [0, 'x'],
      [0, 0],
    ] as const) {
      const res = await client.changes(owner.deviceToken, since, limit);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
  });

  it('needs the owner', async () => {
    expect((await client.changes('')).status).toBe(401);
  });
});
