import type { NextFunction, Request, RequestHandler, Response } from 'express';

const HEADERS: Record<string, string> = {
  'Content-Security-Policy':
    "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
  'X-Frame-Options': 'DENY',
  // A default for API and MCP responses. `express.static` and `res.sendFile`
  // keep a Cache-Control that is already set, so server.ts clears this one on
  // GET/HEAD ahead of the SPA handlers to let the admin SPA keep its caching.
  'Cache-Control': 'no-store',
};

/** Sets the security headers (and `Cache-Control: no-store`) on every response before any handler runs. */
export function securityHeaders(): RequestHandler {
  return (_req: Request, res: Response, next: NextFunction): void => {
    res.set(HEADERS);
    next();
  };
}
