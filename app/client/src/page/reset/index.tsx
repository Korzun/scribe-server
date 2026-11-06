import { useState } from 'react';
import { useNavigate } from 'react-router';

import { Card, Page } from '~/component';
import { Button, ConfirmModal, TextInput } from '~/control';
import { resetLibrary } from '~/lib/account';
import { forgetSecretKey } from '~/lib/secret-key-store';
import { useToast } from '~/provider/toast';
import { path } from '~/router';

import { useStyle } from './style';

const NOTHING_CAN_BE_DONE =
  'Lost the Secret Key: nothing can be done. The vault holds only what your keys can open, and it cannot help without them. Deleting the library and starting over is the only path.';
const CONFIRM_WORD = 'DELETE';

/**
 * The keys-lost path (spec §9). Without the Secret Key the library is
 * unreadable to everyone, the vault included, so the only thing left is to
 * delete it and create a new one from Scribe. Proven by the setup code from
 * the add-on's Home Assistant configuration, and the word DELETE typed out.
 */
export const ResetPage = () => {
  const styles = useStyle();
  const navigate = useNavigate();
  const toast = useToast();
  const [setupCode, setSetupCode] = useState<string | undefined>();
  const [confirming, setConfirming] = useState(false);
  const [word, setWord] = useState<string | undefined>();
  const [deleting, setDeleting] = useState(false);

  const openConfirm = () => {
    setWord(undefined);
    setConfirming(true);
  };

  const remove = async () => {
    if (!setupCode || word !== CONFIRM_WORD) return;
    setDeleting(true);
    const result = await resetLibrary({ setupCode });
    setDeleting(false);
    if (!result.ok) {
      toast(result.status === 0 ? 'Network error — please try again' : result.error, 'error');
      return;
    }
    setConfirming(false);
    // The remembered Secret Key belonged to the deleted library.
    forgetSecretKey();
    toast('Library deleted', 'success');
    void navigate(path.login());
  };

  return (
    <Page type="minimal">
      <div className={styles.root}>
        <div className={styles.stack}>
          <Card title="Lost everything">
            <div className={styles.body}>
              <p className={styles.explain}>{NOTHING_CAN_BE_DONE}</p>
              <p className={styles.hint}>
                Enter the setup code from the add-on&apos;s configuration in Home Assistant.
              </p>
              <TextInput
                placeholder="Setup code"
                name="setupCode"
                autoComplete="off"
                password
                onChange={setSetupCode}
                value={setupCode}
              />
              <Button danger disabled={!setupCode} onClick={openConfirm}>
                Delete the library
              </Button>
            </div>
          </Card>
          <Button type="default" onClick={() => void navigate(path.login())}>
            Back to sign in
          </Button>
        </div>
      </div>
      <ConfirmModal
        isOpen={confirming}
        title="Delete the library"
        confirmText="Delete everything"
        danger
        loading={deleting}
        confirmDisabled={word !== CONFIRM_WORD}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void remove()}
      >
        <div className={styles.confirm}>
          <p className={styles.explain}>
            Every meeting, file and device in this vault is deleted. This cannot be undone. Type{' '}
            {CONFIRM_WORD} to confirm.
          </p>
          <TextInput
            placeholder={CONFIRM_WORD}
            name="confirmDelete"
            autoCapitalize="characters"
            autoComplete="off"
            onChange={setWord}
            value={word}
          />
        </div>
      </ConfirmModal>
    </Page>
  );
};
