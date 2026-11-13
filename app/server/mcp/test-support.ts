/**
 * Test-only wiring for the MCP server: what the browser does at consent (mint
 * a code, seal the Library Key under it), a client row and a token minted
 * straight into the tables (so tool tests skip the consent dance the OAuth
 * tests cover), and an SDK `Client` over Streamable HTTP against the app.
 */
import type { Server } from 'http';
import type { AddressInfo } from 'net';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { PrismaClient } from '@prisma/client';
import type express from 'express';

import { seal, tokenWrapAad } from '../crypto/seal';
import { deriveTokenKek, newTokenSecret, type TokenSecret } from '../crypto/token-kek';
import { issueTokens, upsertGrant, type IssuedTokens } from './tokens';

export const TEST_BASE_URL = new URL('https://vault.example');
export const TEST_REDIRECT = 'https://client.example/callback';

/**
 * What the consent page does: mints the authorization code and seals the
 * Library Key under the key derived from it, with the code's own hash in the
 * AAD. Returns the code (which only the client ever sees) and what the vault
 * is sent.
 */
export function mintBrowserCode(
  libraryKey: Buffer,
  libraryId: string
): { code: TokenSecret; codeHash: string; wrap: Buffer } {
  const code = newTokenSecret();
  const kek = deriveTokenKek(code.bytes);
  const wrap = seal(kek, libraryKey, tokenWrapAad(libraryId, 'code', code.hash));
  kek.fill(0);
  return { code, codeHash: code.hash, wrap };
}

/** A registered client row, as dynamic registration would have written it. */
export async function createClientRow(
  prisma: PrismaClient,
  clientId = 'test-client',
  extra: Record<string, unknown> = {}
): Promise<string> {
  await prisma.mcpClient.upsert({
    where: { clientId },
    create: {
      clientId,
      clientIdIssuedAt: 1,
      metadata: JSON.stringify({
        client_id: clientId,
        client_name: 'Test Assistant',
        client_uri: 'https://assistant.example',
        redirect_uris: [TEST_REDIRECT],
        token_endpoint_auth_method: 'none',
        ...extra,
      }),
      createdAt: Date.now(),
    },
    update: {},
  });
  return clientId;
}

/** A grant and a token pair for `libraryId`, minted straight into the tables. */
export async function mintTokens(
  prisma: PrismaClient,
  input: { libraryId: string; libraryKey: Buffer; clientId?: string; now?: number }
): Promise<IssuedTokens & { grantId: string }> {
  const clientId = await createClientRow(prisma, input.clientId);
  const now = input.now ?? Date.now();
  const grant = await upsertGrant(
    prisma,
    { libraryId: input.libraryId, clientId, scopes: ['library:read'] },
    now
  );
  const issued = await issueTokens(
    prisma,
    {
      grantId: grant.id,
      libraryId: input.libraryId,
      libraryKey: input.libraryKey,
      scopes: ['library:read'],
    },
    now
  );
  return { ...issued, grantId: grant.id };
}

export type McpTestClient = {
  client: Client;
  /** `callTool` with the result narrowed to the shape every tool returns. */
  call: (name: string, args?: Record<string, unknown>) => Promise<CallToolResult>;
  close: () => Promise<void>;
};

/** Listens on a loopback port and connects an SDK client with the bearer token. */
export async function connectMcpClient(
  app: express.Express,
  token: string
): Promise<McpTestClient> {
  const server: Server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address() as AddressInfo;
  const transport = new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${token}` } },
  });
  const client = new Client({ name: 'scribe-test', version: '0.0.0' });
  try {
    await client.connect(transport);
  } catch (err) {
    server.close();
    throw err;
  }
  return {
    client,
    call: (name, args = {}) =>
      client.callTool({ name, arguments: args }) as Promise<CallToolResult>,
    close: async () => {
      await client.close();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** The one text block every tool answers with. */
export const textOf = (result: CallToolResult): string =>
  result.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text')
    .map((c) => c.text)
    .join('\n');

/** The parsed JSON payload of a successful tool call. */
export const payloadOf = (result: CallToolResult): unknown => JSON.parse(textOf(result));
