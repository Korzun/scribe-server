/**
 * `POST /mcp` after the bearer middleware. The token has been verified; what
 * remains is the key chain's last link (spec §10): open the Library Key the
 * token's wrap holds, build a one-shot server whose tools read through that
 * key, let the SDK answer the JSON-RPC body, and drop the key. Stateless
 * transport: a fresh server per POST, nothing shared between two calls, no
 * session for a key to linger in.
 *
 * Nothing here logs: the only values in scope are a token and a key.
 */
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { PrismaClient } from '@prisma/client';
import type { Request, Response } from 'express';

import type { BlobStore } from '../services/blob-store';
import { createLibraryReader } from './library-reader';
import { buildMcpServer } from './server';
import { TokenRejectedError, touchGrant, withLibraryKey } from './tokens';

export type McpHandlerDeps = {
  baseUrl: URL;
  prisma: PrismaClient;
  blobStore: BlobStore;
  now: () => number;
};

const unauthorized = (res: Response): void => {
  res
    .status(401)
    .set(
      'WWW-Authenticate',
      'Bearer error="invalid_token", error_description="Unknown, expired or revoked token"'
    )
    .json({ error: 'invalid_token', error_description: 'Unknown, expired or revoked token' });
};

export const createMcpRequestHandler =
  (deps: McpHandlerDeps) =>
  async (req: Request, res: Response): Promise<void> => {
    const auth = req.auth;
    if (auth === undefined) {
      unauthorized(res);
      return;
    }
    const grantId = auth.extra?.grantId;
    if (typeof grantId === 'string') await touchGrant(deps.prisma, grantId, deps.now());

    try {
      await withLibraryKey(
        deps.prisma,
        { rawAccessToken: auth.token, now: deps.now() },
        async (libraryKey, info) => {
          const reader = createLibraryReader({
            prisma: deps.prisma,
            blobStore: deps.blobStore,
            libraryId: info.libraryId,
            libraryKey,
          });
          const server = buildMcpServer({ reader, baseUrl: deps.baseUrl });
          const transport = new StreamableHTTPServerTransport({
            sessionIdGenerator: undefined,
            enableJsonResponse: true,
          });
          res.on('close', () => {
            void transport.close();
            void server.close();
          });
          await server.connect(transport);
          // In JSON-response mode this resolves only once every response is
          // ready, so the tools have finished with the key when it returns.
          await transport.handleRequest(req, res, req.body);
        }
      );
    } catch (err) {
      if (err instanceof TokenRejectedError && !res.headersSent) {
        unauthorized(res);
        return;
      }
      throw err;
    }
  };
