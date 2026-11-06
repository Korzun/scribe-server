import * as crypto from 'crypto';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { seal } from '../crypto/seal';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';

vi.mock('../logger');

const b64 = (n: number): string => crypto.randomBytes(n).toString('base64');
const wrap = (): string =>
  seal(crypto.randomBytes(32), crypto.randomBytes(32), 'aad').toString('base64');

// One owner (about eleven PBKDF2 runs) for the whole file; the tests run in order.
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

describe('recovery', () => {
  it('a recovery code unwraps the library key and sets a new password', async () => {
    const res = await client.recover({
      code: owner.recoveryCodes[0]!,
      secretKey: owner.secretKey,
      newPassword: 'recovered password',
    });

    expect(res.status).toBe(204);
    expect(res.libraryKey!.equals(owner.libraryKey)).toBe(true);
    expect((await client.login(owner)).status).toBe(401);
    expect(
      (await client.login({ password: 'recovered password', secretKey: owner.secretKey })).status
    ).toBe(200);
  });

  it('a used recovery code is 401 the second time', async () => {
    const again = await client.recover({
      code: owner.recoveryCodes[0]!,
      secretKey: owner.secretKey,
      newPassword: 'another',
    });

    expect(again.status).toBe(401);
    expect(again.body).toEqual({ error: 'Invalid credentials' });
  });

  it('recovery leaves device tokens valid and drops browser sessions', async () => {
    await client.login({ password: 'recovered password', secretKey: owner.secretKey });
    const stale = client.refreshCookie;

    const res = await client.recover({
      code: owner.recoveryCodes[1]!,
      secretKey: owner.secretKey,
      newPassword: 'recovered again',
    });

    expect(res.status).toBe(204);
    expect((await client.devices(owner.deviceToken)).status).toBe(200);
    expect((await client.refresh(stale)).status).toBe(401);
  });

  it('library info counts the unused codes', async () => {
    const info = await client.libraryInfo(owner.deviceToken);

    expect(info.body.recoveryCodesRemaining).toBe(8);
  });

  it('malformed bodies are 400 and an unmatched key is 401', async () => {
    expect((await client.postRecovery({ authKey: 'short' })).status).toBe(400);
    expect((await client.postRecovery({ authKey: b64(32) })).status).toBe(401);
    expect((await client.postRecoveryPassword('some-id', { authKey: b64(32) })).status).toBe(400);
  });

  it('an unknown recovery id is 404 and a wrong key on a real id is 401', async () => {
    const real = (await h.prisma.recoveryCode.findFirstOrThrow({ where: { usedAt: null } })).id;
    const body = {
      authKey: b64(32),
      newPasswordSalt: b64(16),
      newAuthKey: b64(32),
      newPasswordWrap: wrap(),
    };

    expect((await client.postRecoveryPassword('no-such-id', body)).status).toBe(404);
    expect((await client.postRecoveryPassword(real, body)).status).toBe(401);
  });

  it('is rate limited to 10 per minute per IP', async () => {
    let limited = false;
    for (let i = 0; i < 20 && !limited; i++) {
      limited = (await client.postRecovery({ authKey: b64(32) })).status === 429;
    }
    expect(limited).toBe(true);
  });
});
