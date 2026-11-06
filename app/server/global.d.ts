// TypeScript 7 no longer auto-includes every `@types/*` package, so Node's
// globals (`process`, `URL`, ...) only appear once something imports a
// module that pulls `@types/node` in transitively. Name it explicitly so the
// build's type-check does not depend on which files happen to exist yet.
/// <reference types="node" />

declare global {
  namespace Express {
    interface Request {
      /** Set by `deviceAuth` once a device token has been verified. */
      device?: { id: string };
      /** Set by `ownerAuth`: who is acting as the owner, by device token or browser session. */
      owner?: { via: 'device'; deviceId: string } | { via: 'session' };
      /** Set by `ownerAuth` (and sign-in): the reset epoch the request started in (services/vault-gate.ts). */
      vaultEpoch?: number;
    }
  }
}

export {};
