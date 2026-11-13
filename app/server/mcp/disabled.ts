import { Router, type Request, type Response } from 'express';

/**
 * What stands in for the MCP router when `PUBLIC_URL` is not an https origin
 * (spec §4: MCP turns on only then). Every path the real router would own
 * answers a JSON 404 that says why, so an assistant pointed at the vault
 * learns the reason instead of receiving the admin page's HTML, and the
 * smoke test can tell "off" from "broken".
 */
export const MCP_DISABLED_MESSAGE = 'MCP is not enabled: PUBLIC_URL must be an https origin';

export function createMcpDisabledRouter(): Router {
  const router = Router();
  const refuse = (_req: Request, res: Response): void => {
    res.status(404).json({ error: MCP_DISABLED_MESSAGE });
  };
  router.all('/mcp', refuse);
  router.all('/mcp/{*splat}', refuse);
  router.all('/.well-known/oauth-authorization-server', refuse);
  router.all('/.well-known/oauth-authorization-server/{*splat}', refuse);
  router.all('/.well-known/oauth-protected-resource', refuse);
  router.all('/.well-known/oauth-protected-resource/{*splat}', refuse);
  return router;
}
