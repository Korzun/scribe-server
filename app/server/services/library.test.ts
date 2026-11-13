import * as crypto from 'crypto';

import * as argon2 from 'argon2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createHarness, type Harness } from '../test-support/harness';
import {
  createLibrary,
  getLibrary,
  LibraryExistsError,
  verifyOwner,
  type CreateLibraryInput,
} from './library';

vi.mock('../logger');

let h: Harness;
beforeEach(async () => {
  h = await createHarness();
});
afterEach(async () => {
  await h.close();
});

function input(overrides: Partial<CreateLibraryInput> = {}): CreateLibraryInput {
  return {
    libraryId: crypto.randomUUID(),
    passwordSalt: crypto.randomBytes(16),
    recoverySalt: crypto.randomBytes(16),
    authKey: crypto.randomBytes(32),
    passwordWrap: crypto.randomBytes(60),
    recoveryCodes: Array.from({ length: 10 }, () => ({
      authKey: crypto.randomBytes(32),
      wrap: crypto.randomBytes(60),
    })),
    device: { name: 'Mac' },
    ...overrides,
  };
}

type Tx = Record<string | symbol, unknown>;

describe('createLibrary', () => {
  it('stores argon2id verifiers of the auth keys, never the keys', async () => {
    const i = input();

    await createLibrary(h.prisma, i, h.now.value);

    const row = await h.prisma.library.findUniqueOrThrow({ where: { id: i.libraryId } });
    expect(row.authVerifier).toMatch(/^\$argon2id\$/);
    expect(await argon2.verify(row.authVerifier, i.authKey.toString('base64'))).toBe(true);
    expect(await verifyOwner(h.prisma, i.authKey)).toBe(true);
    expect(await verifyOwner(h.prisma, crypto.randomBytes(32))).toBe(false);
    const codes = await h.prisma.recoveryCode.findMany();
    expect(codes).toHaveLength(10);
    expect(
      await argon2.verify(codes[0].authVerifier, i.recoveryCodes[0].authKey.toString('base64'))
    ).toBe(true);
    expect(codes[0].usedAt).toBeNull();
    expect(codes[0].id).toHaveLength(21);
  });

  it('refuses a second library with LibraryExistsError', async () => {
    await createLibrary(h.prisma, input(), h.now.value);

    await expect(createLibrary(h.prisma, input(), h.now.value)).rejects.toBeInstanceOf(
      LibraryExistsError
    );
    expect(await h.prisma.library.count()).toBe(1);
  });

  it('requires exactly ten recovery codes and stores nothing otherwise', async () => {
    const base = input();

    await expect(
      createLibrary(
        h.prisma,
        { ...base, recoveryCodes: base.recoveryCodes.slice(0, 9) },
        h.now.value
      )
    ).rejects.toThrow(/ten recovery codes/i);
    expect(await h.prisma.library.count()).toBe(0);
  });

  it('creates the first device in the same transaction, using the injected clock', async () => {
    const i = input();

    const { deviceId, token } = await createLibrary(h.prisma, i, 12_345);
    expect(deviceId).toBeDefined();
    expect(token).toBeDefined();

    const device = await h.prisma.device.findUniqueOrThrow({ where: { id: deviceId } });
    expect(device).toMatchObject({ libraryId: i.libraryId, name: 'Mac', createdAt: 12_345 });
    expect(device.tokenHash).toBe(crypto.createHash('sha256').update(token!).digest('hex'));
    expect(
      (await h.prisma.library.findUniqueOrThrow({ where: { id: i.libraryId } })).createdAt
    ).toBe(12_345);
  });

  it('rolls everything back when the device insert fails, so setup can be retried', async () => {
    const realTransaction = h.prisma.$transaction.bind(h.prisma) as (
      fn: (tx: Tx) => Promise<unknown>
    ) => Promise<unknown>;
    vi.spyOn(h.prisma, '$transaction').mockImplementation(((fn: (tx: Tx) => Promise<unknown>) =>
      realTransaction((tx: Tx) =>
        fn(
          new Proxy(tx, {
            get: (target, prop) =>
              prop === 'device'
                ? {
                    create: () => {
                      throw new Error('device insert failed');
                    },
                  }
                : target[prop],
          })
        )
      )) as never);

    await expect(createLibrary(h.prisma, input(), h.now.value)).rejects.toThrow(
      'device insert failed'
    );

    expect(await h.prisma.library.count()).toBe(0);
    expect(await h.prisma.recoveryCode.count()).toBe(0);
    expect(await h.prisma.device.count()).toBe(0);
  });

  it('getLibrary returns the row or null', async () => {
    expect(await getLibrary(h.prisma)).toBeNull();
    const i = input();
    await createLibrary(h.prisma, i, h.now.value);

    expect((await getLibrary(h.prisma))?.id).toBe(i.libraryId);
  });
});
