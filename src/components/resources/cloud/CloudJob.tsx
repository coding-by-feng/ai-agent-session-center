import { useEffect, useState } from 'react';
import Button from '@/components/ui/Button';
import { buttonClass } from '@/components/ui/buttonClass';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import StaleNote from '@/components/ui/StaleNote';
import { cloudApi, type CloudReviewBinding } from '@/lib/cloudApi';
import { cloudJobProgress } from '@/lib/cloudFormat';
import type { CloudJob as Job } from '@/types/cloudResources';
import { useCloudAction, useCloudSession } from './cloudSession';
import styles from '@/styles/modules/CloudResources.module.css';

const KIND_LABELS: Record<Job['kind'], string> = {
  publish: 'Save to cloud',
  download: 'Download',
  install: 'Install',
  'get-project': 'Clone',
  'pull-project': 'Pull',
  'push-project': 'Push',
};
const JOB_TONES: Record<Job['state'], ChipTone> = {
  queued: 'info',
  running: 'info',
  complete: 'success',
  partial: 'warning',
  failed: 'danger',
  cancelled: 'neutral',
  interrupted: 'warning',
};
const STEP_TONES: Record<Job['steps'][number]['state'], ChipTone> = {
  pending: 'neutral',
  running: 'info',
  complete: 'success',
  failed: 'danger',
  skipped: 'neutral',
};

export default function CloudJob({
  job,
  onChange,
  openUrl,
  owned = true,
}: {
  job: Job;
  owned?: boolean;
  onChange: (job: Job) => void;
  openUrl?: string | null;
}) {
  const action = useCloudAction(),
    session = useCloudSession();
  const [restored, setRestored] = useState<string[]>([]);
  const [pollFailed, setPollFailed] = useState(false);
  // The server deletes a prepared ZIP once it has streamed (and sweeps unsaved ones after an hour).
  const [zipSaved, setZipSaved] = useState(false);
  const active = ['queued', 'running'].includes(job.state),
    attention = job.steps.some((s) => s.attention);
  // Read and cancel go out with the current binding, also while offline (the job is local
  // state), but never without one: the server only answers for the bound account's jobs.
  const connection = session.status.connection,
    changed = session.changed;
  const backendOrigin = connection?.backendOrigin,
    accountId = connection?.accountId,
    generation = connection?.generation;
  useEffect(() => {
    if (!active) return;
    const c = new AbortController();
    const timer = setTimeout(() => {
      if (
        backendOrigin === undefined ||
        accountId === undefined ||
        generation === undefined ||
        changed
      ) {
        setPollFailed(true);
        return;
      }
      void cloudApi
        .job(job.id, { backendOrigin, accountId, generation }, c.signal)
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
  }, [job, active, onChange, backendOrigin, accountId, generation, changed]);
  function runBound<T>(
    work: (binding: CloudReviewBinding, signal: AbortSignal) => Promise<T>,
    commit: (result: T) => void,
  ) {
    if (!connection || changed) {
      action.setError('Refresh the connection before checking or cancelling this job.');
      return;
    }
    action.run(work, commit, true);
  }
  return (
    <article className={styles.card} aria-label={`${job.kind} job`}>
      <div className={styles.title}>
        <h3>
          {KIND_LABELS[job.kind]} ·{' '}
          <Chip tone={JOB_TONES[job.state]}>
            {job.state === 'partial' ? 'partially complete' : job.state}
          </Chip>
        </h3>
        <span role="status" className={styles.hint}>
          {cloudJobProgress(job)}
        </span>
      </div>
      <ul className={styles.steps}>
        {job.steps.map((s) => (
          <li key={s.id}>
            <span className={styles.stepLine}>
              <span>{s.label}</span>
              <Chip tone={STEP_TONES[s.state]}>{s.state}</Chip>
            </span>
            {s.error && <div className={styles.error}>{s.error}</div>}
            {s.attention && (
              <div className={styles.banner}>
                Package completed; follow-up needs attention: {s.attention}
              </div>
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
            {s.receiptId && restored.includes(s.receiptId) && (
              <p className={styles.hint}>Backup restored</p>
            )}
          </li>
        ))}
      </ul>
      {pollFailed && (
        <StaleNote
          onRetry={() =>
            runBound(
              (b, s) => cloudApi.job(job.id, b, s),
              (next) => {
                setPollFailed(false);
                onChange(next);
              },
            )
          }
        >
          Couldn't refresh this job. Its status may be out of date.
        </StaleNote>
      )}
      <div className={styles.toolbar}>
        {active && (
          <Button
            disabled={action.busy || !connection || changed}
            onClick={() => runBound((b, s) => cloudApi.cancel(job.id, b, s), onChange)}
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
        {openUrl && (
          <a className={buttonClass()} href={openUrl} target="_blank" rel="noopener noreferrer">
            Open project
          </a>
        )}
        {job.kind === 'download' && job.state === 'complete' && !zipSaved && (
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
                  setZipSaved(true);
                },
              )
            }
          >
            Save ZIP
          </Button>
        )}
      </div>
      {job.kind === 'download' && job.state === 'complete' && (
        <p className={styles.hint}>
          {zipSaved
            ? 'ZIP saved. This Mac has removed its copy; start a new download to save it again.'
            : 'The ZIP can be saved once, within an hour. After that, start a new download.'}
        </p>
      )}
      {active && (
        <p className={styles.hint}>
          Cancellation stops remaining steps; completed files are not rolled back.
        </p>
      )}
      {action.error && (
        <div role="alert" className={styles.error}>
          {action.error}
        </div>
      )}
      {session.changed && <p className={styles.hint}>Refresh connection before another action.</p>}
    </article>
  );
}
