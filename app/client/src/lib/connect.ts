import { guarded, unlock } from './account';
import { api, type ApiResult } from './api';
import { toBase64 } from './bytes';
import { formatSecretKey, parseSecretKey } from './codes';
import { deriveTokenKek, hashTokenSecret, toBase64Url } from './kdf';
import { seal, tokenWrapAad } from './seal';

/**
 * The consent page's side of the key chain (spec §10). An assistant that
 * holds an OAuth token cannot decrypt anything; the vault decrypts for it,
 * and it can only because this code, running with the owner signed in,
 * unwrapped the Library Key here and sealed it under a key only the
 * authorization code can derive. The vault is sent the code's hash and that
 * wrap; the code itself goes to the assistant in the redirect and never to
 * the vault until the assistant exchanges it. Pure over `api` and the crypto
 * libs, no React. Nothing here logs.
 */

/**
 * The parameters the vault's authorize endpoint forwarded to `/connect`. They
 * are a CLAIM: the vault re-validates the client and redirect URI before
 * writing a code or answering with a URL, so this module only reads them.
 */
export type ConsentRequest = {
  clientId: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  scope: string | null;
  resource: string | null;
};

export const readConsentRequest = (params: URLSearchParams): ConsentRequest | null => {
  const clientId = params.get('client_id');
  const redirectUri = params.get('redirect_uri');
  const codeChallenge = params.get('code_challenge');
  if (!clientId || !redirectUri || !codeChallenge) return null;
  return {
    clientId,
    redirectUri,
    codeChallenge,
    state: params.get('state'),
    scope: params.get('scope'),
    resource: params.get('resource'),
  };
};

export type ConsentClient = { clientId: string; clientName: string; clientUri: string | null };

export const loadConsentClient = (clientId: string) =>
  api<ConsentClient>(`/api/v1/mcp/clients/${encodeURIComponent(clientId)}`);

/** Where the browser must go next: the assistant's redirect URI with `state`, plus `code` or `error`. */
export type Decision = { redirectUrl: string };

const CODE_LENGTH = 32;
const INVALID_SECRET_KEY: Extract<ApiResult<never>, { ok: false }> = {
  ok: false,
  status: 400,
  error: 'Invalid secret key',
};

const consentBody = (request: ConsentRequest, approve: boolean) => ({
  clientId: request.clientId,
  redirectUri: request.redirectUri,
  codeChallenge: request.codeChallenge,
  state: request.state,
  scope: request.scope,
  resource: request.resource,
  approve,
});

/** Deny needs no key: the vault answers with the registered URI carrying `error=access_denied`. */
export const denyConnection = (request: ConsentRequest): Promise<ApiResult<Decision>> =>
  api<Decision>('/api/v1/mcp/authorize', {
    method: 'POST',
    body: JSON.stringify(consentBody(request, false)),
  });

/**
 * Approve: unlock the Library Key with the password and Secret Key, mint the
 * authorization code, seal the key under the code's derived key, send the
 * vault the hash and the wrap, and append the code to the URL it answers
 * with. Returns the formatted Secret Key too, so the page can remember it on
 * this browser after a first-time entry, as sign-in does.
 */
export async function approveConnection({
  request,
  password,
  secretKey: secretKeyText,
}: {
  request: ConsentRequest;
  password: string;
  secretKey: string;
}): Promise<ApiResult<Decision & { secretKey: string }>> {
  const secretKey = parseSecretKey(secretKeyText);
  if (secretKey === null) return INVALID_SECRET_KEY;
  return guarded(async () => {
    const unlocked = await unlock(password, secretKey);
    if (!unlocked.ok) return unlocked;
    const { libraryId, libraryKey } = unlocked.body;

    const code = crypto.getRandomValues(new Uint8Array(CODE_LENGTH));
    const wire = toBase64Url(code);
    const codeHash = await hashTokenSecret(wire);
    const kek = await deriveTokenKek(code);
    const wrap = await seal(kek, libraryKey, tokenWrapAad(libraryId, 'code', codeHash));
    kek.fill(0);
    libraryKey.fill(0);

    const result = await api<Decision>('/api/v1/mcp/authorize', {
      method: 'POST',
      body: JSON.stringify({ ...consentBody(request, true), codeHash, wrap: toBase64(wrap) }),
    });
    if (!result.ok) return result;
    const url = new URL(result.body.redirectUrl);
    url.searchParams.set('code', wire);
    return {
      ok: true,
      status: result.status,
      body: { redirectUrl: url.href, secretKey: formatSecretKey(secretKey) },
    };
  });
}
