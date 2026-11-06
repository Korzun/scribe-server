import { useActionState, useState } from 'react';
import { useNavigate } from 'react-router';

import { Card, Page } from '~/component';
import { Button, TextInput } from '~/control';
import { recover } from '~/lib/account';
import { recallSecretKey } from '~/lib/secret-key-store';
import { useToast } from '~/provider/toast';
import { path } from '~/router';

import { useStyle } from './style';

const NEEDS_SECRET_KEY =
  'A recovery code needs your Secret Key. Without the Secret Key nothing can recover this library.';
const MISMATCH = "The new passwords don't match";

/**
 * Forgotten password (spec §9): one recovery code plus the Secret Key unwrap
 * the Library Key in this browser, which rewraps it under a new password.
 * The code is spent; the owner then signs in with the new password.
 */
export const RecoverPage = () => {
  const styles = useStyle();
  const navigate = useNavigate();
  const toast = useToast();
  const [code, setCode] = useState<string | undefined>();
  const [secretKey, setSecretKey] = useState<string | undefined>(
    () => recallSecretKey() ?? undefined
  );
  const [newPassword, setNewPassword] = useState<string | undefined>();
  const [confirm, setConfirm] = useState<string | undefined>();
  const [mismatch, setMismatch] = useState(false);

  const incomplete = !code || !secretKey || !newPassword || !confirm;

  const [, submitAction, isPending] = useActionState(async () => {
    if ((newPassword ?? '') !== (confirm ?? '')) {
      setMismatch(true);
      return null;
    }
    if (incomplete) return null;
    const result = await recover({ code, secretKey, newPassword });
    if (result.ok) {
      toast('Password set — sign in with it now', 'success');
      void navigate(path.login());
      return null;
    }
    switch (result.status) {
      case 400:
        toast(
          result.error === 'Invalid recovery code'
            ? "That doesn't look like a recovery code"
            : "That doesn't look like a Secret Key",
          'error'
        );
        break;
      case 401:
      case 404:
        toast('That code or Secret Key is wrong', 'error');
        break;
      case 429:
        toast('Too many attempts — please wait a moment and try again', 'error');
        break;
      default:
        toast(result.error, 'error');
    }
    return null;
  }, null);

  return (
    <Page type="minimal">
      <div className={styles.root}>
        <div className={styles.stack}>
          <Card title="Forgot password">
            <form className={styles.form} action={submitAction}>
              <p className={styles.explain}>{NEEDS_SECRET_KEY}</p>
              <div className={styles.inputContainer}>
                <TextInput
                  placeholder="Recovery code"
                  name="recoveryCode"
                  autoCapitalize="characters"
                  autoComplete="off"
                  onChange={setCode}
                  value={code}
                />
                <TextInput
                  placeholder="Secret Key"
                  name="secretKey"
                  autoCapitalize="characters"
                  autoComplete="off"
                  onChange={setSecretKey}
                  value={secretKey}
                />
                <TextInput
                  placeholder="New password"
                  name="newPassword"
                  autoComplete="new-password"
                  password
                  onChange={(next) => {
                    setNewPassword(next);
                    setMismatch(false);
                  }}
                  value={newPassword}
                />
                <TextInput
                  placeholder="Confirm new password"
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
              </div>
              <Button submit disabled={incomplete} loading={isPending} type="primary" radius="card">
                Set new password
              </Button>
            </form>
          </Card>
          <Button type="default" onClick={() => void navigate(path.login())}>
            Back to sign in
          </Button>
        </div>
      </div>
    </Page>
  );
};
