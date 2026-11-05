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
    ...overrides,
  };
}

describe('createLibrary', () => {
  it('stores argon2id verifiers of the auth keys, never the keys', async () => {
    const i = input();

    await createLibrary(h.prisma, i);

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
    await createLibrary(h.prisma, input());

    await expect(createLibrary(h.prisma, input())).rejects.toBeInstanceOf(LibraryExistsError);
    expect(await h.prisma.library.count()).toBe(1);
  });

  it('requires exactly ten recovery codes and stores nothing otherwise', async () => {
    const base = input();

    await expect(
      createLibrary(h.prisma, { ...base, recoveryCodes: base.recoveryCodes.slice(0, 9) })
    ).rejects.toThrow(/ten recovery codes/i);
    expect(await h.prisma.library.count()).toBe(0);
  });

  it('getLibrary returns the row or null', async () => {
    expect(await getLibrary(h.prisma)).toBeNull();
    const i = input();
    await createLibrary(h.prisma, i);

    expect((await getLibrary(h.prisma))?.id).toBe(i.libraryId);
  });
});
