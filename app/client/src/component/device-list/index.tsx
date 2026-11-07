import { useState } from 'react';

import { ConfirmModal } from '~/control';
import type { Device } from '~/lib/dashboard';

import { Card } from '../card';
import { DeviceRow } from '../device-row';
import { EmptyState } from '../empty-state';
import { useStyle } from './style';

export type DeviceListProps = {
  /** Undefined while loading. */
  devices?: Device[];
  failed?: boolean;
  now: number;
  onRename: (id: string, name: string) => Promise<boolean>;
  /** Resolves when the revoke request finished (successfully or not). */
  onRevoke: (id: string) => Promise<void>;
};

export const DeviceList = ({
  devices,
  failed = false,
  now,
  onRename,
  onRevoke,
}: DeviceListProps) => {
  const styles = useStyle();
  const [revoking, setRevoking] = useState<Device | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!revoking) return;
    setBusy(true);
    await onRevoke(revoking.id);
    setBusy(false);
    setRevoking(null);
  };

  return (
    <Card title="Devices">
      {failed ? (
        <EmptyState title="Couldn't load" danger />
      ) : !devices ? (
        <EmptyState title="Loading…" />
      ) : devices.length === 0 ? (
        <EmptyState title="No Macs enrolled yet." />
      ) : (
        <div className={styles.list}>
          {devices.map((device) => (
            <DeviceRow
              key={device.id}
              device={device}
              now={now}
              onRename={onRename}
              onRevoke={setRevoking}
            />
          ))}
        </div>
      )}
      <ConfirmModal
        isOpen={revoking !== null}
        title="Revoke Mac"
        confirmText="Revoke"
        danger
        loading={busy}
        onCancel={() => setRevoking(null)}
        onConfirm={() => void confirm()}
      >
        Revoke {revoking?.name}? That Mac can no longer reach the vault. Anything it already holds
        stays readable to it.
      </ConfirmModal>
    </Card>
  );
};
