import jwt from 'jsonwebtoken';

export const ACCESS_TOKEN_TTL_SECONDS = 15 * 60;

/**
 * Identity carried by a verified access token. There is exactly one owner per
 * vault, so the only claim is that the bearer is that owner; there is no
 * subject, username or role to carry.
 */
export type AuthUser = { owner: true };

/**
 * Mints a short-lived HS256 access token. `nowSeconds` defaults to the wall
 * clock; callers pass their injected clock so tests can mint (and expire)
 * tokens against a fake one. `iat`/`exp` go in the payload rather than
 * `expiresIn` because `expiresIn` would always read the real clock.
 */
export function signAccessToken(
  secret: Buffer,
  _user: AuthUser = { owner: true },
  nowSeconds: number = Math.floor(Date.now() / 1000)
): string {
  const iat = Math.floor(nowSeconds);
  return jwt.sign({ owner: true, iat, exp: iat + ACCESS_TOKEN_TTL_SECONDS }, secret, {
    algorithm: 'HS256',
  });
}

/**
 * Returns the identity for a valid, unexpired token, or null for ANY failure
 * (bad signature, wrong algorithm, expired, wrong shape). Expiry is judged
 * against `nowSeconds`, the same injected clock the token was minted with.
 */
export function verifyAccessToken(
  secret: Buffer,
  token: string,
  nowSeconds: number = Math.floor(Date.now() / 1000)
): AuthUser | null {
  try {
    const payload = jwt.verify(token, secret, {
      algorithms: ['HS256'],
      clockTimestamp: Math.floor(nowSeconds),
    }) as jwt.JwtPayload;
    if (payload.owner !== true) return null;
    return { owner: true };
  } catch {
    return null;
  }
}
