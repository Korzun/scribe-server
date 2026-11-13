import * as fs from 'fs';
import * as path from 'path';

import { SERVER_ROOT } from './server-root';

/**
 * The built admin client's output directory, `app/client/dist`.
 *
 * See `server-root.ts` for why this is anchored on `SERVER_ROOT` rather than
 * spelled relative to the importing module, and for the bug that cost.
 */
export const CLIENT_DIST_DIR = path.join(SERVER_ROOT, '..', 'client', 'dist');

/**
 * Checked per request rather than once at startup, so that a dev server which
 * was already running when the client got built starts serving it without a
 * restart. That is what makes `clientNotBuiltMessage`'s instruction honest: it
 * tells the reader to run the build, and following it has to be enough.
 */
export function clientIndexExists(clientDist: string): boolean {
  return fs.existsSync(path.join(clientDist, 'index.html'));
}

/**
 * The response body for "the SPA was asked for and there is no SPA on disk".
 *
 * This is the NORMAL state of the dev API server, not an anomaly, which is why
 * it gets a deliberate answer instead of being left to surface as an unhandled
 * ENOENT. A stack trace and `{"error":"Internal server error"}` both describe a
 * server bug; this is a missing build step, and the two want very different
 * things from whoever is reading.
 */
export function clientNotBuiltMessage(clientDist: string): string {
  return [
    'Client not built.',
    '',
    `This server serves the web UI from ${clientDist}, which has no index.html.`,
    'Build it with:  npm run build -w app/client',
    '',
    'In development the UI is normally served by vite on :5173, which proxies',
    '/api here — open that instead of this port.',
  ].join('\n');
}
