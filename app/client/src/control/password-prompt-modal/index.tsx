import { useState } from 'react';

import { ConfirmModal } from '../confirm-modal';
import { TextInput } from '../text-input';
import { useStyle } from './style';

export type PasswordPromptValues = {
  password: string;
  /** Empty unless `askNewPassword`. */
  newPassword: string;
  /** Empty unless `askSecretKey`. */
  secretKey: string;
};

type PasswordPromptModalProps = {
  isOpen: boolean;
  title: string;
  confirmText: string;
  /** Also ask for a new password, typed twice; a mismatch is refused inline. */
  askNewPassword?: boolean;
  /** Also ask for the Secret Key (when this browser does not remember one). */
  askSecretKey?: boolean;
  loading?: boolean;
  onCancel: () => void;
  onSubmit: (values: PasswordPromptValues) => void;
};

const MISMATCH = "The new passwords don't match";

/**
 * Asks for the owner's password before a key operation: the browser needs it
 * to derive the key that unwraps the Library Key. The fields start empty every
 * time the modal opens, so nothing typed lingers between prompts.
 */
export const PasswordPromptModal = ({
  isOpen,
  title,
  confirmText,
  askNewPassword = false,
  askSecretKey = false,
  loading = false,
  onCancel,
  onSubmit,
}: PasswordPromptModalProps) => {
  const styles = useStyle();
  const [password, setPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [secretKey, setSecretKey] = useState('');
  const [mismatch, setMismatch] = useState(false);
  const [wasOpen, setWasOpen] = useState(isOpen);

  if (isOpen !== wasOpen) {
    setWasOpen(isOpen);
    if (isOpen) {
      setPassword('');
      setNewPassword('');
      setConfirm('');
      setSecretKey('');
      setMismatch(false);
    }
  }

  const incomplete =
    password === '' ||
    (askNewPassword && (newPassword === '' || confirm === '')) ||
    (askSecretKey && secretKey === '');

  const submit = () => {
    if (incomplete || loading) return;
    if (askNewPassword && newPassword !== confirm) {
      setMismatch(true);
      return;
    }
    onSubmit({ password, newPassword, secretKey });
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') submit();
  };

  return (
    <ConfirmModal
      isOpen={isOpen}
      title={title}
      confirmText={confirmText}
      confirmDisabled={incomplete}
      loading={loading}
      onCancel={onCancel}
      onConfirm={submit}
    >
      <div className={styles.fields}>
        <TextInput
          name="password"
          placeholder={askNewPassword ? 'Current password' : 'Password'}
          autoComplete="current-password"
          password
          value={password}
          onChange={(next) => setPassword(next ?? '')}
          onKeyDown={onKeyDown}
        />
        {askSecretKey && (
          <TextInput
            name="secretKey"
            placeholder="Secret Key"
            autoCapitalize="characters"
            autoComplete="off"
            value={secretKey}
            onChange={(next) => setSecretKey(next ?? '')}
            onKeyDown={onKeyDown}
          />
        )}
        {askNewPassword && (
          <>
            <TextInput
              name="newPassword"
              placeholder="New password"
              autoComplete="new-password"
              password
              value={newPassword}
              onChange={(next) => {
                setNewPassword(next ?? '');
                setMismatch(false);
              }}
              onKeyDown={onKeyDown}
            />
            <TextInput
              name="confirmPassword"
              placeholder="Confirm new password"
              autoComplete="new-password"
              password
              value={confirm}
              onChange={(next) => {
                setConfirm(next ?? '');
                setMismatch(false);
              }}
              onKeyDown={onKeyDown}
            />
          </>
        )}
        {mismatch && (
          <div role="alert" className={styles.error}>
            {MISMATCH}
          </div>
        )}
      </div>
    </ConfirmModal>
  );
};
