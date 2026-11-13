import * as crypto from 'crypto';

import {
  formatRecoveryCode,
  formatSecretKey,
  generateRecoveryCode,
  generateSecretKey,
  parseRecoveryCode,
  parseSecretKey,
} from '../crypto/codes';
import { deriveAccountKeys, passwordBytes } from '../crypto/kdf';
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
  changes?: ChangeEntry[];
  nextSince?: number;
  hasMore?: boolean;
  purgedMeetings?: number;
  removedFiles?: number;
  uploadId?: string;
  partSize?: number;
  expiresAt?: number;
  parts?: number[];
  missing?: number[];
};

export type MeetingBlobEntry = { kind: string; revision: number; sha256: string; size: number };

export type ChangeEntry = {
  seq: number;
  meetingId: string | null;
  kind: string;
  revision: number;
  sha256: string | null;
  size: number | null;
  deleted: boolean;
  deviceId: string | null;
  at: string;
};

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
 * One request as the client builds it. `json` is sent as a JSON body exactly
 * as given (any value, so shape tests can send garbage); `bytes` as the raw
 * body, with whatever `Content-Type` the headers name. `path` carries the
 * query string already.
 */
export type TransportRequest = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  headers?: Record<string, string>;
  json?: unknown;
  bytes?: Buffer;
};

/** The answer, never parsed: header names lowercased, `set-cookie` as a list. */
export type TransportResponse = {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  bytes: Buffer;
};

/**
 * How a request reaches a vault: supertest against the in-process app in the
 * tests (`vault-client.ts`), `fetch` against a running one in the CLI.
 */
export type Transport = (req: TransportRequest) => Promise<TransportResponse>;

/** A `Transport` over `fetch` to the vault at `origin` (e.g. `http://localhost:3000`). */
export function fetchTransport(origin: string): Transport {
  const base = origin.replace(/\/+$/, '');
  return async (req) => {
    const headers: Record<string, string> = { ...req.headers };
    let body: Uint8Array | string | undefined;
    if (req.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(req.json);
    } else if (req.bytes !== undefined) {
      body = req.bytes;
    }
    const res = await fetch(base + req.path, { method: req.method, headers, body });
    const out: Record<string, string | string[]> = {};
    res.headers.forEach((value, name) => {
      out[name] = value;
    });
    const cookies = res.headers.getSetCookie();
    if (cookies.length > 0) out['set-cookie'] = cookies;
    return { status: res.status, headers: out, bytes: Buffer.from(await res.arrayBuffer()) };
  };
}

const header = (res: TransportResponse, name: string): string | undefined => {
  const value = res.headers[name];
  return Array.isArray(value) ? value[0] : value;
};

/** The JSON body when the answer is JSON, else `{}` (as supertest reports a body it did not parse). */
function jsonBody(res: TransportResponse): ClientBody {
  const isJson = String(header(res, 'content-type') ?? '').startsWith('application/json');
  if (!isJson || res.bytes.length === 0) return {};
  return JSON.parse(res.bytes.toString('utf8')) as ClientBody;
}

const sha256Hex = (bytes: Buffer) => crypto.createHash('sha256').update(bytes).digest('hex');

const withQuery = (path: string, query: Record<string, string>) => {
  const qs = new URLSearchParams(query).toString();
  return qs === '' ? path : `${path}?${qs}`;
};

/**
 * Speaks the vault's HTTP API the way the app does, over any `Transport`: one
 * place that knows every route's method, path, headers and body, shared by
 * the route tests (`VaultClient`) and the command-line client
 * (`scripts/vault-cli.ts`). It grows with every task: each later route gets a
 * method here so no route test hand-rolls its own requests.
 */
export class HttpVaultClient {
  /** The access token from the last `login`/`refresh`; pass it wherever a device token goes. */
  accessToken: string | null = null;
  /** The `refresh_token=<value>` pair from the last `login`/`refresh`, as a browser's cookie jar would hold it. */
  refreshCookie: string | null = null;

  constructor(private readonly transport: Transport) {}

  private async send(req: TransportRequest): Promise<ClientResponse & { raw: TransportResponse }> {
    const raw = await this.transport(req);
    return { status: raw.status, body: jsonBody(raw), raw };
  }

  private async call(req: TransportRequest): Promise<ClientResponse> {
    const { status, body } = await this.send(req);
    return { status, body };
  }

  private authed(
    method: TransportRequest['method'],
    path: string,
    token: string,
    rest: Omit<TransportRequest, 'method' | 'path'> = {}
  ): Promise<ClientResponse> {
    return this.call({
      method,
      path,
      ...rest,
      headers: { Authorization: `Bearer ${token}`, ...rest.headers },
    });
  }

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
      secret: passwordBytes(input.password),
      secretKey,
      salt: Buffer.from(salts.body.passwordSalt, 'base64'),
    });
    return this.postSession({ authKey: authKey.toString('base64') });
  }

  /** POST /session with an arbitrary body (shape tests, wrong keys); keeps any session it opens. */
  async postSession(body: unknown): Promise<ClientResponse> {
    const res = await this.send({ method: 'POST', path: '/api/v1/session', json: body });
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
    const res = await this.send({
      method: 'POST',
      path: '/api/v1/session/refresh',
      headers: cookie === null ? {} : { Cookie: cookie },
    });
    this.keep(res);
    return { status: res.status, body: res.body };
  }

  /** Ends the session presented by `cookie` (default: the stored one). */
  async logout(
    cookie: string | null = this.refreshCookie
  ): Promise<ClientResponse & { setCookie: string[] }> {
    const res = await this.send({
      method: 'POST',
      path: '/api/v1/session/logout',
      headers: cookie === null ? {} : { Cookie: cookie },
    });
    this.keep(res);
    return { status: res.status, body: res.body, setCookie: setCookies(res.raw) };
  }

  /** Mirrors a browser: a new refresh cookie replaces the old one, a cleared one drops the session. */
  private keep(res: ClientResponse & { raw: TransportResponse }): void {
    if (typeof res.body.accessToken === 'string') this.accessToken = res.body.accessToken;
    const cookie = setCookies(res.raw).find((c) => c.startsWith('refresh_token='));
    if (cookie === undefined) return;
    const pair = cookie.split(';')[0]!;
    if (pair === 'refresh_token=') {
      this.refreshCookie = null;
      this.accessToken = null;
    } else {
      this.refreshCookie = pair;
    }
  }

  async status(): Promise<ClientResponse> {
    return this.call({ method: 'GET', path: '/api/v1/status' });
  }

  async salts(): Promise<ClientResponse> {
    return this.call({ method: 'GET', path: '/api/v1/library/salts' });
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
      secret: passwordBytes(input.password),
      secretKey,
      salt: Buffer.from(salts.body.passwordSalt, 'base64'),
    });
    return this.postDevice({ authKey: authKey.toString('base64'), name: input.name });
  }

  /** POST /devices with an arbitrary body, for shape-validation tests. */
  async postDevice(body: unknown): Promise<ClientResponse> {
    return this.call({ method: 'POST', path: '/api/v1/devices', json: body });
  }

  async devices(token: string): Promise<ClientResponse> {
    return this.authed('GET', '/api/v1/devices', token);
  }

  async renameDevice(token: string, id: string, name: string): Promise<ClientResponse> {
    return this.authed('PATCH', `/api/v1/devices/${id}`, token, { json: { name } });
  }

  async revokeDevice(token: string, id: string): Promise<ClientResponse> {
    return this.authed('DELETE', `/api/v1/devices/${id}`, token);
  }

  /** GET /library: the owner's view of the library's public material. */
  async libraryInfo(token: string): Promise<ClientResponse> {
    return this.authed('GET', '/api/v1/library', token);
  }

  /** PUT /library/password with an arbitrary body (wrong keys, shape tests). */
  async putPassword(token: string, body: unknown): Promise<ClientResponse> {
    return this.authed('PUT', '/api/v1/library/password', token, { json: body });
  }

  /** PUT /library/recovery-codes with an arbitrary body. */
  async putRecoveryCodes(token: string, body: unknown): Promise<ClientResponse> {
    return this.authed('PUT', '/api/v1/library/recovery-codes', token, { json: body });
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
      secret: passwordBytes(input.newPassword),
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
    const first = await this.postRecovery({ authKey: recovery.authKey.toString('base64') });
    if (first.status !== 200) return first;

    // The wrap's AAD binds it to the library id, which the answer carries.
    const libraryId = first.body.libraryId!;
    const libraryKey = open(
      recovery.kek,
      Buffer.from(first.body.wrap!, 'base64'),
      keyWrapAad(libraryId, 'recovery')
    );
    const newPasswordSalt = crypto.randomBytes(16);
    const next = deriveAccountKeys({
      secret: passwordBytes(input.newPassword),
      secretKey,
      salt: newPasswordSalt,
    });
    const second = await this.postRecoveryPassword(first.body.recoveryId!, {
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
    return this.call({ method: 'POST', path: '/api/v1/recovery', json: body });
  }

  /** POST /recovery/:id/password with an arbitrary body. */
  async postRecoveryPassword(id: string, body: unknown): Promise<ClientResponse> {
    return this.call({ method: 'POST', path: `/api/v1/recovery/${id}/password`, json: body });
  }

  /**
   * Fetches the library, derives the current keys and unwraps the Library
   * Key, as a signed-in Mac does. Throws when the library cannot be read or
   * the password and Secret Key do not open its wrap.
   */
  async unlock(input: { token: string; password: string; secretKey: string }) {
    const info = await this.libraryInfo(input.token);
    if (info.status !== 200) throw new Error(`unlock: library info answered ${info.status}`);
    const secretKey = parseSecretKey(input.secretKey);
    if (secretKey === null) throw new Error('unlock: could not parse the Secret Key');
    const keys = deriveAccountKeys({
      secret: passwordBytes(input.password),
      secretKey,
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
    return this.putBlob(`/api/v1/meetings/${input.meetingId}/blobs/${input.kind}`, input);
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
    return this.authed('GET', withQuery('/api/v1/meetings', query), token);
  }

  async getMeeting(token: string, id: string): Promise<ClientResponse> {
    return this.authed('GET', `/api/v1/meetings/${id}`, token);
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
    return this.authed('GET', withQuery('/api/v1/changes', query), token);
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
    return this.putBlob(`/api/v1/library/blobs/${input.kind}`, input);
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
    return this.authed('DELETE', `/api/v1/library/blobs/voice/${voiceId}`, token);
  }

  /** DELETE /library/blobs/<kind> with any kind, for the 405 and 400 tests. */
  async deleteLibraryBlob(token: string, kind: string): Promise<ClientResponse> {
    return this.authed('DELETE', `/api/v1/library/blobs/${kind}`, token);
  }

  /** DELETE /meetings/:id: tombstones the meeting. */
  async deleteMeeting(token: string, id: string): Promise<ClientResponse> {
    return this.authed('DELETE', `/api/v1/meetings/${id}`, token);
  }

  /** POST /library/purge: empties the bin now instead of after the grace. */
  async purge(token: string): Promise<ClientResponse> {
    return this.authed('POST', '/api/v1/library/purge', token);
  }

  /** DELETE /library (keys lost): no credential, only the live setup code and the word DELETE. */
  async deleteLibrary(body: { setupCode?: unknown; confirm?: unknown }): Promise<ClientResponse> {
    return this.call({ method: 'DELETE', path: '/api/v1/library', json: body });
  }

  /**
   * POST /uploads: begins a chunked upload (spec §7). The body is sent as
   * given, so a test can send any shape; the Mac sends `{ meetingId, kind,
   * size, sha256, partSize?, ifMatch }`.
   */
  async beginUpload(token: string, body: unknown): Promise<ClientResponse> {
    return this.authed('POST', '/api/v1/uploads', token, { json: body });
  }

  /** PUT /uploads/:id/parts/:n with the part's bytes as `application/octet-stream`. */
  async putPart(
    token: string,
    uploadId: string,
    n: number | string,
    bytes: Buffer
  ): Promise<ClientResponse> {
    return this.authed('PUT', `/api/v1/uploads/${uploadId}/parts/${n}`, token, {
      headers: { 'Content-Type': 'application/octet-stream' },
      bytes,
    });
  }

  /** GET /uploads/:id: which parts the vault has, so a Mac can resume. */
  async inspectUpload(token: string, uploadId: string): Promise<ClientResponse> {
    return this.authed('GET', `/api/v1/uploads/${uploadId}`, token);
  }

  /** POST /uploads/:id/complete: assemble, verify, store. */
  async completeUpload(token: string, uploadId: string): Promise<ClientResponse> {
    return this.authed('POST', `/api/v1/uploads/${uploadId}/complete`, token);
  }

  /** DELETE /uploads/:id: abandons the session and its parts. */
  async abortUpload(token: string, uploadId: string): Promise<ClientResponse> {
    return this.authed('DELETE', `/api/v1/uploads/${uploadId}`, token);
  }

  /**
   * The whole dance as the Mac performs it (spec §7): begin with the blob's
   * size and SHA-256, PUT every part (last first, to prove order does not
   * matter), complete. Returns the begin answer if it fails, else the
   * completion answer, whose `sha256` the Mac compares with its own before
   * deleting anything. `meetingId: null` uploads a library blob.
   */
  async upload(input: {
    token: string;
    meetingId: string | null;
    kind: string;
    bytes: Buffer;
    partSize: number;
    ifMatch: number | null;
  }): Promise<ClientResponse> {
    const begun = await this.beginUpload(input.token, {
      meetingId: input.meetingId,
      kind: input.kind,
      size: input.bytes.length,
      sha256: sha256Hex(input.bytes),
      partSize: input.partSize,
      ifMatch: input.ifMatch,
    });
    if (begun.status !== 201) return begun;
    const { uploadId, partSize } = begun.body as { uploadId: string; partSize: number };
    const count = Math.ceil(input.bytes.length / partSize);
    for (let n = count - 1; n >= 0; n--) {
      const part = input.bytes.subarray(n * partSize, (n + 1) * partSize);
      const res = await this.putPart(input.token, uploadId, n, part);
      if (res.status !== 204) throw new Error(`upload: part ${n} answered ${res.status}`);
    }
    return this.completeUpload(input.token, uploadId);
  }

  async createLibrary(input: unknown): Promise<ClientResponse> {
    return this.call({ method: 'POST', path: '/api/v1/library', json: input });
  }

  private putBlob(
    path: string,
    input: {
      token: string;
      bytes: Buffer;
      ifMatch?: number | null;
      sha256?: string;
      contentType?: string;
    }
  ): Promise<ClientResponse> {
    const headers: Record<string, string> = {
      'Content-Type': input.contentType ?? 'application/octet-stream',
      'X-Scribe-Sha256': input.sha256 ?? sha256Hex(input.bytes),
    };
    if (input.ifMatch === null) headers['If-None-Match'] = '*';
    else if (input.ifMatch !== undefined) headers['If-Match'] = String(input.ifMatch);
    return this.authed('PUT', path, input.token, { headers, bytes: input.bytes });
  }

  private async getRawBlob(
    path: string,
    token: string,
    ifNoneMatch: string | undefined
  ): Promise<BlobResponse> {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (ifNoneMatch !== undefined) headers['If-None-Match'] = ifNoneMatch;
    const { status, body, raw } = await this.send({ method: 'GET', path, headers });
    return {
      status,
      bytes: raw.bytes,
      body,
      etag: header(raw, 'etag'),
      sha256: header(raw, 'x-scribe-sha256'),
      contentType: header(raw, 'content-type'),
      contentLength: header(raw, 'content-length'),
    };
  }
}

function setCookies(res: TransportResponse): string[] {
  const value = res.headers['set-cookie'];
  return value === undefined ? [] : Array.isArray(value) ? value : [value];
}

/**
 * Builds the real, client-side material for a new library, as the Mac does
 * at setup: a fresh Secret Key, salts and Library Key, the password wrap, and
 * ten recovery codes each wrapping the key. Costs eleven PBKDF2 derivations.
 */
export function buildLibraryRequest(opts: { setupCode: string; password: string; name: string }) {
  const libraryId = crypto.randomUUID();
  const secretKeyBytes = generateSecretKey();
  const passwordSalt = crypto.randomBytes(16);
  const recoverySalt = crypto.randomBytes(16);
  const libraryKey = crypto.randomBytes(32);

  // One PBKDF2 (650 000 iterations) per code: the dominant cost of this helper.
  const password = deriveAccountKeys({
    secret: passwordBytes(opts.password),
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
    device: { name: opts.name },
  };
  return {
    body,
    libraryId,
    secretKey: formatSecretKey(secretKeyBytes),
    libraryKey,
    recoveryCodes: codes.map(formatRecoveryCode),
  };
}
