import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Button, CodesSheet, PasswordPromptModal, type PasswordPromptValues } from '~/control';
import { changePassword, regenerateRecoveryCodes } from '~/lib/account';
import type { ApiResult } from '~/lib/api';
import { forgetSecretKey, recallSecretKey } from '~/lib/secret-key-store';
import { useAuth } from '~/provider/auth';
import { useToast } from '~/provider/toast';
import { path } from '~/router';

import { Card } from '../card';
import { CardRow } from '../card-row';
import { useStyle } from './style';

export type SecurityCardProps = {
  /** Undefined while the library loads. */
  recoveryCodesRemaining?: number;
  /** Asks the dashboard to refetch after the codes changed. */
  onChanged: () => void;
};

const MASK = 'A1-•••••-•••••-•••••-•••••-••••••';

type Prompt = 'change' | 'regenerate' | null;

/** A failure worded for a toast; never carries a secret. */
const failureMessage = (result: Extract<ApiResult<unknown>, { ok: false }>) => {
  switch (result.status) {
    case 400:
      return result.error === 'Invalid secret key'
        ? "That doesn't look like a Secret Key"
        : result.error;
    case 401:
      return 'Invalid credentials';
    case 429:
      return 'Too many attempts — please wait a moment and try again';
    default:
      return result.error;
  }
};

/**
 * The owner's keys (spec §3, §9): change the password, regenerate the ten
 * recovery codes, and see or forget the Secret Key this browser remembers.
 * Every key operation runs in the browser (`lib/account`); the password is
 * asked for each time and kept only for the length of the request.
 */
export const SecurityCard = ({ recoveryCodesRemaining, onChanged }: SecurityCardProps) => {
  const styles = useStyle();
  const toast = useToast();
  const navigate = useNavigate();
  const { signOut } = useAuth();
  const [remembered, setRemembered] = useState<string | null>(() => recallSecretKey());
  const [revealed, setRevealed] = useState(false);
  const [prompt, setPrompt] = useState<Prompt>(null);
  const [busy, setBusy] = useState(false);
  const [codes, setCodes] = useState<string[] | null>(null);

  const submit = async ({ password, newPassword, secretKey }: PasswordPromptValues) => {
    const key = remembered ?? secretKey;
    setBusy(true);
    if (prompt === 'change') {
      const result = await changePassword({
        currentPassword: password,
        newPassword,
        secretKey: key,
      });
      setBusy(false);
      if (!result.ok) {
        toast(failureMessage(result), 'error');
        return;
      }
      setPrompt(null);
      // The server revoked this browser's refresh token with the old password.
      await signOut();
      toast('Password changed — sign in again.', 'success');
      void navigate(path.login());
      return;
    }
    const result = await regenerateRecoveryCodes({ password, secretKey: key });
    setBusy(false);
    if (!result.ok) {
      toast(failureMessage(result), 'error');
      return;
    }
    setPrompt(null);
    setCodes(result.body);
    onChanged();
  };

  const copyKey = async () => {
    if (remembered === null) return;
    try {
      await navigator.clipboard.writeText(remembered);
      toast('Secret Key copied', 'success');
    } catch {
      toast("Couldn't copy the Secret Key", 'error');
    }
  };

  const forgetKey = () => {
    forgetSecretKey();
    setRemembered(null);
    setRevealed(false);
  };

  return (
    <Card title="Security">
      <div className={styles.rows}>
        <CardRow>
          <div className={styles.row}>
            <div className={styles.label}>Password</div>
            <Button onClick={() => setPrompt('change')}>Change password</Button>
          </div>
        </CardRow>
        <CardRow>
          <div className={styles.row}>
            <div className={styles.info}>
              <div className={styles.label}>Recovery codes</div>
              {recoveryCodesRemaining !== undefined && (
                <div className={styles.meta}>{recoveryCodesRemaining} remaining</div>
              )}
            </div>
            <Button onClick={() => setPrompt('regenerate')}>Regenerate</Button>
          </div>
        </CardRow>
        <CardRow>
          <div className={styles.row}>
            <div className={styles.info}>
              <div className={styles.label}>Secret Key</div>
              {remembered === null ? (
                <div className={styles.meta}>Not remembered on this browser</div>
              ) : (
                <div className={styles.key}>{revealed ? remembered : MASK}</div>
              )}
            </div>
            {remembered !== null && (
              <div className={styles.actions}>
                <Button onClick={() => setRevealed((r) => !r)}>
                  {revealed ? 'Hide' : 'Reveal'}
                </Button>
                <Button ariaLabel="Copy Secret Key" onClick={() => void copyKey()}>
                  Copy
                </Button>
                <Button danger onClick={forgetKey}>
                  Forget on this browser
                </Button>
              </div>
            )}
          </div>
        </CardRow>
      </div>
      <PasswordPromptModal
        isOpen={prompt === 'change'}
        title="Change password"
        confirmText="Change password"
        askNewPassword
        askSecretKey={remembered === null}
        loading={busy}
        onCancel={() => setPrompt(null)}
        onSubmit={(values) => void submit(values)}
      />
      <PasswordPromptModal
        isOpen={prompt === 'regenerate'}
        title="Regenerate recovery codes"
        confirmText="Regenerate"
        askSecretKey={remembered === null}
        loading={busy}
        onCancel={() => setPrompt(null)}
        onSubmit={(values) => void submit(values)}
      />
      <CodesSheet isOpen={codes !== null} codes={codes ?? []} onDone={() => setCodes(null)} />
    </Card>
  );
};
