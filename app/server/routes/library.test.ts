import * as crypto from 'crypto';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import {
  createOwner,
  VaultClient,
  writeSetupCode,
  type CreateLibraryRequest,
} from '../test-support/vault-client';

vi.mock('../logger');

let h: Harness;
let client: VaultClient;
beforeEach(async () => {
  h = await createHarness();
  client = new VaultClient(h.app);
});
afterEach(async () => {
  await h.close();
});

const b64 = (n: number): string => crypto.randomBytes(n).toString('base64');
/** A correctly shaped wrap: a real sealed blob of a random 32-byte key. */
const wrap = (): string =>
  seal(crypto.randomBytes(32), crypto.randomBytes(32), 'aad').toString('base64');

/** A well-formed body with random bytes: the server cannot tell it from real keys, and it costs no PBKDF2. */
function cheapBody(setupCode: string): CreateLibraryRequest {
  return {
    setupCode,
    libraryId: crypto.randomUUID(),
    passwordSalt: b64(16),
    recoverySalt: b64(16),
    authKey: b64(32),
    passwordWrap: wrap(),
    recoveryCodes: Array.from({ length: 10 }, () => ({ authKey: b64(32), wrap: wrap() })),
    device: { name: 'Test Mac' },
  };
}

describe('POST /api/v1/library', () => {
  it('creating a library without setup_code configured is 403', async () => {
    writeSetupCode(h.dataDir, null);

    const res = await client.createLibrary(cheapBody('anything'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Setup code required' });
    expect(await h.prisma.library.count()).toBe(0);
  });

  it('creating with the wrong setup code is 403 and stores nothing', async () => {
    writeSetupCode(h.dataDir, 'the-real-code');

    const res = await client.createLibrary(cheapBody('a-wrong-code'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Wrong setup code' });
    expect(await h.prisma.library.count()).toBe(0);
    expect(await h.prisma.device.count()).toBe(0);
    expect((await client.status()).body.libraryExists).toBe(false);
  });

  it('a setup code of a different length is simply wrong', async () => {
    writeSetupCode(h.dataDir, 'short');

    const res = await client.createLibrary(cheapBody('a-much-longer-guess'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Wrong setup code' });
  });

  it('a malformed body is 400', async () => {
    writeSetupCode(h.dataDir, 'code');
    const body = cheapBody('code');

    const missing = await client.createLibrary({ ...body, device: undefined });
    const notTen = await client.createLibrary({
      ...body,
      recoveryCodes: body.recoveryCodes.slice(0, 9),
    });
    const notBase64 = await client.createLibrary({ ...body, authKey: '***' });

    const tiny = await client.createLibrary({ ...body, passwordWrap: b64(1) });
    // Right length (4+1+12+32+16 = 65) but not a sealed blob.
    const unsealed = await client.createLibrary({ ...body, passwordWrap: b64(65) });
    const badRecoveryWrap = await client.createLibrary({
      ...body,
      recoveryCodes: [{ authKey: b64(32), wrap: b64(65) }, ...body.recoveryCodes.slice(1)],
    });

    for (const res of [missing, notTen, notBase64, tiny, unsealed, badRecoveryWrap]) {
      expect(res.status).toBe(400);
      expect(res.body).toEqual({ error: 'Invalid request' });
    }
    expect(await h.prisma.library.count()).toBe(0);
  });

  it('creating with the right code returns a device token and status flips to libraryExists:true', async () => {
    writeSetupCode(h.dataDir, 'the-real-code');
    expect((await client.status()).body.libraryExists).toBe(false);

    const owner = await createOwner(client, { setupCode: 'the-real-code' });

    expect(owner.deviceToken).toEqual(expect.any(String));
    expect(owner.deviceId).toHaveLength(21);
    expect((await client.status()).body.libraryExists).toBe(true);
    expect(await h.prisma.recoveryCode.count()).toBe(10);
    // Only a hash of the token is at rest.
    const device = await h.prisma.device.findUniqueOrThrow({ where: { id: owner.deviceId } });
    expect(device.tokenHash).not.toBe(owner.deviceToken);
    expect(device.libraryId).toBe(owner.libraryId);
  });

  it('a second creation is 409', async () => {
    writeSetupCode(h.dataDir, 'the-real-code');
    expect((await client.createLibrary(cheapBody('the-real-code'))).status).toBe(201);

    const res = await client.createLibrary(cheapBody('the-real-code'));

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ error: 'Library exists' });
    expect(await h.prisma.library.count()).toBe(1);
    expect(await h.prisma.device.count()).toBe(1);
  });

  it('the setup code is re-read: changing options.json between two attempts changes the outcome', async () => {
    writeSetupCode(h.dataDir, 'first-code');
    const body = cheapBody('second-code');
    expect((await client.createLibrary(body)).status).toBe(403);

    writeSetupCode(h.dataDir, 'second-code');
    const res = await client.createLibrary(body);

    expect(res.status).toBe(201);
  });

  it('is rate limited to 10 per minute per IP', async () => {
    writeSetupCode(h.dataDir, 'the-real-code');
    for (let i = 0; i < 10; i++) {
      expect((await client.createLibrary(cheapBody('nope'))).status).toBe(403);
    }

    const res = await client.createLibrary(cheapBody('nope'));

    expect(res.status).toBe(429);
  });
});

describe('GET /api/v1/library/salts', () => {
  it('is 404 before a library exists', async () => {
    const res = await client.salts();

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'No library' });
  });

  it('salts are readable without auth once a library exists', async () => {
    writeSetupCode(h.dataDir, 'the-real-code');
    const body = cheapBody('the-real-code');
    await client.createLibrary(body);

    const res = await client.salts();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ passwordSalt: body.passwordSalt, recoverySalt: body.recoverySalt });
  });

  it('is rate limited to 60 per minute per IP', async () => {
    for (let i = 0; i < 60; i++) await client.salts();

    expect((await client.salts()).status).toBe(429);
  });
});
