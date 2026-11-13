/**
 * Byte helpers for the browser crypto (`kdf.ts`, `seal.ts`, `codes.ts`). The
 * server speaks base64 for every binary field (salts, authKey, wraps); the
 * test vectors speak lowercase hex. Everything is a plain `Uint8Array`.
 */

export const utf8 = (text: string): Uint8Array => new TextEncoder().encode(text);

export const toHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');

export const fromHex = (hex: string): Uint8Array => {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) throw new Error('Invalid hex');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
};

/** Standard (not URL-safe) base64 with padding, as the server's `Buffer.toString('base64')`. */
export const toBase64 = (bytes: Uint8Array): string => {
  let raw = '';
  for (const byte of bytes) raw += String.fromCharCode(byte);
  return btoa(raw);
};

/** Throws on malformed input (`atob`'s `InvalidCharacterError`). */
export const fromBase64 = (text: string): Uint8Array =>
  Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
