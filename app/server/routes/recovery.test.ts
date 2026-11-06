import * as crypto from 'crypto';

import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { parseRecoveryCode, parseSecretKey } from '../crypto/codes';
import { deriveAccountKeys } from '../crypto/kdf';
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
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code' });
}, 60_000);
afterAll(async () => {
  await h.close();
});

describe('recovery', () => {
  // The earlier tests spend the per-minute budget; a new minute per test keeps
  // the limiter out of the way (the rate-limit test below has its own harness).
  beforeEach(() => {
    h.now.value += 120_000;
  });

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

  /** The recovery auth key a client derives from `code` (spec §3). */
  async function recoveryAuthKey(code: string): Promise<string> {
    const salts = await client.salts();
    return deriveAccountKeys({
      secret: parseRecoveryCode(code)!,
      secretKey: parseSecretKey(owner.secretKey)!,
      salt: Buffer.from(salts.body.recoverySalt!, 'base64'),
    }).authKey.toString('base64');
  }

  const material = () => ({
    newPasswordSalt: b64(16),
    newAuthKey: b64(32),
    newPasswordWrap: wrap(),
  });

  it('step two refuses an already used code even with its correct key, changing nothing', async () => {
    const used = await h.prisma.recoveryCode.findFirstOrThrow({ where: { usedAt: { not: null } } });
    const before = await h.prisma.library.findFirstOrThrow();

    const res = await client.postRecoveryPassword(used.id, {
      authKey: await recoveryAuthKey(owner.recoveryCodes[0]!),
      ...material(),
    });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({ error: 'Invalid credentials' });
    const after = await h.prisma.library.findFirstOrThrow();
    expect(Buffer.from(after.passwordWrap).equals(Buffer.from(before.passwordWrap))).toBe(true);
    expect(after.authVerifier).toBe(before.authVerifier);
    expect(Buffer.from(after.passwordSalt).equals(Buffer.from(before.passwordSalt))).toBe(true);
  });

  it('two concurrent uses of one fresh code succeed exactly once', async () => {
    const authKey = await recoveryAuthKey(owner.recoveryCodes[2]!);
    const found = await client.postRecovery({ authKey });
    const id = found.body.recoveryId!;

    const results = await Promise.all([
      client.postRecoveryPassword(id, { authKey, ...material() }),
      client.postRecoveryPassword(id, { authKey, ...material() }),
    ]);

    expect(results.map((r) => r.status).sort()).toEqual([204, 401]);
    const row = await h.prisma.recoveryCode.findUniqueOrThrow({ where: { id } });
    expect(row.usedAt).toBe(h.now.value);
  });
});

describe('recovery rate limit', () => {
  it('the eleventh request in a minute is the first 429', async () => {
    const fresh = await createHarness();
    try {
      const c = new VaultClient(fresh.app);
      const statuses: number[] = [];
      for (let i = 0; i < 11; i++)
        statuses.push((await c.postRecovery({ authKey: b64(32) })).status);

      expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
      expect(statuses[10]).toBe(429);
    } finally {
      await fresh.close();
    }
  });
});
