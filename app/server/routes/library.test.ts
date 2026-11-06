import * as crypto from 'crypto';

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseSecretKey } from '../crypto/codes';
import { deriveAccountKeys } from '../crypto/kdf';
import { keyWrapAad, open, seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import {
  createOwner,
  VaultClient,
  writeSetupCode,
  type CreateLibraryRequest,
  type Owner,
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

describe('account operations', () => {
  // One owner (about eleven PBKDF2 runs) for the describe; the tests run in
  // order and each leaves the vault in the state the next expects.
  let ah: Harness;
  let c: VaultClient;
  let owner: Owner;
  beforeAll(async () => {
    ah = await createHarness();
    c = new VaultClient(ah.app);
    writeSetupCode(ah.dataDir, 'code');
    owner = await createOwner(c, { setupCode: 'code' });
  }, 60_000);
  afterAll(async () => {
    await ah.close();
  });

  const NEW_PASSWORD = 'a brand new passphrase';

  it('GET /library reports the public material and the unused recovery codes', async () => {
    const res = await c.libraryInfo(owner.deviceToken);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe(owner.libraryId);
    expect(res.body.recoveryCodesRemaining).toBe(10);
    expect(res.body.storage).toEqual({
      blobBytes: 0,
      blobCount: 0,
      meetingCount: 0,
      deletedMeetingCount: 0,
    });
    expect(res.body.passwordSalt).toEqual(expect.any(String));
    expect(res.body.recoverySalt).toEqual(expect.any(String));
    expect(res.body.passwordWrap).toEqual(expect.any(String));
    expect((await c.libraryInfo('nope')).status).toBe(401);
  });

  it('a password change with a wrong current authKey is 401 and changes nothing', async () => {
    const before = await c.libraryInfo(owner.deviceToken);

    const res = await c.putPassword(owner.deviceToken, {
      authKey: b64(32),
      newPasswordSalt: b64(16),
      newAuthKey: b64(32),
      newPasswordWrap: wrap(),
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    expect((await c.libraryInfo(owner.deviceToken)).body.passwordWrap).toBe(
      before.body.passwordWrap
    );
  });

  it('a malformed password change is 400', async () => {
    const res = await c.putPassword(owner.deviceToken, { authKey: b64(32) });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
  });

  it('after a password change the old authKey is 401 and the new one logs in', async () => {
    expect((await c.login(owner)).status).toBe(200);
    const stale = c.refreshCookie;

    const changed = await c.changePassword({
      token: owner.deviceToken,
      password: owner.password,
      newPassword: NEW_PASSWORD,
      secretKey: owner.secretKey,
    });

    expect(changed.status).toBe(204);
    expect((await c.login(owner)).status).toBe(401);
    expect((await c.login({ ...owner, password: NEW_PASSWORD })).status).toBe(200);
    // The browser session that existed before the change is gone.
    expect((await c.refresh(stale)).status).toBe(401);
  });

  it('after a password change the existing device token still works', async () => {
    expect((await c.devices(owner.deviceToken)).status).toBe(200);
    expect((await c.libraryInfo(owner.deviceToken)).status).toBe(200);
  });

  it('after a password change the new wrap unwraps to the same library key', async () => {
    const info = await c.libraryInfo(owner.deviceToken);
    const { kek } = deriveAccountKeys({
      secret: Buffer.from(NEW_PASSWORD, 'utf8'),
      secretKey: parseSecretKey(owner.secretKey)!,
      salt: Buffer.from(info.body.passwordSalt!, 'base64'),
    });

    const key = open(
      kek,
      Buffer.from(info.body.passwordWrap!, 'base64'),
      keyWrapAad(owner.libraryId, 'password')
    );

    expect(key.equals(owner.libraryKey)).toBe(true);
  });

  it('regenerating with nine codes is 400', async () => {
    const res = await c.regenerateRecoveryCodes({
      token: owner.deviceToken,
      password: NEW_PASSWORD,
      secretKey: owner.secretKey,
      count: 9,
    });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Invalid request' });
    expect(await ah.prisma.recoveryCode.count()).toBe(10);
  });

  it('regenerating with a wrong authKey is 401', async () => {
    const res = await c.putRecoveryCodes(owner.deviceToken, {
      authKey: b64(32),
      recoverySalt: b64(16),
      codes: Array.from({ length: 10 }, () => ({ authKey: b64(32), wrap: wrap() })),
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
  });

  it('regenerating replaces all ten codes and old codes stop working', async () => {
    const oldIds = (await ah.prisma.recoveryCode.findMany()).map((r) => r.id);

    const res = await c.regenerateRecoveryCodes({
      token: owner.deviceToken,
      password: NEW_PASSWORD,
      secretKey: owner.secretKey,
    });

    expect(res.status).toBe(200);
    expect(res.codes).toHaveLength(10);
    expect(res.body.ids).toHaveLength(10);
    const newIds = (await ah.prisma.recoveryCode.findMany()).map((r) => r.id).sort();
    expect(newIds).toEqual([...res.body.ids!].sort());
    expect(newIds.some((id) => oldIds.includes(id))).toBe(false);

    const old = await c.recover({
      code: owner.recoveryCodes[0]!,
      secretKey: owner.secretKey,
      newPassword: 'x',
    });
    expect(old.status).toBe(401);
    const fresh = await c.recover({
      code: res.codes[0]!,
      secretKey: owner.secretKey,
      newPassword: 'recovered password',
    });
    expect(fresh.status).toBe(204);
  });
});
