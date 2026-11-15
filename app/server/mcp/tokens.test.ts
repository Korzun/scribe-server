import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { SealError } from '../crypto/seal';
import { newTokenSecret } from '../crypto/token-kek';
import { createHarness, type Harness } from '../test-support/harness';
import { createOwner, VaultClient, writeSetupCode, type Owner } from '../test-support/vault-client';
import { createClientRow, mintBrowserCode, mintTokens } from './test-support';
import {
  ACCESS_TOKEN_TTL_MS,
  CODE_TTL_MS,
  consumeAuthorizationCode,
  consumeRefreshToken,
  createAuthorizationCode,
  deleteGrant,
  issueTokens,
  listGrants,
  lookupAccessToken,
  openWrap,
  peekAuthorizationCode,
  REFRESH_TOKEN_TTL_MS,
  resolveGrantedScopes,
  sweepExpired,
  TokenRejectedError,
  touchGrant,
  UNGRANTED_CLIENT_TTL_MS,
  upsertGrant,
  withLibraryKey,
} from './tokens';

// One owner (eleven PBKDF2 runs) for the whole file.
let h: Harness;
let owner: Owner;
beforeAll(async () => {
  h = await createHarness();
  const client = new VaultClient(h.app);
  writeSetupCode(h.dataDir, 'test-setup-code');
  owner = await createOwner(client, { setupCode: 'test-setup-code' });
}, 60_000);
afterAll(async () => {
  await h.close();
});

const T0 = 1_700_000_000_000;

beforeEach(async () => {
  await h.prisma.mcpGrant.deleteMany();
  await h.prisma.mcpClient.deleteMany();
});

const REDIRECT = 'https://client.example/callback';

/** A grant for `clientId` plus a browser-minted code stored against it. */
async function grantWithCode(clientId = 'c1', now = T0) {
  await createClientRow(h.prisma, clientId);
  const grant = await upsertGrant(
    h.prisma,
    { libraryId: owner.libraryId, clientId, scopes: ['library:read'] },
    now
  );
  const minted = mintBrowserCode(owner.libraryKey, owner.libraryId);
  await createAuthorizationCode(
    h.prisma,
    {
      grantId: grant.id,
      redirectUri: REDIRECT,
      codeChallenge: 'challenge',
      resource: null,
      codeHash: minted.codeHash,
      wrap: minted.wrap,
    },
    now
  );
  return { grant, code: minted.code };
}

describe('resolveGrantedScopes', () => {
  it('grants library:read when nothing or the known scope is asked for, and refuses unknown-only', () => {
    expect(resolveGrantedScopes(undefined)).toEqual(['library:read']);
    expect(resolveGrantedScopes([])).toEqual(['library:read']);
    expect(resolveGrantedScopes(['library:read', 'library:read'])).toEqual(['library:read']);
    expect(resolveGrantedScopes(['library:read', 'library:write'])).toEqual(['library:read']);
    expect(() => resolveGrantedScopes(['library:write'])).toThrow(RangeError);
  });
});

describe('authorization codes', () => {
  it('stores only the hash and a wrap that opens with the code and with nothing else', async () => {
    const { grant, code } = await grantWithCode();

    const rows = await h.prisma.mcpAuthorizationCode.findMany();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.codeHash).toBe(code.hash);
    expect(rows[0]!.grantId).toBe(grant.id);
    expect(JSON.stringify(rows[0])).not.toContain(code.wire);
    // The wrap is ciphertext, not the key.
    expect(Buffer.from(rows[0]!.wrap).includes(owner.libraryKey)).toBe(false);

    const opened = openWrap(code.wire, owner.libraryId, 'code', rows[0]!.wrap);
    expect(opened.equals(owner.libraryKey)).toBe(true);
    expect(() => openWrap(newTokenSecret().wire, owner.libraryId, 'code', rows[0]!.wrap)).toThrow(
      SealError
    );
    expect(() => openWrap(code.wire, owner.libraryId, 'access', rows[0]!.wrap)).toThrow(SealError);
  });

  it('peeks the challenge without consuming, then consumes exactly once', async () => {
    const { grant, code } = await grantWithCode();

    expect(await peekAuthorizationCode(h.prisma, code.wire, T0 + 1)).toEqual({
      codeChallenge: 'challenge',
      clientId: 'c1',
    });
    expect(await peekAuthorizationCode(h.prisma, 'nope', T0 + 1)).toBeNull();

    const consumed = await consumeAuthorizationCode(h.prisma, code.wire, T0 + 1);
    expect(consumed).toMatchObject({
      grantId: grant.id,
      clientId: 'c1',
      libraryId: owner.libraryId,
      scopes: ['library:read'],
      redirectUri: REDIRECT,
      resource: null,
    });
    expect(
      openWrap(code.wire, owner.libraryId, 'code', consumed!.wrap).equals(owner.libraryKey)
    ).toBe(true);
    expect(await consumeAuthorizationCode(h.prisma, code.wire, T0 + 1)).toBeNull();
    expect(await h.prisma.mcpAuthorizationCode.count()).toBe(0);
  });

  it('an expired code is deleted on consumption and reported absent', async () => {
    const { code } = await grantWithCode();
    expect(await peekAuthorizationCode(h.prisma, code.wire, T0 + CODE_TTL_MS)).toBeNull();
    expect(await consumeAuthorizationCode(h.prisma, code.wire, T0 + CODE_TTL_MS)).toBeNull();
    expect(await h.prisma.mcpAuthorizationCode.count()).toBe(0);
  });

  it('re-approving a client drops its codes and tokens', async () => {
    const { grant } = await grantWithCode();
    await issueTokens(
      h.prisma,
      {
        grantId: grant.id,
        libraryId: owner.libraryId,
        libraryKey: owner.libraryKey,
        scopes: ['library:read'],
      },
      T0
    );
    expect(await h.prisma.mcpToken.count()).toBe(2);

    const again = await upsertGrant(
      h.prisma,
      { libraryId: owner.libraryId, clientId: 'c1', scopes: ['library:read'] },
      T0 + 5
    );
    expect(again.id).toBe(grant.id);
    expect(await h.prisma.mcpToken.count()).toBe(0);
    expect(await h.prisma.mcpAuthorizationCode.count()).toBe(0);
    expect(
      (await h.prisma.mcpClient.findUnique({ where: { clientId: 'c1' } }))?.lastGrantedAt
    ).toBe(T0 + 5);
  });
});

describe('tokens', () => {
  it('issues a pair whose wraps open only with their own raw tokens', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    expect(issued).toMatchObject({ token_type: 'bearer', expires_in: 3600, scope: 'library:read' });

    const rows = await h.prisma.mcpToken.findMany({ orderBy: { kind: 'asc' } });
    expect(rows.map((r) => r.kind)).toEqual(['access', 'refresh']);
    expect(rows.map((r) => r.expiresAt)).toEqual([
      T0 + ACCESS_TOKEN_TTL_MS,
      T0 + REFRESH_TOKEN_TTL_MS,
    ]);
    for (const row of rows) {
      expect(JSON.stringify(row)).not.toContain(issued.access_token);
      expect(JSON.stringify(row)).not.toContain(issued.refresh_token);
    }
    const [access, refresh] = rows;
    expect(
      openWrap(issued.access_token, owner.libraryId, 'access', access!.wrap).equals(
        owner.libraryKey
      )
    ).toBe(true);
    expect(
      openWrap(issued.refresh_token, owner.libraryId, 'refresh', refresh!.wrap).equals(
        owner.libraryKey
      )
    ).toBe(true);
    expect(() => openWrap(issued.refresh_token, owner.libraryId, 'access', access!.wrap)).toThrow(
      SealError
    );
    expect(() => openWrap(issued.access_token, owner.libraryId, 'refresh', refresh!.wrap)).toThrow(
      SealError
    );
  });

  it('withLibraryKey yields the key for a live access token, then zeroes it', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    let seen: Buffer | null = null;
    const result = await withLibraryKey(
      h.prisma,
      { rawAccessToken: issued.access_token, now: T0 + 1 },
      async (key, info) => {
        seen = key;
        expect(key.equals(owner.libraryKey)).toBe(true);
        expect(info).toMatchObject({
          grantId: issued.grantId,
          clientId: 'test-client',
          libraryId: owner.libraryId,
          scopes: ['library:read'],
        });
        return 'answered';
      }
    );
    expect(result).toBe('answered');
    expect(seen!.every((b) => b === 0)).toBe(true);
  });

  it('withLibraryKey zeroes the key even when the call throws', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    let seen: Buffer | null = null;
    await expect(
      withLibraryKey(h.prisma, { rawAccessToken: issued.access_token, now: T0 }, async (key) => {
        seen = key;
        throw new Error('tool failed');
      })
    ).rejects.toThrow('tool failed');
    expect(seen!.every((b) => b === 0)).toBe(true);
  });

  it('withLibraryKey rejects an unknown, expired or refresh token', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    const fn = async () => 'never';
    await expect(withLibraryKey(h.prisma, { rawAccessToken: 'nope', now: T0 }, fn)).rejects.toThrow(
      TokenRejectedError
    );
    await expect(
      withLibraryKey(h.prisma, { rawAccessToken: issued.refresh_token, now: T0 }, fn)
    ).rejects.toThrow(TokenRejectedError);
    await expect(
      withLibraryKey(
        h.prisma,
        { rawAccessToken: issued.access_token, now: T0 + ACCESS_TOKEN_TTL_MS },
        fn
      )
    ).rejects.toThrow(TokenRejectedError);
    expect(
      await lookupAccessToken(h.prisma, issued.access_token, T0 + ACCESS_TOKEN_TTL_MS)
    ).toBeNull();
    expect(await lookupAccessToken(h.prisma, issued.access_token, T0 + 1)).toMatchObject({
      grantId: issued.grantId,
      expiresAt: T0 + ACCESS_TOKEN_TTL_MS,
    });
  });

  it('a disconnected grant takes its tokens with it, and the key can no longer be opened', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    await withLibraryKey(h.prisma, { rawAccessToken: issued.access_token, now: T0 }, async () => 1);

    expect(await deleteGrant(h.prisma, issued.grantId)).toBe(true);
    expect(await deleteGrant(h.prisma, issued.grantId)).toBe(false);
    expect(await h.prisma.mcpToken.count()).toBe(0);
    await expect(
      withLibraryKey(h.prisma, { rawAccessToken: issued.access_token, now: T0 }, async () => 1)
    ).rejects.toThrow(TokenRejectedError);
    expect(await consumeRefreshToken(h.prisma, issued.refresh_token, T0)).toBeNull();
  });

  it('a refresh token is consumed once and carries a wrap that opens with it', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    const consumed = await consumeRefreshToken(h.prisma, issued.refresh_token, T0 + 1);
    expect(consumed).toMatchObject({ grantId: issued.grantId, libraryId: owner.libraryId });
    expect(
      openWrap(issued.refresh_token, owner.libraryId, 'refresh', consumed!.wrap).equals(
        owner.libraryKey
      )
    ).toBe(true);
    expect(await consumeRefreshToken(h.prisma, issued.refresh_token, T0 + 1)).toBeNull();
    // An access token is never a refresh token.
    expect(await consumeRefreshToken(h.prisma, issued.access_token, T0 + 1)).toBeNull();
    expect(await h.prisma.mcpToken.count()).toBe(1);
  });

  it('touchGrant records use at most once a minute, and the grant list shows it', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    await touchGrant(h.prisma, issued.grantId, T0 + 10);
    await touchGrant(h.prisma, issued.grantId, T0 + 20);
    const [grant] = await listGrants(h.prisma);
    expect(grant).toMatchObject({
      id: issued.grantId,
      clientName: 'Test Assistant',
      clientUri: 'https://assistant.example',
      createdAt: T0,
      lastUsedAt: T0 + 10,
    });
    await touchGrant(h.prisma, issued.grantId, T0 + 70_000);
    expect((await listGrants(h.prisma))[0]!.lastUsedAt).toBe(T0 + 70_000);
  });

  it('sweeps expired tokens and codes, and clients nobody ever approved', async () => {
    const issued = await mintTokens(h.prisma, {
      libraryId: owner.libraryId,
      libraryKey: owner.libraryKey,
      now: T0,
    });
    await grantWithCode('c2', T0);
    await h.prisma.mcpClient.create({
      data: {
        clientId: 'stray',
        clientIdIssuedAt: 1,
        metadata: '{}',
        createdAt: T0 - UNGRANTED_CLIENT_TTL_MS - 1,
      },
    });

    await sweepExpired(h.prisma, T0 + ACCESS_TOKEN_TTL_MS);
    expect((await h.prisma.mcpToken.findMany()).map((t) => t.kind)).toEqual(['refresh']);
    expect(await h.prisma.mcpAuthorizationCode.count()).toBe(0);
    expect(await h.prisma.mcpClient.findUnique({ where: { clientId: 'stray' } })).toBeNull();
    // Approved clients and their grants survive a sweep.
    expect(await h.prisma.mcpGrant.count()).toBe(2);
    expect(
      await lookupAccessToken(h.prisma, issued.access_token, T0 + ACCESS_TOKEN_TTL_MS)
    ).toBeNull();
  });
});
