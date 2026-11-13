/**
 * Everything the MCP feature mounts on the Express app, as one router that
 * `server.ts` installs at the root when `PUBLIC_URL` is an https origin
 * (`resolveMcpBaseUrl`), and replaces with `disabled.ts` when it is not.
 *
 * Owns: the four OAuth endpoints under `/mcp/oauth/*`, the two well-known
 * metadata documents, and `POST /mcp` itself. The consent decision and the
 * admin page's grant list are REST routes under `/api/v1/mcp/*`
 * (routes/mcp-admin.ts), owner-authenticated like the rest of the admin API.
 */
import { authorizationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/authorize.js';
import { clientRegistrationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/register.js';
import { revocationHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/revoke.js';
import { tokenHandler } from '@modelcontextprotocol/sdk/server/auth/handlers/token.js';
import { requireBearerAuth } from '@modelcontextprotocol/sdk/server/auth/middleware/bearerAuth.js';
import {
  getOAuthProtectedResourceMetadataUrl,
  mcpAuthMetadataRouter,
} from '@modelcontextprotocol/sdk/server/auth/router.js';
import type { PrismaClient } from '@prisma/client';
import { Router, type NextFunction, type Request, type Response } from 'express';

import { resolveClientIp } from '../middleware/rate-limit';
import type { BlobStore } from '../services/blob-store';
import type { AppConfig } from '../types';
import { mcpEndpointUrl } from './base-url';
import { createMcpRequestHandler } from './handler';
import { buildOAuthMetadata, OAUTH_PATHS } from './oauth-metadata';
import { createOAuthProvider } from './oauth-provider';
import { SCOPES } from './tokens';

export type McpRouterDeps = {
  baseUrl: URL;
  prisma: PrismaClient;
  blobStore: BlobStore;
  config: AppConfig;
  now: () => number;
};

export function createMcpRouter(deps: McpRouterDeps): Router {
  const { baseUrl, prisma, config, now } = deps;
  const provider = createOAuthProvider({ prisma, baseUrl, now });
  const metadata = buildOAuthMetadata(baseUrl);
  const resourceUrl = new URL(mcpEndpointUrl(baseUrl));

  // The SDK's limiters default to keying on `req.ip`, which behind the tunnel
  // every deployment sits behind is the proxy's address, one bucket for
  // everyone. Key on the same proxy-aware resolver the login limiter uses;
  // the windows and counts stay the SDK's.
  const rateLimit = {
    keyGenerator: (req: Request) => resolveClientIp(req, config.trustProxyHops),
    validate: { xForwardedForHeader: false, keyGeneratorIpFallback: false },
  };

  const router = Router();

  router.use(OAUTH_PATHS.authorize, authorizationHandler({ provider, rateLimit }));
  router.use(OAUTH_PATHS.token, tokenHandler({ provider, rateLimit }));
  router.use(
    OAUTH_PATHS.register,
    clientRegistrationHandler({
      clientsStore: provider.clientsStore,
      // Never expire: an assistant whose secret lapsed would silently stop
      // working after 30 days with no UI anywhere to re-register it.
      clientSecretExpirySeconds: 0,
      rateLimit,
    })
  );
  router.use(OAUTH_PATHS.revoke, revocationHandler({ provider, rateLimit }));
  router.use(
    mcpAuthMetadataRouter({
      oauthMetadata: metadata,
      resourceServerUrl: resourceUrl,
      scopesSupported: [...SCOPES],
      resourceName: 'Scribe vault',
    })
  );

  const handleMcp = createMcpRequestHandler({
    baseUrl,
    prisma,
    blobStore: deps.blobStore,
    now,
  });

  router.post(
    '/mcp',
    requireBearerAuth({
      verifier: provider,
      resourceMetadataUrl: getOAuthProtectedResourceMetadataUrl(resourceUrl),
    }),
    (req: Request, res: Response, next: NextFunction) => {
      handleMcp(req, res).catch(next);
    }
  );
  // Stateless transport: there is no server→client stream to open and no
  // session to delete. Answer as the SDK does in this mode rather than letting
  // the SPA catch-all serve index.html to an MCP client.
  router.all('/mcp', (_req, res) => {
    res.set('Allow', 'POST').status(405).json({ error: 'Method not allowed' });
  });

  return router;
}
