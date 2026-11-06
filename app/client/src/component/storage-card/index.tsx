import { useState } from 'react';

import { Button, ConfirmModal } from '~/control';
import type { Storage } from '~/lib/dashboard';
import { formatBytes } from '~/lib/format';

import { Card } from '../card';
import { EmptyState } from '../empty-state';
import { useStyle } from './style';

export type StorageCardProps = {
  /** Undefined while loading. */
  storage?: Storage;
  failed?: boolean;
  /** Resolves when the purge request finished (successfully or not). */
  onPurge: () => Promise<void>;
};

export const StorageCard = ({ storage, failed = false, onPurge }: StorageCardProps) => {
  const styles = useStyle();
  const [confirming, setConfirming] = useState(false);
  const [purging, setPurging] = useState(false);

  const deleted = storage?.deletedMeetingCount ?? 0;

  const confirm = async () => {
    setPurging(true);
    await onPurge();
    setPurging(false);
    setConfirming(false);
  };

  return (
    <Card title="Storage">
      {failed ? (
        <EmptyState title="Couldn't load" danger />
      ) : !storage ? (
        <EmptyState title="Loading…" />
      ) : (
        <dl className={styles.list}>
          <dt>Stored data</dt>
          <dd>{formatBytes(storage.blobBytes)}</dd>
          <dt>Files</dt>
          <dd>{storage.blobCount}</dd>
          <dt>Meetings</dt>
          <dd>{storage.meetingCount}</dd>
          <dt>Deleted, awaiting purge</dt>
          <dd className={styles.purge}>
            {deleted}
            <Button disabled={deleted === 0} onClick={() => setConfirming(true)}>
              Empty now
            </Button>
          </dd>
        </dl>
      )}
      <ConfirmModal
        isOpen={confirming}
        title="Empty now"
        confirmText="Empty now"
        danger
        loading={purging}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void confirm()}
      >
        Remove the files of {deleted} deleted {deleted === 1 ? 'meeting' : 'meetings'} now? They are
        already gone from every Mac.
      </ConfirmModal>
    </Card>
  );
};
