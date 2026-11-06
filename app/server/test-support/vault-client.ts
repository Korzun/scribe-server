import * as fs from 'fs';
import * as path from 'path';

import type express from 'express';
import request from 'supertest';

import {
  buildLibraryRequest as buildRequest,
  HttpVaultClient,
  type Transport,
} from './http-vault-client';

export type {
  BlobResponse,
  ChangeEntry,
  ClientBody,
  ClientResponse,
  CreateLibraryRequest,
  MeetingBlobEntry,
} from './http-vault-client';

/** Collects the raw body whatever its type, so the client alone decides what is JSON. */
const rawBody = (res: request.Response, done: (err: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  res.on('data', (c: Buffer) => chunks.push(c));
  res.on('end', () => done(null, Buffer.concat(chunks)));
};

/** A `Transport` that drives the in-process app through supertest, no listener needed. */
export function supertestTransport(app: express.Express): Transport {
  return async (req) => {
    const agent = request(app);
    const methods = {
      GET: () => agent.get(req.path),
      POST: () => agent.post(req.path),
      PUT: () => agent.put(req.path),
      PATCH: () => agent.patch(req.path),
      DELETE: () => agent.delete(req.path),
    };
    let test = methods[req.method]().buffer(true).parse(rawBody);
    for (const [name, value] of Object.entries(req.headers ?? {})) test = test.set(name, value);
    if (req.json !== undefined) test = test.send(req.json as object);
    else if (req.bytes !== undefined) test = test.send(req.bytes);
    const res = await test;
    return {
      status: res.status,
      headers: res.headers as Record<string, string | string[] | undefined>,
      bytes: Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0),
    };
  };
}

/**
 * The shared client (`http-vault-client.ts`) over supertest, for the route
 * tests: `new VaultClient(h.app)`. The command-line client uses the same
 * class over `fetch`, so a request the tests prove is the request it sends.
 */
export class VaultClient extends HttpVaultClient {
  constructor(app: express.Express) {
    super(supertestTransport(app));
  }
}

/**
 * Writes (or, for `null`, removes) the add-on's `options.json` in `dataDir`.
 * The vault re-reads it on every setup attempt (spec §4), so a test changes
 * the setup code between two requests simply by calling this again.
 */
export function writeSetupCode(dataDir: string, code: string | null): void {
  const file = path.join(dataDir, 'options.json');
  if (code === null) {
    fs.rmSync(file, { force: true });
    return;
  }
  fs.writeFileSync(file, JSON.stringify({ setup_code: code }));
}

export type Owner = {
  libraryId: string;
  secretKey: string;
  password: string;
  libraryKey: Buffer;
  recoveryCodes: string[];
  deviceToken: string;
  deviceId: string;
};

export const OWNER_PASSWORD = 'correct horse battery staple';

/** Builds the real, client-side material for a library, with the tests' fixed password. */
export function buildLibraryRequest(opts: { setupCode: string; name?: string }) {
  return buildRequest({
    setupCode: opts.setupCode,
    password: OWNER_PASSWORD,
    name: opts.name ?? 'Test Mac',
  });
}

/**
 * Creates a library through the real route and returns everything a later
 * test needs to act as its owner. Writes nothing to disk: the caller must
 * already have written `options.json` with `setupCode` (see `writeSetupCode`).
 */
export async function createOwner(
  client: VaultClient,
  opts: { setupCode: string; name?: string }
): Promise<Owner> {
  const built = buildLibraryRequest(opts);
  const res = await client.createLibrary(built.body);
  if (res.status !== 201) {
    throw new Error(`createOwner: expected 201, got ${res.status}`);
  }
  return {
    libraryId: built.libraryId,
    secretKey: built.secretKey,
    password: OWNER_PASSWORD,
    libraryKey: built.libraryKey,
    recoveryCodes: built.recoveryCodes,
    deviceToken: res.body.deviceToken ?? '',
    deviceId: res.body.deviceId ?? '',
  };
}
