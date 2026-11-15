import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router';

import { Card, Page } from '~/component';
import { Button, PasswordPromptModal, type PasswordPromptValues } from '~/control';
import type { ApiResult } from '~/lib/api';
import {
  approveConnection,
  denyConnection,
  loadConsentClient,
  readConsentRequest,
  type ConsentClient,
} from '~/lib/connect';
import { recallSecretKey, rememberSecretKey } from '~/lib/secret-key-store';
import { useToast } from '~/provider/toast';

import { useStyle } from './style';

export const INVALID_LINK = 'This connection link is invalid.';
export const LEAD =
  'This assistant will be able to read your meetings through your vault while connected. ' +
  'Disconnect it here at any time.';
export const CAN_DO =
  'It can search and read transcripts, meetings and speakers. It cannot change anything.';
export const WHY_PASSWORD =
  'Approving asks for your password. It unwraps the Library Key here, in your browser, so the ' +
  'vault can answer the assistant.';

type ClientState =
  | { status: 'loading' }
  | { status: 'invalid' }
  | { status: 'ready'; client: ConsentClient };

/** A failure worded for a toast; never carries a secret. */
const failureMessage = (result: Extract<ApiResult<unknown>, { ok: false }>): string => {
  switch (result.status) {
    case 400:
      return result.error === 'Invalid secret key'
        ? "That doesn't look like a Secret Key"
        : result.error;
    case 401:
      return 'Invalid credentials';
    case 429:
      return 'Too many attempts — please wait a moment and try again';
    case 0:
      return 'Network error — please try again';
    default:
      return result.error;
  }
};

/**
 * The OAuth consent screen for MCP assistants (spec §10). `ProtectedRoute`
 * has already made sure the owner is signed in, and brought them back here
 * with the query string intact after `/login`. Approve asks for the password
 * again, every time: the browser needs it to unwrap the Library Key for the
 * assistant. Approve and Deny both go through the vault, which answers with
 * the URL to send the browser to, so an unregistered redirect URI can never
 * be followed from this page.
 */
export const ConnectPage = () => {
  const styles = useStyle();
  const toast = useToast();
  const [params] = useSearchParams();
  const request = useMemo(() => readConsentRequest(params), [params]);

  const [client, setClient] = useState<ClientState>({ status: 'loading' });
  const [remembered] = useState<string | null>(() => recallSecretKey());
  const [prompting, setPrompting] = useState(false);
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);

  useEffect(() => {
    if (request === null) return;
    let cancelled = false;
    void loadConsentClient(request.clientId).then((result) => {
      if (cancelled) return;
      setClient(result.ok ? { status: 'ready', client: result.body } : { status: 'invalid' });
    });
    return () => {
      cancelled = true;
    };
  }, [request]);

  const approve = async ({ password, secretKey }: PasswordPromptValues) => {
    if (request === null) return;
    setBusy('approve');
    const result = await approveConnection({
      request,
      password,
      secretKey: remembered ?? secretKey,
    });
    if (!result.ok) {
      setBusy(null);
      toast(failureMessage(result), 'error');
      return;
    }
    if (remembered === null) rememberSecretKey(result.body.secretKey);
    window.location.assign(result.body.redirectUrl);
  };

  const deny = async () => {
    if (request === null) return;
    setBusy('deny');
    const result = await denyConnection(request);
    if (!result.ok) {
      setBusy(null);
      toast(failureMessage(result), 'error');
      return;
    }
    window.location.assign(result.body.redirectUrl);
  };

  const invalid = request === null || client.status === 'invalid';
  const ready = request !== null && client.status === 'ready' ? client.client : null;

  return (
    <Page type="minimal">
      <div className={styles.root}>
        <div className={styles.stack}>
          <Card
            footer={
              ready !== null ? (
                <div className={styles.actions}>
                  <Button
                    radius="card"
                    loading={busy === 'deny'}
                    disabled={busy !== null}
                    onClick={() => void deny()}
                  >
                    Deny
                  </Button>
                  <Button
                    type="primary"
                    radius="card"
                    loading={busy === 'approve'}
                    disabled={busy !== null}
                    onClick={() => setPrompting(true)}
                  >
                    Approve
                  </Button>
                </div>
              ) : undefined
            }
          >
            <div className={styles.content}>
              {invalid ? (
                <p className={styles.lead}>{INVALID_LINK}</p>
              ) : ready === null ? (
                <p className={styles.lead}>Loading…</p>
              ) : (
                <>
                  <h2 className={styles.title}>
                    Connect{' '}
                    {ready.clientUri !== null ? (
                      <a href={ready.clientUri} target="_blank" rel="noopener noreferrer">
                        {ready.clientName}
                      </a>
                    ) : (
                      ready.clientName
                    )}
                    ?
                  </h2>
                  <p className={styles.lead}>{LEAD}</p>
                  <p className={styles.lead}>{CAN_DO}</p>
                  <p className={styles.meta}>{WHY_PASSWORD}</p>
                </>
              )}
            </div>
          </Card>
        </div>
      </div>
      <PasswordPromptModal
        isOpen={prompting}
        title="Unlock for this assistant"
        confirmText="Approve"
        askSecretKey={remembered === null}
        loading={busy === 'approve'}
        onCancel={() => setPrompting(false)}
        onSubmit={(values) => void approve(values)}
      />
    </Page>
  );
};
