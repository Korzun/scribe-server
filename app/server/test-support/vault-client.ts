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
  parseRecoveryCode,
  parseSecretKey,
} from '../crypto/codes';
import { deriveAccountKeys } from '../crypto/kdf';
import { keyWrapAad, open, seal } from '../crypto/seal';

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
  accessToken?: string;
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
  createdAt?: number;
  recoveryCodesRemaining?: number;
  storage?: {
    blobBytes: number;
    blobCount: number;
    meetingCount: number;
    deletedMeetingCount: number;
  };
  ids?: string[];
  recoveryId?: string;
  wrap?: string;
  revision?: number;
  seq?: number;
  sha256?: string;
  size?: number;
  currentRevision?: number;
  blobs?: MeetingBlobEntry[];
  meetings?: Array<{ id: string; createdAt: number; blobs: MeetingBlobEntry[] }>;
  nextAfter?: string | null;
  changes?: Array<{
    seq: number;
    meetingId: string | null;
    kind: string;
    revision: number;
    sha256: string | null;
    size: number | null;
    deleted: boolean;
    deviceId: string | null;
    at: string;
  }>;
  nextSince?: number;
  hasMore?: boolean;
  purgedMeetings?: number;
  removedFiles?: number;
};

export type MeetingBlobEntry = { kind: string; revision: number; sha256: string; size: number };

/** A blob download: the raw bytes plus the headers the Mac acts on. */
export type BlobResponse = {
  status: number;
  bytes: Buffer;
  body: ClientBody;
  etag: string | undefined;
  sha256: string | undefined;
  contentType: string | undefined;
  contentLength: string | undefined;
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
  /** The access token from the last `login`/`refresh`; pass it wherever a device token goes. */
  accessToken: string | null = null;
  /** The `refresh_token=<value>` pair from the last `login`/`refresh`, as a browser's cookie jar would hold it. */
  refreshCookie: string | null = null;

  constructor(private readonly app: express.Express) {}

  /**
   * Signs in as a browser would: fetches the salts, derives the auth key from
   * password + Secret Key, posts it, and keeps the access token and the
   * refresh cookie on this instance for `asSession`, `refresh` and `logout`.
   */
  async login(input: { password: string; secretKey: string }): Promise<ClientResponse> {
    const salts = await this.salts();
    const secretKey = parseSecretKey(input.secretKey);
    if (salts.status !== 200 || secretKey === null || salts.body.passwordSalt === undefined) {
      throw new Error('login: could not fetch salts or parse the Secret Key');
    }
    const { authKey } = deriveAccountKeys({
      secret: Buffer.from(input.password, 'utf8'),
      secretKey,
      salt: Buffer.from(salts.body.passwordSalt, 'base64'),
    });
    return this.postSession({ authKey: authKey.toString('base64') });
  }

  /** POST /session with an arbitrary body (shape tests, wrong keys); keeps any session it opens. */
  async postSession(body: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .post('/api/v1/session')
      .send(body as object);
    this.keep(res);
    return { status: res.status, body: res.body };
  }

  /** The bearer credential of the current session, in the form the per-call `token` arguments take. */
  asSession(): string {
    if (this.accessToken === null) throw new Error('asSession: not signed in');
    return this.accessToken;
  }

  /** Rotates the session presented by `cookie` (default: the stored one) and keeps the new pair. */
  async refresh(cookie: string | null = this.refreshCookie): Promise<ClientResponse> {
    const req = request(this.app).post('/api/v1/session/refresh');
    if (cookie !== null) req.set('Cookie', cookie);
    const res = await req;
    this.keep(res);
    return { status: res.status, body: res.body };
  }

  /** Ends the session presented by `cookie` (default: the stored one). */
  async logout(
    cookie: string | null = this.refreshCookie
  ): Promise<ClientResponse & { setCookie: string[] }> {
    const req = request(this.app).post('/api/v1/session/logout');
    if (cookie !== null) req.set('Cookie', cookie);
    const res = await req;
    this.keep(res);
    return {
      status: res.status,
      body: res.body,
      setCookie: (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [],
    };
  }

  /** Mirrors a browser: a new refresh cookie replaces the old one, a cleared one drops the session. */
  private keep(res: request.Response): void {
    if (typeof res.body?.accessToken === 'string') this.accessToken = res.body.accessToken;
    const cookies = (res.headers['set-cookie'] as unknown as string[] | undefined) ?? [];
    const header = cookies.find((c) => c.startsWith('refresh_token='));
    if (header === undefined) return;
    const pair = header.split(';')[0]!;
    if (pair === 'refresh_token=') {
      this.refreshCookie = null;
      this.accessToken = null;
    } else {
      this.refreshCookie = pair;
    }
  }

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

  /** GET /library: the owner's view of the library's public material. */
  async libraryInfo(token: string): Promise<ClientResponse> {
    const res = await request(this.app)
      .get('/api/v1/library')
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  /** PUT /library/password with an arbitrary body (wrong keys, shape tests). */
  async putPassword(token: string, body: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .put('/api/v1/library/password')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
    return { status: res.status, body: res.body };
  }

  /** PUT /library/recovery-codes with an arbitrary body. */
  async putRecoveryCodes(token: string, body: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .put('/api/v1/library/recovery-codes')
      .set('Authorization', `Bearer ${token}`)
      .send(body as object);
    return { status: res.status, body: res.body };
  }

  /**
   * Changes the password like the app does: fetches the library, derives the
   * current keys, unwraps the Library Key locally, derives keys for a fresh
   * salt and the new password, and sends the proof plus the rewrapped key.
   */
  async changePassword(input: {
    token: string;
    password: string;
    newPassword: string;
    secretKey: string;
  }): Promise<ClientResponse> {
    const { libraryKey, authKey, libraryId } = await this.unlock(input);
    const newPasswordSalt = crypto.randomBytes(16);
    const next = deriveAccountKeys({
      secret: Buffer.from(input.newPassword, 'utf8'),
      secretKey: parseSecretKey(input.secretKey)!,
      salt: newPasswordSalt,
    });
    return this.putPassword(input.token, {
      authKey: authKey.toString('base64'),
      newPasswordSalt: newPasswordSalt.toString('base64'),
      newAuthKey: next.authKey.toString('base64'),
      newPasswordWrap: seal(next.kek, libraryKey, keyWrapAad(libraryId, 'password')).toString(
        'base64'
      ),
    });
  }

  /**
   * Replaces the recovery codes like the app does: unwraps the Library Key,
   * mints `count` (default ten) fresh codes under a fresh recovery salt and
   * wraps the key under each. Returns the response plus the formatted codes.
   */
  async regenerateRecoveryCodes(input: {
    token: string;
    password: string;
    secretKey: string;
    count?: number;
  }): Promise<ClientResponse & { codes: string[] }> {
    const { libraryKey, authKey, libraryId } = await this.unlock(input);
    const secretKey = parseSecretKey(input.secretKey)!;
    const recoverySalt = crypto.randomBytes(16);
    const raw = Array.from({ length: input.count ?? 10 }, () => generateRecoveryCode());
    const codes = raw.map((code) => {
      const keys = deriveAccountKeys({ secret: code, secretKey, salt: recoverySalt });
      return {
        authKey: keys.authKey.toString('base64'),
        wrap: seal(keys.kek, libraryKey, keyWrapAad(libraryId, 'recovery')).toString('base64'),
      };
    });
    const res = await this.putRecoveryCodes(input.token, {
      authKey: authKey.toString('base64'),
      recoverySalt: recoverySalt.toString('base64'),
      codes,
    });
    return { ...res, codes: raw.map(formatRecoveryCode) };
  }

  /**
   * Recovers from a forgotten password like the app does: derives the recovery
   * keys from the code, fetches and unwraps the code's wrap, then sets a new
   * password. `libraryKey` is the key the code unwrapped (when step one passed).
   */
  async recover(input: {
    code: string;
    secretKey: string;
    newPassword: string;
  }): Promise<ClientResponse & { libraryKey?: Buffer }> {
    const salts = await this.salts();
    const code = parseRecoveryCode(input.code);
    const secretKey = parseSecretKey(input.secretKey);
    if (salts.status !== 200 || code === null || secretKey === null) {
      throw new Error('recover: could not fetch salts or parse the code or Secret Key');
    }
    const recovery = deriveAccountKeys({
      secret: code,
      secretKey,
      salt: Buffer.from(salts.body.recoverySalt!, 'base64'),
    });
    const first = await request(this.app)
      .post('/api/v1/recovery')
      .send({ authKey: recovery.authKey.toString('base64') });
    if (first.status !== 200) return { status: first.status, body: first.body };

    // The wrap's AAD binds it to the library id, which the answer carries.
    const libraryId = first.body.libraryId as string;
    const libraryKey = open(
      recovery.kek,
      Buffer.from(first.body.wrap, 'base64'),
      keyWrapAad(libraryId, 'recovery')
    );
    const newPasswordSalt = crypto.randomBytes(16);
    const next = deriveAccountKeys({
      secret: Buffer.from(input.newPassword, 'utf8'),
      secretKey,
      salt: newPasswordSalt,
    });
    const second = await request(this.app)
      .post(`/api/v1/recovery/${first.body.recoveryId}/password`)
      .send({
        authKey: recovery.authKey.toString('base64'),
        newPasswordSalt: newPasswordSalt.toString('base64'),
        newAuthKey: next.authKey.toString('base64'),
        newPasswordWrap: seal(next.kek, libraryKey, keyWrapAad(libraryId, 'password')).toString(
          'base64'
        ),
      });
    return { status: second.status, body: second.body, libraryKey };
  }

  /** POST /recovery with an arbitrary body. */
  async postRecovery(body: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .post('/api/v1/recovery')
      .send(body as object);
    return { status: res.status, body: res.body };
  }

  /** POST /recovery/:id/password with an arbitrary body. */
  async postRecoveryPassword(id: string, body: unknown): Promise<ClientResponse> {
    const res = await request(this.app)
      .post(`/api/v1/recovery/${id}/password`)
      .send(body as object);
    return { status: res.status, body: res.body };
  }

  /** Fetches the library, derives the current keys and unwraps the Library Key, as a signed-in Mac does. */
  private async unlock(input: { token: string; password: string; secretKey: string }) {
    const info = await this.libraryInfo(input.token);
    if (info.status !== 200) throw new Error(`unlock: library info answered ${info.status}`);
    const keys = deriveAccountKeys({
      secret: Buffer.from(input.password, 'utf8'),
      secretKey: parseSecretKey(input.secretKey)!,
      salt: Buffer.from(info.body.passwordSalt!, 'base64'),
    });
    const libraryId = info.body.id!;
    const libraryKey = open(
      keys.kek,
      Buffer.from(info.body.passwordWrap!, 'base64'),
      keyWrapAad(libraryId, 'password')
    );
    return { libraryKey, authKey: keys.authKey, libraryId };
  }

  /**
   * PUT /meetings/:id/blobs/:kind as the Mac sends it: the (already sealed)
   * bytes as `application/octet-stream`, their SHA-256 in `X-Scribe-Sha256`,
   * and the precondition. `ifMatch: null` sends `If-None-Match: *` (a first
   * write), a number sends `If-Match: <n>`, and leaving it out sends neither
   * (for the 412 test). `sha256` overrides the computed header, so a test can
   * claim one hash and send other bytes; `contentType` likewise.
   */
  async putMeetingBlob(input: {
    token: string;
    meetingId: string;
    kind: string;
    bytes: Buffer;
    ifMatch?: number | null;
    sha256?: string;
    contentType?: string;
  }): Promise<ClientResponse> {
    const req = request(this.app)
      .put(`/api/v1/meetings/${input.meetingId}/blobs/${input.kind}`)
      .set('Authorization', `Bearer ${input.token}`)
      .set('Content-Type', input.contentType ?? 'application/octet-stream')
      .set(
        'X-Scribe-Sha256',
        input.sha256 ?? crypto.createHash('sha256').update(input.bytes).digest('hex')
      );
    if (input.ifMatch === null) req.set('If-None-Match', '*');
    else if (input.ifMatch !== undefined) req.set('If-Match', String(input.ifMatch));
    const res = await req.send(input.bytes);
    return { status: res.status, body: res.body };
  }

  /** GET /meetings/:id/blobs/:kind; the bytes come back raw, never JSON-parsed. */
  async getMeetingBlob(input: {
    token: string;
    meetingId: string;
    kind: string;
    ifNoneMatch?: string;
  }): Promise<BlobResponse> {
    return this.getRawBlob(
      `/api/v1/meetings/${input.meetingId}/blobs/${input.kind}`,
      input.token,
      input.ifNoneMatch
    );
  }

  /** GET /meetings, one page. */
  async listMeetings(
    token: string,
    opts: { after?: string; limit?: number | string } = {}
  ): Promise<ClientResponse> {
    const query: Record<string, string> = {};
    if (opts.after !== undefined) query.after = opts.after;
    if (opts.limit !== undefined) query.limit = String(opts.limit);
    const res = await request(this.app)
      .get('/api/v1/meetings')
      .query(query)
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  async getMeeting(token: string, id: string): Promise<ClientResponse> {
    const res = await request(this.app)
      .get(`/api/v1/meetings/${id}`)
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  /** GET /changes; `since` and `limit` are sent verbatim when given, so tests can send garbage. */
  async changes(
    token: string,
    since?: number | string,
    limit?: number | string
  ): Promise<ClientResponse> {
    const query: Record<string, string> = {};
    if (since !== undefined) query.since = String(since);
    if (limit !== undefined) query.limit = String(limit);
    const res = await request(this.app)
      .get('/api/v1/changes')
      .query(query)
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  /**
   * PUT /library/blobs/<kind> (`tag-list` or `voice/<uuid>`), with the same
   * headers and precondition rules as `putMeetingBlob`. `kind` goes into the
   * path verbatim, so a test can send `voice/../x` or an empty kind.
   */
  async putLibraryBlob(input: {
    token: string;
    kind: string;
    bytes: Buffer;
    ifMatch?: number | null;
    sha256?: string;
  }): Promise<ClientResponse> {
    const req = request(this.app)
      .put(`/api/v1/library/blobs/${input.kind}`)
      .set('Authorization', `Bearer ${input.token}`)
      .set('Content-Type', 'application/octet-stream')
      .set(
        'X-Scribe-Sha256',
        input.sha256 ?? crypto.createHash('sha256').update(input.bytes).digest('hex')
      );
    if (input.ifMatch === null) req.set('If-None-Match', '*');
    else if (input.ifMatch !== undefined) req.set('If-Match', String(input.ifMatch));
    const res = await req.send(input.bytes);
    return { status: res.status, body: res.body };
  }

  /** GET /library/blobs/<kind>; the bytes come back raw, never JSON-parsed. */
  async getLibraryBlob(input: {
    token: string;
    kind: string;
    ifNoneMatch?: string;
  }): Promise<BlobResponse> {
    return this.getRawBlob(`/api/v1/library/blobs/${input.kind}`, input.token, input.ifNoneMatch);
  }

  /** DELETE /library/blobs/voice/<voiceId>. */
  async deleteVoice(token: string, voiceId: string): Promise<ClientResponse> {
    return this.deletePath(`/api/v1/library/blobs/voice/${voiceId}`, token);
  }

  /** DELETE /library/blobs/<kind> with any kind, for the 405 and 400 tests. */
  async deleteLibraryBlob(token: string, kind: string): Promise<ClientResponse> {
    return this.deletePath(`/api/v1/library/blobs/${kind}`, token);
  }

  /** DELETE /meetings/:id: tombstones the meeting. */
  async deleteMeeting(token: string, id: string): Promise<ClientResponse> {
    return this.deletePath(`/api/v1/meetings/${id}`, token);
  }

  /** POST /library/purge: empties the bin now instead of after the grace. */
  async purge(token: string): Promise<ClientResponse> {
    const res = await request(this.app)
      .post('/api/v1/library/purge')
      .set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  /** DELETE /library (keys lost): no credential, only the live setup code and the word DELETE. */
  async deleteLibrary(body: { setupCode?: unknown; confirm?: unknown }): Promise<ClientResponse> {
    const res = await request(this.app).delete('/api/v1/library').send(body);
    return { status: res.status, body: res.body };
  }

  private async deletePath(url: string, token: string): Promise<ClientResponse> {
    const res = await request(this.app).delete(url).set('Authorization', `Bearer ${token}`);
    return { status: res.status, body: res.body };
  }

  private async getRawBlob(
    url: string,
    token: string,
    ifNoneMatch: string | undefined
  ): Promise<BlobResponse> {
    const req = request(this.app)
      .get(url)
      .set('Authorization', `Bearer ${token}`)
      .buffer(true)
      .parse((res, done) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => done(null, Buffer.concat(chunks)));
      });
    if (ifNoneMatch !== undefined) req.set('If-None-Match', ifNoneMatch);
    const res = await req;
    const bytes = Buffer.isBuffer(res.body) ? res.body : Buffer.alloc(0);
    const isJson = String(res.headers['content-type'] ?? '').startsWith('application/json');
    return {
      status: res.status,
      bytes,
      body: isJson ? (JSON.parse(bytes.toString('utf8')) as ClientBody) : {},
      etag: res.headers.etag,
      sha256: res.headers['x-scribe-sha256'],
      contentType: res.headers['content-type'],
      contentLength: res.headers['content-length'],
    };
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
