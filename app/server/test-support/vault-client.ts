import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import type express from 'express';
import request from 'supertest';

import {
  formatRecoveryCode,
  formatSecretKey,
  generateRecoveryCode,
  generateSecretKey,
  parseSecretKey,
} from '../crypto/codes';
import { deriveAccountKeys } from '../crypto/kdf';
import { keyWrapAad, seal } from '../crypto/seal';

/** Every field any route answers with, all optional: later tasks add theirs here. */
export type ClientBody = {
  error?: string;
  libraryExists?: boolean;
  version?: string;
  passwordSalt?: string;
  recoverySalt?: string;
  libraryId?: string;
  deviceId?: string;
  deviceToken?: string;
  passwordWrap?: string;
  devices?: Array<{
    id: string;
    name: string;
    createdAt: number;
    lastSeenAt: number | null;
    revokedAt: number | null;
    isCurrent: boolean;
  }>;
  id?: string;
  name?: string;
};

export type ClientResponse = { status: number; body: ClientBody };

/** The JSON body of `POST /api/v1/library`, exactly as the macOS app sends it (base64 binary fields). */
export type CreateLibraryRequest = {
  setupCode: string;
  libraryId: string;
  passwordSalt: string;
  recoverySalt: string;
  authKey: string;
  passwordWrap: string;
  recoveryCodes: Array<{ authKey: string; wrap: string }>;
  device: { name: string };
};

/**
 * A thin supertest wrapper that speaks the vault's HTTP API the way the app
 * does. It grows with every task: each later route gets a method here so no
 * route test hand-rolls its own requests.
 */
export class VaultClient {
  constructor(private readonly app: express.Express) {}

  async status(): Promise<ClientResponse> {
    const res = await request(this.app).get('/api/v1/status');
    return { status: res.status, body: res.body };
  }

  async salts(): Promise<ClientResponse> {
    const res = await request(this.app).get('/api/v1/library/salts');
    return { status: res.status, body: res.body };
  }

  /**
   * Joins the library as a further Mac: fetches the salts, derives the auth
   * key from password + Secret Key, and posts it. Returns the raw response and
   * stores nothing; the caller unwraps `passwordWrap` itself if it cares.
   */
  async enrol(input: {
    password: string;
    secretKey: string;
    name: string;
  }): Promise<ClientResponse> {
    const salts = await this.salts();
    const secretKey = parseSecretKey(input.secretKey);
    if (salts.status !== 200 || secretKey === null || salts.body.passwordSalt === undefined) {
      throw new Error('enrol: could not fetch salts or parse the Secret Key');
    }
    const { authKey } = deriveAccountKeys({
      secret: Buffer.from(input.password, 'utf8'),
      secretKey,
      salt: Buffer.from(salts.body.passwordSalt, 'base64'),
    });
    return this.postDevice({ authKey: authKey.toString('base64'), name: input.name });
  }

  /** POST /devices with an arbitrary body, for shape-validation tests. */
  async postDevice(body: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .post('/api/v1/devices')
      .send(body as object);
    return { status: res.status, body: res.body };
  }

  async devices(token: string): Promise<ClientResponse> {
    const res = await request(this.app)
      .get('/api/v1/devices')
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  async renameDevice(token: string, id: string, name: string): Promise<ClientResponse> {
    const res = await request(this.app)
      .patch(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ name });
    return { status: res.status, body: res.body };
  }

  async revokeDevice(token: string, id: string): Promise<ClientResponse> {
    const res = await request(this.app)
      .delete(`/api/v1/devices/${id}`)
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  async createLibrary(input: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .post('/api/v1/library')
      .send(input as object);
    return { status: res.status, body: res.body };
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

/** Builds the real, client-side material for a library: keys, salts, wraps and ten recovery codes. */
export function buildLibraryRequest(opts: { setupCode: string; name?: string }) {
  const libraryId = crypto.randomUUID();
  const secretKeyBytes = generateSecretKey();
  const passwordSalt = crypto.randomBytes(16);
  const recoverySalt = crypto.randomBytes(16);
  const libraryKey = crypto.randomBytes(32);

  // One PBKDF2 (650 000 iterations) per code: the dominant cost of this helper.
  const password = deriveAccountKeys({
    secret: Buffer.from(OWNER_PASSWORD, 'utf8'),
    secretKey: secretKeyBytes,
    salt: passwordSalt,
  });
  const codes = Array.from({ length: 10 }, () => generateRecoveryCode());
  const recovery = codes.map((code) => {
    const keys = deriveAccountKeys({ secret: code, secretKey: secretKeyBytes, salt: recoverySalt });
    return {
      authKey: keys.authKey.toString('base64'),
      wrap: seal(keys.kek, libraryKey, keyWrapAad(libraryId, 'recovery')).toString('base64'),
    };
  });

  const body: CreateLibraryRequest = {
    setupCode: opts.setupCode,
    libraryId,
    passwordSalt: passwordSalt.toString('base64'),
    recoverySalt: recoverySalt.toString('base64'),
    authKey: password.authKey.toString('base64'),
    passwordWrap: seal(password.kek, libraryKey, keyWrapAad(libraryId, 'password')).toString(
      'base64'
    ),
    recoveryCodes: recovery,
    device: { name: opts.name ?? 'Test Mac' },
  };
  return {
    body,
    libraryId,
    secretKey: formatSecretKey(secretKeyBytes),
    libraryKey,
    recoveryCodes: codes.map(formatRecoveryCode),
  };
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
