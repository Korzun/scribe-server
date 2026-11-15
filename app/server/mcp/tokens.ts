/**
 * Persistence for the MCP authorization server (spec §10): grants, single-use
 * authorization codes, and opaque access and refresh tokens.
 *
 * Every secret is 32 random bytes, base64url on the wire, and only its SHA-256
 * is stored (`crypto/token-kek.ts`). Tokens are deliberately NOT JWTs:
 * Disconnect deletes the grant, the tokens cascade away with it, and the next
 * request fails its lookup. A signed token would outlive that until expiry.
 *
 * What is new against Bookplate's version is the `wrap` beside every code and
 * token: the Library Key sealed under a key derived from that secret. The
 * browser seals the code's wrap at consent; this module reseals under each
 * token it mints. Opening a wrap needs the raw secret, which only the client
 * holds, so the vault's disk never holds the Library Key under a key the vault
 * also holds. The key is in memory only inside `issueTokens` (the caller's
 * buffer) and `withLibraryKey` (zeroed in `finally`).
 *
 * Every time-based function takes `now` (ms since epoch) so tests can pin the
 * clock without fake timers. Nothing here logs.
 */
import type { PrismaClient } from '@prisma/client';
import { nanoid } from 'nanoid';

import { open, seal, tokenWrapAad, type TokenWrapKind } from '../crypto/seal';
import { deriveTokenKek, newTokenSecret, tokenSecretFromWire } from '../crypto/token-kek';

export const SCOPES = ['library:read'] as const;
export type McpScope = (typeof SCOPES)[number];

export const ACCESS_TOKEN_TTL_MS = 60 * 60 * 1000;
export const REFRESH_TOKEN_TTL_MS = 30 * 24 * 60 * 60 * 1000;
export const CODE_TTL_MS = 10 * 60 * 1000;
/** A registered client the owner never approved is forgotten after this long. */
export const UNGRANTED_CLIENT_TTL_MS = 24 * 60 * 60 * 1000;
/** `touchGrant` writes `lastUsedAt` at most this often. */
const LAST_USED_THROTTLE_MS = 60 * 1000;

const isScope = (value: string): value is McpScope => (SCOPES as readonly string[]).includes(value);

/**
 * The scopes a consent approval grants: the known subset of what the client
 * asked for, or everything when it asked for nothing. Throws when the client
 * asked only for scopes this server does not have: there is nothing to grant.
 */
export function resolveGrantedScopes(requested: readonly string[] | undefined): McpScope[] {
  if (requested === undefined || requested.length === 0) return [...SCOPES];
  const known = [...new Set(requested.filter(isScope))];
  if (known.length === 0) throw new RangeError('No supported scope was requested');
  return SCOPES.filter((scope) => known.includes(scope));
}

export const parseScopes = (stored: string): McpScope[] =>
  stored.split(' ').filter((s): s is McpScope => isScope(s));

/** A wrap as stored: Prisma hands `Bytes` back as a `Uint8Array`. */
const asBuffer = (bytes: Uint8Array): Buffer => Buffer.from(bytes);

/**
 * Opens the Library Key a row wraps, with the secret the client presented.
 * Throws `SealError` when the secret is not the one the wrap was sealed for.
 * The caller owns the returned buffer and must zero it when done.
 */
export function openWrap(
  wire: string,
  libraryId: string,
  kind: TokenWrapKind,
  wrap: Uint8Array
): Buffer {
  const secret = tokenSecretFromWire(wire);
  const kek = deriveTokenKek(secret.bytes);
  try {
    return open(kek, asBuffer(wrap), tokenWrapAad(libraryId, kind, secret.hash));
  } finally {
    kek.fill(0);
  }
}

/**
 * One grant per client for the library. Re-approving the same client drops
 * every token and code it previously held: the owner has re-run the connect
 * flow, so the old tokens are lost to the client in practice, and a stale
 * wrap must not outlive the approval it came from.
 */
export async function upsertGrant(
  prisma: PrismaClient,
  input: { libraryId: string; clientId: string; scopes: readonly McpScope[] },
  now: number = Date.now()
): Promise<{ id: string }> {
  const scopes = input.scopes.join(' ');
  const grant = await prisma.mcpGrant.upsert({
    where: { libraryId_clientId: { libraryId: input.libraryId, clientId: input.clientId } },
    create: {
      id: nanoid(),
      libraryId: input.libraryId,
      clientId: input.clientId,
      scopes,
      createdAt: now,
    },
    update: { scopes },
    select: { id: true },
  });
  await prisma.$transaction([
    prisma.mcpToken.deleteMany({ where: { grantId: grant.id } }),
    prisma.mcpAuthorizationCode.deleteMany({ where: { grantId: grant.id } }),
    prisma.mcpClient.update({
      where: { clientId: input.clientId },
      data: { lastGrantedAt: now },
    }),
  ]);
  return grant;
}

export type CodeBinding = {
  grantId: string;
  redirectUri: string;
  codeChallenge: string;
  resource: string | null;
  /** SHA-256 of the code's wire form, as the browser computed it. */
  codeHash: string;
  /** The Library Key sealed under the code's derived key, as the browser sealed it. */
  wrap: Buffer;
};

/**
 * Records a code the BROWSER minted. The vault never sees the code itself,
 * only its hash and the wrap; the assistant brings the code to the token
 * endpoint, where `consumeAuthorizationCode` finds this row by the hash.
 */
export async function createAuthorizationCode(
  prisma: PrismaClient,
  binding: CodeBinding,
  now: number = Date.now()
): Promise<void> {
  await prisma.mcpAuthorizationCode.create({
    data: {
      codeHash: binding.codeHash,
      grantId: binding.grantId,
      redirectUri: binding.redirectUri,
      codeChallenge: binding.codeChallenge,
      resource: binding.resource,
      wrap: new Uint8Array(binding.wrap),
      expiresAt: now + CODE_TTL_MS,
    },
  });
}

/** Reads the PKCE challenge a live code was bound to, without consuming it. */
export async function peekAuthorizationCode(
  prisma: PrismaClient,
  code: string,
  now: number = Date.now()
): Promise<{ codeChallenge: string; clientId: string } | null> {
  const row = await prisma.mcpAuthorizationCode.findUnique({
    where: { codeHash: tokenSecretFromWire(code).hash },
    select: { codeChallenge: true, expiresAt: true, grant: { select: { clientId: true } } },
  });
  if (row === null || row.expiresAt <= now) return null;
  return { codeChallenge: row.codeChallenge, clientId: row.grant.clientId };
}

export type ConsumedCode = {
  grantId: string;
  clientId: string;
  libraryId: string;
  scopes: McpScope[];
  redirectUri: string;
  resource: string | null;
  wrap: Uint8Array;
};

/**
 * Reads the code's row and deletes it; the delete is the arbiter, so of two
 * concurrent exchanges exactly one sees `count === 1` and wins. An expired row
 * is deleted too and reported as absent.
 */
export async function consumeAuthorizationCode(
  prisma: PrismaClient,
  code: string,
  now: number = Date.now()
): Promise<ConsumedCode | null> {
  const codeHash = tokenSecretFromWire(code).hash;
  const row = await prisma.mcpAuthorizationCode.findUnique({
    where: { codeHash },
    include: { grant: { select: { clientId: true, libraryId: true, scopes: true } } },
  });
  if (row === null) return null;
  const { count } = await prisma.mcpAuthorizationCode.deleteMany({ where: { codeHash } });
  if (count === 0 || row.expiresAt <= now) return null;
  return {
    grantId: row.grantId,
    clientId: row.grant.clientId,
    libraryId: row.grant.libraryId,
    scopes: parseScopes(row.grant.scopes),
    redirectUri: row.redirectUri,
    resource: row.resource,
    wrap: row.wrap,
  };
}

/** The token response body the SDK's token endpoint returns verbatim. */
export type IssuedTokens = {
  access_token: string;
  token_type: 'bearer';
  expires_in: number;
  refresh_token: string;
  scope: string;
};

/**
 * Mints an access and a refresh token, each row carrying the Library Key
 * sealed under that token's derived key. `libraryKey` is the caller's buffer,
 * opened from a code or refresh wrap moments before; this function does not
 * keep it and the caller zeroes it.
 */
export async function issueTokens(
  prisma: PrismaClient,
  input: { grantId: string; libraryId: string; libraryKey: Buffer; scopes: readonly McpScope[] },
  now: number = Date.now()
): Promise<IssuedTokens> {
  const access = newTokenSecret();
  const refresh = newTokenSecret();
  const wrapFor = (secret: typeof access, kind: TokenWrapKind): Uint8Array<ArrayBuffer> => {
    const kek = deriveTokenKek(secret.bytes);
    try {
      return new Uint8Array(
        seal(kek, input.libraryKey, tokenWrapAad(input.libraryId, kind, secret.hash))
      );
    } finally {
      kek.fill(0);
    }
  };
  await prisma.mcpToken.createMany({
    data: [
      {
        tokenHash: access.hash,
        grantId: input.grantId,
        kind: 'access',
        wrap: wrapFor(access, 'access'),
        expiresAt: now + ACCESS_TOKEN_TTL_MS,
        createdAt: now,
      },
      {
        tokenHash: refresh.hash,
        grantId: input.grantId,
        kind: 'refresh',
        wrap: wrapFor(refresh, 'refresh'),
        expiresAt: now + REFRESH_TOKEN_TTL_MS,
        createdAt: now,
      },
    ],
  });
  return {
    access_token: access.wire,
    token_type: 'bearer',
    expires_in: Math.floor(ACCESS_TOKEN_TTL_MS / 1000),
    refresh_token: refresh.wire,
    scope: input.scopes.join(' '),
  };
}

export type ConsumedRefresh = {
  grantId: string;
  clientId: string;
  libraryId: string;
  scopes: McpScope[];
  wrap: Uint8Array;
};

/** Rotates: the presented refresh token is deleted as it is read, as `consumeAuthorizationCode`. */
export async function consumeRefreshToken(
  prisma: PrismaClient,
  raw: string,
  now: number = Date.now()
): Promise<ConsumedRefresh | null> {
  const tokenHash = tokenSecretFromWire(raw).hash;
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash },
    include: { grant: { select: { clientId: true, libraryId: true, scopes: true } } },
  });
  if (row === null || row.kind !== 'refresh') return null;
  const { count } = await prisma.mcpToken.deleteMany({ where: { tokenHash, kind: 'refresh' } });
  if (count === 0 || row.expiresAt <= now) return null;
  return {
    grantId: row.grantId,
    clientId: row.grant.clientId,
    libraryId: row.grant.libraryId,
    scopes: parseScopes(row.grant.scopes),
    wrap: row.wrap,
  };
}

export type AccessTokenInfo = {
  grantId: string;
  clientId: string;
  libraryId: string;
  scopes: McpScope[];
  expiresAt: number;
};

/** Null when unknown, expired, revoked, or not an access token. */
export async function lookupAccessToken(
  prisma: PrismaClient,
  raw: string,
  now: number = Date.now()
): Promise<AccessTokenInfo | null> {
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: tokenSecretFromWire(raw).hash },
    select: {
      kind: true,
      expiresAt: true,
      grant: { select: { id: true, clientId: true, libraryId: true, scopes: true } },
    },
  });
  if (row === null || row.kind !== 'access' || row.expiresAt <= now) return null;
  return {
    grantId: row.grant.id,
    clientId: row.grant.clientId,
    libraryId: row.grant.libraryId,
    scopes: parseScopes(row.grant.scopes),
    expiresAt: row.expiresAt,
  };
}

/** The presented access token is unknown, expired, revoked, or cannot open its wrap. */
export class TokenRejectedError extends Error {
  constructor() {
    super('Unknown, expired or revoked token');
    this.name = 'TokenRejectedError';
  }
}

/**
 * Runs `fn` with the Library Key opened from the presented access token's
 * wrap, then zeroes the key. The key exists for the duration of `fn` and
 * nowhere else: no module-level variable, no cache. Rejects with
 * `TokenRejectedError` when the token is not a live access token or its wrap
 * does not open (a disconnected grant has no row at all).
 */
export async function withLibraryKey<T>(
  prisma: PrismaClient,
  input: { rawAccessToken: string; now?: number },
  fn: (libraryKey: Buffer, info: AccessTokenInfo) => Promise<T>
): Promise<T> {
  const now = input.now ?? Date.now();
  const row = await prisma.mcpToken.findUnique({
    where: { tokenHash: tokenSecretFromWire(input.rawAccessToken).hash },
    select: {
      kind: true,
      wrap: true,
      expiresAt: true,
      grant: { select: { id: true, clientId: true, libraryId: true, scopes: true } },
    },
  });
  if (row === null || row.kind !== 'access' || row.expiresAt <= now) {
    throw new TokenRejectedError();
  }
  let key: Buffer;
  try {
    key = openWrap(input.rawAccessToken, row.grant.libraryId, 'access', row.wrap);
  } catch {
    throw new TokenRejectedError();
  }
  try {
    return await fn(key, {
      grantId: row.grant.id,
      clientId: row.grant.clientId,
      libraryId: row.grant.libraryId,
      scopes: parseScopes(row.grant.scopes),
      expiresAt: row.expiresAt,
    });
  } finally {
    key.fill(0);
  }
}

export async function revokeToken(prisma: PrismaClient, raw: string): Promise<void> {
  await prisma.mcpToken.deleteMany({ where: { tokenHash: tokenSecretFromWire(raw).hash } });
}

/** Records use for the Assistants card, without a write per tool call. */
export async function touchGrant(
  prisma: PrismaClient,
  grantId: string,
  now: number = Date.now()
): Promise<void> {
  await prisma.mcpGrant.updateMany({
    where: {
      id: grantId,
      OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: now - LAST_USED_THROTTLE_MS } }],
    },
    data: { lastUsedAt: now },
  });
}

/** One row of the admin page's Assistants card. */
export type GrantSummary = {
  id: string;
  clientId: string;
  clientName: string;
  clientUri: string | null;
  createdAt: number;
  lastUsedAt: number | null;
};

/** The registered name and website of a client, read from its registration document. */
export function clientDisplay(metadata: string): { clientName: string; clientUri: string | null } {
  let parsed: { client_name?: unknown; client_uri?: unknown } = {};
  try {
    parsed = JSON.parse(metadata) as typeof parsed;
  } catch {
    // An unparsable document is a bug upstream; the row still lists.
  }
  const clientName =
    typeof parsed.client_name === 'string' && parsed.client_name.trim() !== ''
      ? parsed.client_name
      : 'Unnamed assistant';
  const clientUri = typeof parsed.client_uri === 'string' ? parsed.client_uri : null;
  return { clientName, clientUri };
}

export async function listGrants(prisma: PrismaClient): Promise<GrantSummary[]> {
  const rows = await prisma.mcpGrant.findMany({
    orderBy: { createdAt: 'asc' },
    include: { client: { select: { metadata: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    clientId: row.clientId,
    ...clientDisplay(row.client.metadata),
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  }));
}

/** Disconnect: the grant goes, and with it every code, token and wrap. Idempotent. */
export async function deleteGrant(prisma: PrismaClient, id: string): Promise<boolean> {
  const { count } = await prisma.mcpGrant.deleteMany({ where: { id } });
  return count > 0;
}

/**
 * Runs on every token-endpoint call (sweep-on-write). Grants are NOT swept: a
 * grant with no live tokens is still something the owner approved and can see
 * on the admin page. Clients are swept only while no owner has ever approved
 * them (`McpClient.lastGrantedAt`).
 */
export async function sweepExpired(prisma: PrismaClient, now: number = Date.now()): Promise<void> {
  await prisma.$transaction([
    prisma.mcpToken.deleteMany({ where: { expiresAt: { lte: now } } }),
    prisma.mcpAuthorizationCode.deleteMany({ where: { expiresAt: { lte: now } } }),
    prisma.mcpClient.deleteMany({
      where: { lastGrantedAt: null, createdAt: { lt: now - UNGRANTED_CLIENT_TTL_MS } },
    }),
  ]);
}
