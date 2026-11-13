import { useActionState, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { Card, Page } from '~/component';
import { Button, TextInput } from '~/control';
import { api } from '~/lib/api';
import { rememberSecretKey } from '~/lib/secret-key-store';
import { createLibrary, type Kit, KIT_FILE_NAME, kitFileText, prepareLibrary } from '~/lib/setup';
import { extractAccessToken } from '~/lib/token';
import { useAuth } from '~/provider/auth';
import { useToast } from '~/provider/toast';
import { path } from '~/router';

import { useStyle } from './style';

const MIN_SETUP_CODE_LENGTH = 12;

const CHOOSE_PASSWORD =
  'Choose a password. It is never sent to the vault and cannot be recovered without the kit on the next step.';
const MISMATCH = "The passwords don't match";
const SHORT_SETUP_CODE = `The setup code is at least ${MIN_SETUP_CODE_LENGTH} characters`;
const KIT_INTRO =
  'This is your kit. The Secret Key and your password together unlock the library; a recovery code replaces a forgotten password, once, and needs the Secret Key too. Nothing here can be shown again.';
const SAVED = 'I have saved my Secret Key and recovery codes somewhere safe.';
const NO_CRYPTO = 'This browser cannot derive your keys here — open the vault over HTTPS';
const NETWORK_ERROR = 'Network error — please try again';
const LIBRARY_EXISTS = 'A library already exists here — sign in';

type Status = { libraryExists: boolean; version: string; publicUrl: string | null };

/**
 * First-run setup (Docker-first design §7). A fresh vault has no library;
 * this page makes one from the browser. Step one takes a password and the
 * setup code; step two generates the kit here, shows it, and creates the
 * library only once the owner says the kit is saved. A wrong setup code keeps
 * the kit on screen so the owner retries with the same Secret Key.
 */
export const SetupPage = () => {
  const styles = useStyle();
  const navigate = useNavigate();
  const toast = useToast();
  const { signIn } = useAuth();

  // null while GET /status is in flight.
  const [status, setStatus] = useState<Status | null>(null);
  const [password, setPassword] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<string | undefined>();
  const [setupCode, setSetupCode] = useState<string | undefined>();
  const [mismatch, setMismatch] = useState(false);
  const [shortCode, setShortCode] = useState(false);
  const [kit, setKit] = useState<Kit | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<Status>('/api/v1/status').then((result) => {
      if (cancelled) return;
      if (result.ok && result.body.libraryExists) {
        void navigate(path.login(), { replace: true });
        return;
      }
      // An unreachable status check still shows the form: creation reports
      // the failure itself.
      setStatus(result.ok ? result.body : { libraryExists: false, version: '', publicUrl: null });
    });
    return () => {
      cancelled = true;
    };
  }, [navigate]);

  const incomplete = !password || !confirm || !setupCode;

  const [, continueAction, preparing] = useActionState(async () => {
    if ((password ?? '') !== (confirm ?? '')) {
      setMismatch(true);
      return null;
    }
    if (Array.from(setupCode ?? '').length < MIN_SETUP_CODE_LENGTH) {
      setShortCode(true);
      return null;
    }
    if (incomplete) return null;
    try {
      setKit(await prepareLibrary(password));
    } catch {
      // WebCrypto exists only in a secure context (HTTPS or localhost).
      toast(NO_CRYPTO, 'error');
    }
    return null;
  }, null);

  const [, createAction, creating] = useActionState(async () => {
    if (kit === null || !saved || !setupCode) return null;
    const result = await createLibrary(kit, setupCode);
    if (result.ok) {
      const session = await api<unknown>('/api/v1/session', {
        method: 'POST',
        body: JSON.stringify({ authKey: kit.authKey }),
      });
      const accessToken = session.ok ? extractAccessToken(session.body) : null;
      rememberSecretKey(kit.secretKey);
      if (accessToken === null) {
        // The library exists; only the automatic sign-in failed.
        toast('Library created — sign in with your password and Secret Key', 'success');
        void navigate(path.login());
        return null;
      }
      signIn(accessToken);
      return null;
    }
    switch (result.status) {
      case 409:
        toast(LIBRARY_EXISTS, 'error');
        void navigate(path.login());
        break;
      case 429:
        toast(
          result.retryAfterSeconds !== undefined
            ? `Too many attempts — try again in ${result.retryAfterSeconds} seconds`
            : 'Too many attempts — please wait a moment and try again',
          'error'
        );
        break;
      case 0:
        toast(NETWORK_ERROR, 'error');
        break;
      default:
        // 403: wrong or missing setup code. The kit stays; only the code changes.
        toast(result.error, 'error');
    }
    return null;
  }, null);

  const vaultUrl = status?.publicUrl ?? window.location.origin;

  const download = () => {
    if (kit === null) return;
    const url = URL.createObjectURL(new Blob([kitFileText(kit, vaultUrl)], { type: 'text/plain' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = KIT_FILE_NAME;
    link.click();
    URL.revokeObjectURL(url);
  };

  const copy = async () => {
    if (kit === null) return;
    try {
      await navigator.clipboard.writeText(kitFileText(kit, vaultUrl));
      toast('Kit copied', 'success');
    } catch {
      toast("Couldn't copy — select the text and copy it by hand", 'error');
    }
  };

  if (status === null) return null;

  return (
    <Page type="minimal">
      <div className={styles.root}>
        <div className={styles.stack}>
          {kit === null ? (
            <Card title="Create your library">
              <form className={styles.form} action={continueAction}>
                <p className={styles.explain}>{CHOOSE_PASSWORD}</p>
                <div className={styles.inputContainer}>
                  <TextInput
                    placeholder="Password"
                    name="password"
                    autoComplete="new-password"
                    password
                    onChange={(next) => {
                      setPassword(next);
                      setMismatch(false);
                    }}
                    value={password}
                  />
                  <TextInput
                    placeholder="Confirm password"
                    name="confirmPassword"
                    autoComplete="new-password"
                    password
                    onChange={(next) => {
                      setConfirm(next);
                      setMismatch(false);
                    }}
                    value={confirm}
                  />
                  {mismatch && (
                    <div role="alert" className={styles.error}>
                      {MISMATCH}
                    </div>
                  )}
                  <TextInput
                    placeholder="Setup code"
                    name="setupCode"
                    autoComplete="off"
                    password
                    onChange={(next) => {
                      setSetupCode(next);
                      setShortCode(false);
                    }}
                    value={setupCode}
                  />
                  {shortCode && (
                    <div role="alert" className={styles.error}>
                      {SHORT_SETUP_CODE}
                    </div>
                  )}
                </div>
                <Button
                  submit
                  disabled={incomplete}
                  loading={preparing}
                  type="primary"
                  radius="card"
                >
                  Continue
                </Button>
              </form>
            </Card>
          ) : (
            <Card title="Your kit">
              <form className={styles.form} action={createAction}>
                <p className={styles.explain}>{KIT_INTRO}</p>
                <div className={styles.kitLabel}>Secret Key</div>
                <div className={styles.secretKey}>{kit.secretKey}</div>
                <div className={styles.kitLabel}>Recovery codes</div>
                <ul className={styles.codes}>
                  {kit.recoveryCodes.map((code) => (
                    <li key={code}>{code}</li>
                  ))}
                </ul>
                <div className={styles.actions}>
                  <Button onClick={() => void copy()}>Copy</Button>
                  <Button onClick={download}>Download kit</Button>
                </div>
                <label className={styles.saved}>
                  <input
                    type="checkbox"
                    name="saved"
                    checked={saved}
                    onChange={(event) => setSaved(event.target.checked)}
                  />
                  <span>{SAVED}</span>
                </label>
                <div className={styles.inputContainer}>
                  <TextInput
                    placeholder="Setup code"
                    name="setupCode"
                    autoComplete="off"
                    password
                    onChange={setSetupCode}
                    value={setupCode}
                  />
                </div>
                <Button
                  submit
                  disabled={!saved || !setupCode}
                  loading={creating}
                  type="primary"
                  radius="card"
                >
                  Create library
                </Button>
              </form>
            </Card>
          )}
          <Button type="default" onClick={() => void navigate(path.login())}>
            Already have a library? Sign in
          </Button>
        </div>
      </div>
    </Page>
  );
};
