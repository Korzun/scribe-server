import { useActionState, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';

import { Card, Page } from '~/component';
import { Button, TextInput } from '~/control';
import { api } from '~/lib/api';
import { fromBase64, toBase64 } from '~/lib/bytes';
import { formatSecretKey, parseSecretKey } from '~/lib/codes';
import { deriveAccountKeys, passwordBytes } from '~/lib/kdf';
import { forgetSecretKey, recallSecretKey, rememberSecretKey } from '~/lib/secret-key-store';
import { extractAccessToken } from '~/lib/token';
import { useAuth } from '~/provider/auth';
import { useToast } from '~/provider/toast';
import { path } from '~/router';

import { useStyle } from './style';

const NETWORK_ERROR = 'Network error — please try again';

type Status = { libraryExists: boolean; version: string };
type Salts = { passwordSalt: string; recoverySalt: string };

/**
 * Sign-in with the two secrets (spec §3): the password and the Secret Key.
 * Neither leaves the browser; both feed the key derivation here, and only the
 * derived `authKey` is posted. The Secret Key is remembered on this browser
 * after a successful sign-in, so next time only the password is typed.
 */
export const LoginPage = () => {
  const styles = useStyle();
  const navigate = useNavigate();
  const showToast = useToast();
  const { signIn } = useAuth();

  // null while GET /status is in flight.
  const [libraryExists, setLibraryExists] = useState<boolean | null>(null);
  const [password, setPassword] = useState<string | undefined>();
  const [remembered, setRemembered] = useState<string | null>(() => recallSecretKey());
  const [secretKeyText, setSecretKeyText] = useState<string | undefined>(
    () => remembered ?? undefined
  );
  const [keyError, setKeyError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void api<Status>('/api/v1/status').then((result) => {
      if (cancelled) return;
      // An unreachable status check still shows the form: sign-in reports
      // the network failure itself, which says more than a blank page.
      setLibraryExists(result.ok ? result.body.libraryExists : true);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  // A fresh vault has no library to sign in to: it is set up from the browser.
  useEffect(() => {
    if (libraryExists === false) void navigate(path.setup(), { replace: true });
  }, [libraryExists, navigate]);

  const [, submitAction, isPending] = useActionState(async () => {
    const secretKey = parseSecretKey(secretKeyText ?? '');
    if (secretKey === null) {
      setKeyError(true);
      return null;
    }
    setKeyError(false);

    const salts = await api<Salts>('/api/v1/library/salts');
    if (!salts.ok) {
      if (salts.status === 404) setLibraryExists(false);
      else showToast(salts.status === 0 ? NETWORK_ERROR : salts.error, 'error');
      return null;
    }

    let authKey: Uint8Array;
    try {
      ({ authKey } = await deriveAccountKeys({
        secret: passwordBytes(password ?? ''),
        secretKey,
        salt: fromBase64(salts.body.passwordSalt),
      }));
    } catch {
      // WebCrypto exists only in a secure context (HTTPS or localhost).
      showToast('This browser cannot derive your keys here — open the vault over HTTPS', 'error');
      return null;
    }

    const result = await api<unknown>('/api/v1/session', {
      method: 'POST',
      body: JSON.stringify({ authKey: toBase64(authKey) }),
    });
    if (result.ok) {
      const accessToken = extractAccessToken(result.body);
      if (accessToken === null) {
        showToast('Unexpected response from server', 'error');
        return null;
      }
      // The canonical spelling, whatever grouping or case was typed.
      const formatted = formatSecretKey(secretKey);
      rememberSecretKey(formatted);
      setRemembered(formatted);
      signIn(accessToken);
      return null;
    }
    switch (result.status) {
      case 401:
        showToast('Invalid credentials', 'error');
        break;
      case 404:
        setLibraryExists(false);
        break;
      case 429:
        // Not a credentials failure, so "Invalid credentials" would be wrong
        // and would not clear on a correct retry.
        showToast(
          result.retryAfterSeconds !== undefined
            ? `Too many attempts — try again in ${result.retryAfterSeconds} seconds`
            : 'Too many attempts — please wait a moment and try again',
          'error'
        );
        break;
      case 0:
        showToast(NETWORK_ERROR, 'error');
        break;
      default:
        showToast(result.error, 'error');
    }
    return null;
  }, null);

  const forgetKey = () => {
    forgetSecretKey();
    setRemembered(null);
    setSecretKeyText(undefined);
  };

  if (libraryExists === null) return null;

  return (
    <Page type="minimal">
      <div className={styles.root}>
        {libraryExists ? (
          <div className={styles.stack}>
            <Card>
              <form className={styles.form} action={submitAction}>
                <div className={styles.inputContainer}>
                  <TextInput
                    placeholder="Password"
                    name="password"
                    autoComplete="current-password"
                    onChange={setPassword}
                    password
                    value={password}
                  />
                  <TextInput
                    placeholder="Secret Key"
                    name="secretKey"
                    autoCapitalize="characters"
                    autoComplete="off"
                    onChange={(next) => {
                      setSecretKeyText(next);
                      setKeyError(false);
                    }}
                    value={secretKeyText}
                  />
                  {keyError && (
                    <div role="alert" className={styles.error}>
                      That doesn&apos;t look like a Secret Key
                    </div>
                  )}
                  {remembered !== null && (
                    <Button type="link" onClick={forgetKey}>
                      Forget this key on this browser
                    </Button>
                  )}
                </div>
                <Button submit loading={isPending} type="primary" radius="card">
                  Sign In
                </Button>
              </form>
            </Card>
            <div className={styles.links}>
              <Button type="default" onClick={() => void navigate(path.recover())}>
                Forgot password
              </Button>
              <Button type="default" onClick={() => void navigate(path.reset())}>
                Lost everything
              </Button>
            </div>
          </div>
        ) : null}
      </div>
    </Page>
  );
};
