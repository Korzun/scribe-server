import cx from 'classnames';
import { useRef, useState } from 'react';

import { Button, TextInput } from '~/control';
import type { Device } from '~/lib/dashboard';
import { formatRelative } from '~/lib/format';

import { CardRow } from '../card-row';
import { useStyle } from './style';

export type DeviceRowProps = {
  device: Device;
  now: number;
  /** Resolves true when the rename was saved. */
  onRename: (id: string, name: string) => Promise<boolean>;
  onRevoke: (device: Device) => void;
};

export const DeviceRow = ({ device, now, onRename, onRevoke }: DeviceRowProps) => {
  const styles = useStyle();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(device.name);
  const revoked = device.revokedAt !== null;
  const saving = useRef(false);
  // A row revoked while its input was open stops being editable.
  const isEditing = editing && !revoked;

  const startEditing = () => {
    if (revoked) return;
    setDraft(device.name);
    setEditing(true);
  };

  const save = async () => {
    if (saving.current || revoked) return;
    const name = draft.trim();
    if (name === '' || name === device.name) {
      setEditing(false);
      return;
    }
    saving.current = true;
    try {
      if (await onRename(device.id, name)) setEditing(false);
    } finally {
      saving.current = false;
    }
  };

  return (
    <CardRow>
      <div className={cx(styles.row, { [styles.revoked]: revoked })}>
        <div className={styles.info}>
          {isEditing ? (
            <div className={styles.edit}>
              <TextInput
                name={`device-name-${device.id}`}
                layout="inline"
                value={draft}
                maxLength={80}
                onChange={(value) => setDraft(value ?? '')}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void save();
                  if (event.key === 'Escape') setEditing(false);
                }}
              />
              <Button onClick={() => void save()}>Save</Button>
            </div>
          ) : revoked ? (
            <div className={styles.name}>{device.name}</div>
          ) : (
            <div
              className={cx(styles.name, styles.editable)}
              role="button"
              tabIndex={0}
              title="Rename"
              onClick={startEditing}
              onKeyDown={(event) => {
                if (event.key === 'Enter' || event.key === ' ') startEditing();
              }}
            >
              {device.name}
            </div>
          )}
          <div className={styles.meta}>
            Enrolled {new Date(device.createdAt).toLocaleDateString()}
            {revoked
              ? ` · Revoked ${new Date(device.revokedAt as number).toLocaleDateString()}`
              : ` · Last seen ${formatRelative(device.lastSeenAt, now)}`}
          </div>
        </div>
        {!revoked && (
          <Button danger ariaLabel={`Revoke ${device.name}`} onClick={() => onRevoke(device)}>
            Revoke
          </Button>
        )}
      </div>
    </CardRow>
  );
};
