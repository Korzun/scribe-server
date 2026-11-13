import { useState } from 'react';

import { Button, ConfirmModal } from '~/control';
import type { Grant } from '~/lib/dashboard';
import { formatRelative } from '~/lib/format';

import { Card } from '../card';
import { CardRow } from '../card-row';
import { EmptyState } from '../empty-state';
import { useStyle } from './style';

export type AssistantsCardProps = {
  /** Undefined while loading. */
  grants?: Grant[];
  failed?: boolean;
  /** Whether `/mcp` is served; false explains an empty list. Undefined while the status loads. */
  mcpEnabled?: boolean;
  now: number;
  /** Resolves when the disconnect request finished (successfully or not). */
  onDisconnect: (id: string) => Promise<void>;
};

export const MCP_OFF_HINT = 'Set PUBLIC_URL to an https origin to turn the MCP endpoint on.';
export const MCP_ON_HINT =
  'Add this vault’s /mcp address as a connector in your assistant; you approve it here.';

/**
 * The AI assistants the owner has connected through MCP (spec §10): who,
 * since when, when last used, and Disconnect, which deletes the grant and
 * every token at once.
 */
export const AssistantsCard = ({
  grants,
  failed = false,
  mcpEnabled,
  now,
  onDisconnect,
}: AssistantsCardProps) => {
  const styles = useStyle();
  const [disconnecting, setDisconnecting] = useState<Grant | null>(null);
  const [busy, setBusy] = useState(false);

  const confirm = async () => {
    if (!disconnecting) return;
    setBusy(true);
    await onDisconnect(disconnecting.id);
    setBusy(false);
    setDisconnecting(null);
  };

  return (
    <Card title="Assistants">
      {failed ? (
        <EmptyState title="Couldn't load" danger />
      ) : !grants ? (
        <EmptyState title="Loading…" />
      ) : grants.length === 0 ? (
        <EmptyState title="No assistants connected.">
          {mcpEnabled === false ? MCP_OFF_HINT : mcpEnabled === true ? MCP_ON_HINT : undefined}
        </EmptyState>
      ) : (
        <div className={styles.list}>
          {grants.map((grant) => (
            <CardRow key={grant.id}>
              <div className={styles.row}>
                <div className={styles.info}>
                  <div className={styles.name}>
                    {grant.clientUri !== null ? (
                      <a href={grant.clientUri} target="_blank" rel="noopener noreferrer">
                        {grant.clientName}
                      </a>
                    ) : (
                      grant.clientName
                    )}
                  </div>
                  <div className={styles.meta}>
                    Connected {new Date(grant.createdAt).toLocaleDateString()} · Last used{' '}
                    {formatRelative(grant.lastUsedAt, now)}
                  </div>
                </div>
                <Button
                  danger
                  ariaLabel={`Disconnect ${grant.clientName}`}
                  onClick={() => setDisconnecting(grant)}
                >
                  Disconnect
                </Button>
              </div>
            </CardRow>
          ))}
        </div>
      )}
      <ConfirmModal
        isOpen={disconnecting !== null}
        title="Disconnect assistant"
        confirmText="Disconnect"
        danger
        loading={busy}
        onCancel={() => setDisconnecting(null)}
        onConfirm={() => void confirm()}
      >
        Disconnect {disconnecting?.clientName}? It can no longer read your meetings. Its tokens stop
        working now.
      </ConfirmModal>
    </Card>
  );
};
