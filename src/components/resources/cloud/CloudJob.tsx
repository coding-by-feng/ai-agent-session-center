import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import { cloudApi } from '@/lib/cloudApi';
import { cloudJobProgress } from '@/lib/cloudFormat';
import type { CloudJob as Job } from '@/types/cloudResources';
import { useCloudAction, useCloudSession } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';
export default function CloudJob({
  job,
  onChange,
  onResourcesReview,
  openUrl,
  owned = true,
}: {
  job: Job;
  owned?: boolean;
  onChange: (job: Job) => void;
  onResourcesReview?: () => void;
  openUrl?: string | null;
}) {
  const action = useCloudAction(),
    session = useCloudSession();
  const [restored, setRestored] = useState<string[]>([]);
  const [pollFailed, setPollFailed] = useState(false);
  const active = ['queued', 'running'].includes(job.state),
    attention = job.steps.some((s) => s.attention);
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    const timer = setTimeout(() => {
      void cloudApi
        .job(job.id, c.signal)
        .then((j) => {
          if (!c.signal.aborted) {
            setPollFailed(false);
            onChange(j);
          }
        })
        .catch(() => {
          if (!c.signal.aborted) setPollFailed(true);
        });
    }, 1000);
    return () => {
      clearTimeout(timer);
      c.abort();
    };
  }, [job, active, onChange]);
  return (
    <article className={styles.card} aria-label={`${job.kind} job`}>
      <div className={styles.title}>
        <h3>
          {
            {
              publish: 'Save to cloud',
              download: 'Download',
              install: 'Install',
              'get-project': 'Get project',
              'pull-project': 'Pull updates',
            }[job.kind]
          }{' '}
          · {job.state === 'partial' ? 'partially complete' : job.state}
        </h3>
        <span role="status">{cloudJobProgress(job)}</span>
      </div>
      <ul>
        {job.steps.map((s) => (
          <li key={s.id}>
            {s.label}: {s.state}
            {s.error && <p className={styles.error}>{s.error}</p>}
            {s.attention && (
              <p className={styles.banner}>
                Package completed; follow-up needs attention: {s.attention}
              </p>
            )}
            {s.receiptId && !restored.includes(s.receiptId) && (
              <Button
                disabled={action.busy || !action.enabled || !owned}
                onClick={() =>
                  action.run(
                    (b, sig) => cloudApi.restore(s.receiptId!, b, sig),
                    (r) => setRestored((ids) => [...ids, r.id]),
                  )
                }
              >
                Restore backup
              </Button>
            )}
            {s.receiptId && restored.includes(s.receiptId) && <p>Backup restored</p>}
          </li>
        ))}
      </ul>
      {pollFailed && (
        <p className={styles.banner}>
          Job status may be stale.{' '}
          <Button
            onClick={() =>
              action.run(
                (_b, s) => cloudApi.job(job.id, s),
                (next) => {
                  setPollFailed(false);
                  onChange(next);
                },
                true,
              )
            }
          >
            Refresh job status
          </Button>
        </p>
      )}
      <div className={styles.toolbar}>
        {active && (
          <Button
            disabled={action.busy}
            onClick={() => action.run((_b, s) => cloudApi.cancel(job.id, s), onChange, true)}
          >
            Cancel job
          </Button>
        )}
        {((!active && job.state !== 'complete') || (job.kind === 'install' && attention)) && (
          <Button
            disabled={action.busy || !action.enabled || !owned}
            onClick={() => action.run((b, s) => cloudApi.retry(job.id, b, s), onChange)}
          >
            Retry job
          </Button>
        )}
        {onResourcesReview && !active && (
          <Button disabled={!action.enabled || !owned || action.busy} onClick={onResourcesReview}>
            Review resources for retry
          </Button>
        )}
        {openUrl && <a href={openUrl}>Open project</a>}
        {job.kind === 'download' && job.state === 'complete' && (
          <Button
            disabled={action.busy || !action.enabled || !owned}
            onClick={() =>
              action.run(
                (b, s) => cloudApi.downloadFile(job.id, b, s),
                (blob) => {
                  const url = URL.createObjectURL(blob),
                    a = document.createElement('a');
                  a.href = url;
                  a.download = `resources-${job.id}.zip`;
                  a.click();
                  setTimeout(() => URL.revokeObjectURL(url), 1000);
                },
              )
            }
          >
            Save ZIP
          </Button>
        )}
      </div>
      {active && (
        <p className={styles.hint}>
          Cancellation stops remaining steps; completed files are not rolled back.
        </p>
      )}
      {action.error && (
        <p role="alert" className={styles.error}>
          {action.error}
        </p>
      )}
      {session.changed && <p>Refresh connection before another action.</p>}
    </article>
  );
}
