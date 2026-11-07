import * as crypto from 'crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { formatSecretKey, generateSecretKey, parseSecretKey } from '../crypto/codes';
import { deriveAccountKeys } from '../crypto/kdf';
import { keyWrapAad, open } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

// One owner (about eleven PBKDF2 runs) for the whole file.
let h: Harness;
let client: VaultClient;
let owner: Owner;
beforeAll(async () => {
  h = await createHarness();
  client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code', name: 'First Mac' });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const enrol = (name: string, secretKey = owner.secretKey) =>
  client.enrol({ password: owner.password, secretKey, name });

describe('POST /api/v1/devices', () => {
  it('enrolling with the right password and secret key returns the wrapped library key the first Mac stored', async () => {
    const res = await enrol('Second Mac');

    expect(res.status).toBe(201);
    expect(res.body.libraryId).toBe(owner.libraryId);
    expect(res.body.deviceToken).toBeTruthy();
    const { kek } = deriveAccountKeys({
      secret: Buffer.from(owner.password, 'utf8'),
      secretKey: parseSecretKey(owner.secretKey)!,
      salt: Buffer.from(res.body.passwordSalt!, 'base64'),
    });
    const unwrapped = open(
      kek,
      Buffer.from(res.body.passwordWrap!, 'base64'),
      keyWrapAad(owner.libraryId, 'password')
    );
    expect(unwrapped.equals(owner.libraryKey)).toBe(true);
    expect((await client.devices(res.body.deviceToken!)).status).toBe(200);
  });

  it('a wrong secret key with the right password is 401', async () => {
    const res = await enrol('Intruder', formatSecretKey(generateSecretKey()));

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('malformed bodies are 400', async () => {
    const good = crypto.randomBytes(32).toString('base64');
    const bad = [
      { authKey: 'not base64!', name: 'x' },
      { authKey: good, name: '' },
      { authKey: good, name: 'x'.repeat(65) },
      { authKey: crypto.randomBytes(31).toString('base64'), name: 'x' },
      {},
    ];
    for (const body of bad) {
      const res = await client.postDevice(body);
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
  });
});

describe('device management', () => {
  it('the device list marks the caller as current', async () => {
    const second = await enrol('Listed Mac');
    const res = await client.devices(second.body.deviceToken!);

    expect(res.status).toBe(200);
    expect(res.body.devices!.filter((d) => d.isCurrent).map((d) => d.name)).toEqual(['Listed Mac']);
    const created = res.body.devices!.map((d) => d.createdAt);
    expect([...created].sort((a, b) => a - b)).toEqual(created);
  });

  it('a revoked device is listed with revokedAt and its token is 401 on the next call', async () => {
    const second = await enrol('Doomed Mac');
    const token = second.body.deviceToken!;
    const id = second.body.deviceId!;

    h.now.value += 1000;
    expect((await client.revokeDevice(owner.deviceToken, id)).status).toBe(204);
    const stamp = h.now.value;
    h.now.value += 5000;
    // Idempotent: a second revoke is 204 and does not move the timestamp.
    expect((await client.revokeDevice(owner.deviceToken, id)).status).toBe(204);

    const list = await client.devices(owner.deviceToken);
    expect(list.body.devices!.find((d) => d.id === id)?.revokedAt).toBe(stamp);
    expect((await client.devices(token)).status).toBe(401);
    expect((await client.renameDevice(owner.deviceToken, id, 'New')).status).toBe(409);
  });

  it('renames a device, and unknown ids are 404', async () => {
    const renamed = await client.renameDevice(owner.deviceToken, owner.deviceId, 'Studio Mac');
    expect(renamed.status).toBe(200);
    expect(renamed.body).toEqual({ id: owner.deviceId, name: 'Studio Mac' });

    expect((await client.renameDevice(owner.deviceToken, 'nope', 'x')).status).toBe(404);
    expect((await client.revokeDevice(owner.deviceToken, 'nope')).status).toBe(404);
    expect((await client.renameDevice(owner.deviceToken, owner.deviceId, '')).status).toBe(400);
  });

  it('a device may revoke itself', async () => {
    const me = await enrol('Self');
    expect((await client.revokeDevice(me.body.deviceToken!, me.body.deviceId!)).status).toBe(204);
    expect((await client.devices(me.body.deviceToken!)).status).toBe(401);
  });
});

describe('enrolment rate limit', () => {
  it('enrolment is rate limited at the eleventh attempt in a minute', async () => {
    const lim = await createHarness();
    try {
      const limited = new VaultClient(lim.app);
      const body = { authKey: crypto.randomBytes(32).toString('base64'), name: 'x' };
      // No library exists here: each attempt is a cheap 404 but still counts.
      for (let i = 0; i < 10; i++) expect((await limited.postDevice(body)).status).toBe(404);
      expect((await limited.postDevice(body)).status).toBe(429);
    } finally {
      await lim.close();
    }
  });
});
