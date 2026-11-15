import { describe, expect, it } from 'vitest';

import { consentUrl, mcpEndpointUrl, resolveMcpBaseUrl } from './base-url';

describe('resolveMcpBaseUrl', () => {
  it('accepts an https origin and strips any path, query or fragment', () => {
    expect(resolveMcpBaseUrl('https://vault.example')?.href).toBe('https://vault.example/');
    expect(resolveMcpBaseUrl('https://vault.example/some/path?q=1#f')?.href).toBe(
      'https://vault.example/'
    );
    expect(resolveMcpBaseUrl('https://vault.example:8443')?.href).toBe(
      'https://vault.example:8443/'
    );
  });

  it('allows plain http only on localhost', () => {
    expect(resolveMcpBaseUrl('http://localhost:3000')?.href).toBe('http://localhost:3000/');
    expect(resolveMcpBaseUrl('http://127.0.0.1:3000')?.href).toBe('http://127.0.0.1:3000/');
    expect(resolveMcpBaseUrl('http://192.168.1.20:3000')).toBeNull();
    expect(resolveMcpBaseUrl('http://vault.example')).toBeNull();
  });

  it('is null for nothing, garbage and other schemes', () => {
    expect(resolveMcpBaseUrl(null)).toBeNull();
    expect(resolveMcpBaseUrl(undefined)).toBeNull();
    expect(resolveMcpBaseUrl('')).toBeNull();
    expect(resolveMcpBaseUrl('not a url')).toBeNull();
    expect(resolveMcpBaseUrl('ftp://vault.example')).toBeNull();
  });

  it('derives the endpoint and the consent page from the origin', () => {
    const base = resolveMcpBaseUrl('https://vault.example')!;
    expect(mcpEndpointUrl(base)).toBe('https://vault.example/mcp');
    expect(consentUrl(base).href).toBe('https://vault.example/connect');
  });
});
