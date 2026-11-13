import cx from 'classnames';

import type { Job, JobsSummary } from '~/lib/dashboard';
import { formatRelative } from '~/lib/format';

import { Card } from '../card';
import { CardRow } from '../card-row';
import { EmptyState } from '../empty-state';
import { useStyle } from './style';

export type JobsCardProps = {
  /** Undefined while loading. */
  jobs?: JobsSummary;
  failed?: boolean;
  now: number;
};

/** The one word the owner reads for a finished job. */
export const outcomeLabel = (job: Job): string => {
  switch (job.outcome) {
    case 'ok':
      return 'Done';
    case 'lapsed':
      return 'Gave up';
    default:
      return 'Failed';
  }
};

/**
 * The reprocessing queue (spec §8): depth and the last few outcomes, nothing
 * more. The Macs do the work; this is only a view of what is waiting and
 * what came of it.
 */
export const JobsCard = ({ jobs, failed = false, now }: JobsCardProps) => {
  const styles = useStyle();

  return (
    <Card title="Reprocessing">
      {failed ? (
        <EmptyState title="Couldn't load" danger />
      ) : !jobs ? (
        <EmptyState title="Loading…" />
      ) : (
        <>
          <dl className={styles.list}>
            <dt>Waiting</dt>
            <dd>{jobs.depth}</dd>
            <dt>In progress</dt>
            <dd>{jobs.leased}</dd>
          </dl>
          {jobs.recent.length === 0 ? (
            <EmptyState title="No jobs finished yet." />
          ) : (
            <div className={styles.recent}>
              {jobs.recent.map((job) => (
                <CardRow key={job.id}>
                  <div className={styles.row}>
                    <div>
                      <div
                        className={cx(styles.outcome, { [styles.failed]: job.outcome !== 'ok' })}
                      >
                        {outcomeLabel(job)}
                      </div>
                      <div className={styles.meeting} title={job.meetingId}>
                        {job.meetingId.slice(0, 8)}…
                      </div>
                    </div>
                    <div className={styles.meta}>{formatRelative(job.finishedAt, now)}</div>
                  </div>
                </CardRow>
              ))}
            </div>
          )}
        </>
      )}
    </Card>
  );
};
