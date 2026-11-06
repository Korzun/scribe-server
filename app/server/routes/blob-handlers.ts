import { createHash } from 'crypto';
import { pipeline, type Readable } from 'stream';

import express, { type NextFunction, type Request, type Response } from 'express';

import { isSealed } from '../crypto/seal';
import { logger } from '../logger';
import { getBlob, putBlob, type BlobsDeps } from '../services/blobs';

const log = logger('BlobRoute');

/**
 * The blob `PUT` and `GET` that meeting blobs (`routes/meetings.ts`) and
 * library blobs (`routes/library-blobs.ts`) share (spec §6): the same headers,
 * limits and status codes, whatever the scope. Each router turns its URL into
 * a validated `{ scope, kind }` first (anything else is its own 400 or 404,
 * before anything here runs) and then hands over.
 *
 * Every byte that arrives here was sealed on a Mac; the vault cannot read it
 * and never tries. It checks only what it can without a key: the body hashes
 * to the `X-Scribe-Sha256` the Mac declared (so a body damaged in transit is
 * refused before anything touches disk), and it starts with the `SCRB\x01`
 * header (so a client bug that forgets to seal is refused rather than stored
 * as plaintext at rest, the one thing spec §1 forbids outright).
 *
 * Nothing here logs a body or a blob: only `scope/kind`, revision, size and
 * status (the service logs the outcome of each write).
 */

/** A blob the router has already validated: a lowercase meeting id or `'library'`, and a known kind. */
export type BlobTarget = { scope: string; kind: string };

const SHA256_RE = /^[0-9a-f]{64}$/;

/**
 * The precondition of a blob write (spec §6): exactly one of `If-Match: <n>`
 * (the revision the Mac last saw; the quoted ETag form `"<n>"` is accepted
 * too) or `If-None-Match: *` (a first write). `null` = a first write;
 * `undefined` = no usable precondition, which is a 412.
 */
function parsePrecondition(req: Request): number | null | undefined {
  const ifMatch = req.get('If-Match');
  const ifNoneMatch = req.get('If-None-Match');
  if (ifMatch !== undefined && ifNoneMatch !== undefined) return undefined;
  if (ifNoneMatch !== undefined) return ifNoneMatch.trim() === '*' ? null : undefined;
  if (ifMatch === undefined) return undefined;
  const m = /^"?(\d{1,9})"?$/.exec(ifMatch.trim());
  return m ? Number(m[1]) : undefined;
}

// Only the blob routes read a raw body: 32 MiB covers every artifact and a
// short recording; longer audio goes through chunked uploads (Task 10). An
// oversized body is a clean 413 rather than the generic 500.
const rawBody = express.raw({ type: 'application/octet-stream', limit: '32mb' });
export function readRawBody(req: Request, res: Response, next: NextFunction): void {
  rawBody(req, res, (err?: unknown) => {
    if (err !== undefined && err !== null) {
      const status = (err as { status?: number }).status;
      if (status === 413) {
        res.status(413).json({ error: 'Payload too large' });
        return;
      }
      if (status !== undefined && status >= 400 && status < 500) {
        res.status(400).json({ error: 'Invalid request' });
        return;
      }
      next(err);
      return;
    }
    next();
  });
}

/**
 * Writes one blob revision from a raw body: 400 for a missing or malformed
 * hash header or a non-octet-stream body, 412 without a usable precondition,
 * 400 for a hash mismatch or an unsealed body, then 201 (first revision) or
 * 200, 409 with the current revision, or 410 for a deleted meeting.
 */
export async function handleBlobPut(
  deps: BlobsDeps,
  req: Request,
  res: Response,
  { scope, kind }: BlobTarget
): Promise<void> {
  const declared = req.get('X-Scribe-Sha256');
  if (declared === undefined || !SHA256_RE.test(declared) || !Buffer.isBuffer(req.body)) {
    res.status(400).json({ error: 'Invalid request' });
    return;
  }
  const ifMatch = parsePrecondition(req);
  if (ifMatch === undefined) {
    res.status(412).json({ error: 'Precondition required' });
    return;
  }
  const bytes = req.body;
  if (createHash('sha256').update(bytes).digest('hex') !== declared) {
    log.warn(`Blob refused: ${scope}/${kind} body does not match its declared hash`);
    res.status(400).json({ error: 'Hash mismatch' });
    return;
  }
  if (!isSealed(bytes)) {
    log.warn(`Blob refused: ${scope}/${kind} is not a sealed blob`);
    res.status(400).json({ error: 'Not a sealed blob' });
    return;
  }

  const result = await putBlob(deps, {
    scope,
    kind,
    bytes,
    sha256: declared,
    size: bytes.length,
    ifMatch,
    deviceId: req.owner?.via === 'device' ? req.owner.deviceId : null,
    epoch: req.vaultEpoch,
  });
  if (!result.ok) {
    if (result.reason === 'gone') {
      res.status(410).json({ error: 'Meeting deleted' });
    } else {
      res.status(409).json({ error: 'Revision conflict', currentRevision: result.currentRevision });
    }
    return;
  }
  res.status(result.created ? 201 : 200).json({
    revision: result.revision,
    seq: result.seq,
    sha256: result.sha256,
    size: result.size,
  });
}

/**
 * Streams the current revision of one blob with `ETag: "<revision>"` and
 * `X-Scribe-Sha256`; 304 on a matching `If-None-Match` (answered from the row
 * alone, the file is never opened); 404 when there is no such blob.
 */
export async function handleBlobGet(
  deps: Pick<BlobsDeps, 'prisma' | 'blobStore'>,
  req: Request,
  res: Response,
  { scope, kind }: BlobTarget
): Promise<void> {
  const blob = await getBlob(deps, scope, kind);
  if (blob === null) {
    res.status(404).json({ error: 'Not found' });
    return;
  }
  const etag = `"${blob.revision}"`;
  res.set('ETag', etag);
  res.set('X-Scribe-Sha256', blob.sha256);
  if (req.get('If-None-Match') === etag) {
    res.status(304).end();
    return;
  }

  // Open before any status goes out, so a row whose file is missing (an
  // orphan, or an overwrite that unlinked it after the row was read) is a
  // clean 404 instead of a connection reset after the headers.
  let stream: Readable;
  try {
    stream = await blob.openStream();
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code ?? 'error';
    log.error(`Blob file missing: ${scope}/${kind} revision ${blob.revision}: ${code}`);
    res.removeHeader('ETag');
    res.removeHeader('X-Scribe-Sha256');
    res.status(404).json({ error: 'Not found' });
    return;
  }

  res.status(200);
  res.set('Content-Type', 'application/octet-stream');
  res.set('Content-Length', String(blob.size));
  // `pipeline`, not `pipe`: when the Mac goes away mid-download (sleep, a
  // network change) it destroys the file stream too, so its descriptor is
  // closed rather than left open for good. A read error after the headers
  // can no longer become a status; pipeline cuts the connection, and the
  // Mac sees a short read that fails its hash check.
  pipeline(stream, res, (err) => {
    if (err === undefined || err === null) return;
    if ((err as NodeJS.ErrnoException).code === 'ERR_STREAM_PREMATURE_CLOSE') {
      log.debug(`Blob download aborted by the client: ${scope}/${kind}`);
    } else {
      log.error(`Blob read failed: ${scope}/${kind}: ${err.message}`);
    }
  });
}
