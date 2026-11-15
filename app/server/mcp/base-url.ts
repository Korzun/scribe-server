/**
 * The origin the MCP server, its OAuth endpoints and its metadata documents
 * are published under. Derived ONLY from `PUBLIC_URL` (`AppConfig.publicUrl`),
 * never from a request's `Host` header: a header-derived absolute URL is a
 * poisoning path, and an OAuth issuer is exactly that class of thing (spec
 * §4, §10).
 *
 * https is required because the SDK's metadata router refuses a plain-http
 * issuer (RFC 8414), with the SDK's own exemption for `localhost` and
 * `127.0.0.1` kept so a developer can run the whole flow locally. A LAN-only
 * http `PUBLIC_URL` therefore yields null, and MCP stays off; `server.ts` logs
 * why and mounts the 404 router in its place.
 */
export function resolveMcpBaseUrl(publicUrl: string | null | undefined): URL | null {
  if (!publicUrl) return null;
  let url: URL;
  try {
    url = new URL(publicUrl);
  } catch {
    return null;
  }
  const localhost = url.hostname === 'localhost' || url.hostname === '127.0.0.1';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && localhost)) return null;
  // Origin only: no path, query or fragment can ride along into the issuer.
  return new URL(url.origin);
}

/** The MCP endpoint itself, which is also the OAuth resource identifier. */
export const mcpEndpointUrl = (baseUrl: URL): string => new URL('/mcp', baseUrl).href;

/** Where `provider.authorize` sends the browser for consent: the SPA's connect page. */
export const consentUrl = (baseUrl: URL): URL => new URL('/connect', baseUrl);
