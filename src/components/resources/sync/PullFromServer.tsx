/**
 * PullFromServer — copy folders or files from anywhere in a saved server's home into this project,
 * without linking them (Nov 13 2026). Pick → check what changes → Pull → Undo. Files already here
 * stay unless "Replace" is ticked; undo puts back what the pull replaced or added.
 */
import { useEffect, useState } from 'react';
import type { SyncDevice, SyncPull } from '@/types/projectSync';
import type { ResourceProject } from '@/types/resources';
import { projectSyncApi, SyncRequestError } from '@/lib/projectSyncApi';
import { formatBytes, pullSummary } from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import TextInput from '@/components/ui/TextInput';
import RemoteFolderPicker from './RemoteFolderPicker';
import styles from '@/styles/modules/ProjectSync.module.css';

const POLL_MS = 700;
/** Polls in a row that may fail before the pull is given up on (a 404 gives up at once). */
const POLL_TRIES = 3;
const LOST = 'Lost track of this pull: AASC may have restarted. Check the project folder.';
const message = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback);

function PullResult({ pull }: { pull: SyncPull }) {
  if (pull.state === 'running')
    return (
      <p className={styles.hint} aria-live="polite">
        Pulling… {pull.done} of {pull.total}
        {pull.bytes.toGet
          ? ` · ${formatBytes(pull.bytes.got)} of ${formatBytes(pull.bytes.toGet)}`
          : ''}
      </p>
    );
  if (pull.state === 'complete')
    return (
      <p className={styles.hint} aria-live="polite">
        Pulled {pull.done} item{pull.done === 1 ? '' : 's'} into {pull.dest}.
      </p>
    );
  if (pull.state === 'undone') return null;
  return (
    <p role="alert" className={styles.error}>
      {pull.state === 'cancelled'
        ? `Stopped after ${pull.done} of ${pull.total} items.`
        : `${pull.done} of ${pull.total} items pulled${pull.failed ? `; ${pull.failed} failed` : ''}.`}
      {pull.error ? ` ${pull.error}` : ''}
    </p>
  );
}

export default function PullFromServer({
  project,
  devices,
  deviceId: initialDevice,
  onDone,
}: {
  project: ResourceProject;
  devices: SyncDevice[];
  /** The linked server, when there is one. */
  deviceId?: string;
  onDone: () => void;
}) {
  const [deviceId, setDeviceId] = useState(initialDevice ?? devices[0]?.id ?? '');
  const device = devices.find((d) => d.id === deviceId);
  const [selected, setSelected] = useState<string[]>([]);
  const [into, setInto] = useState('');
  const [replace, setReplace] = useState(false);
  const [pull, setPull] = useState<SyncPull | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // A running pull reports its progress until it settles.
  const running = pull?.state === 'running';
  const pullId = pull?.id;
  useEffect(() => {
    if (!running || !pullId) return;
    let inFlight = false;
    let misses = 0;
    let live = true;
    const timer = setInterval(() => {
      if (inFlight) return;
      inFlight = true;
      projectSyncApi
        .pull(pullId)
        .then((p) => {
          misses = 0;
          if (live) setPull(p);
        })
        .catch((e: unknown) => {
          misses++;
          const gone = e instanceof SyncRequestError && /not found/i.test(e.message);
          if (!live || (!gone && misses < POLL_TRIES)) return;
          // Pulls live in memory only: stop asking and stop showing it as running.
          const why = gone ? LOST : message(e, LOST);
          setPull((p) => (p && p.id === pullId ? { ...p, state: 'failed', error: why } : p));
        })
        .finally(() => {
          inFlight = false;
        });
    }, POLL_MS);
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [running, pullId]);

  const act = async (fn: () => Promise<SyncPull>, fallback: string) => {
    setBusy(true);
    setError(null);
    try {
      setPull(await fn());
    } catch (e) {
      setError(message(e, fallback));
    } finally {
      setBusy(false);
    }
  };
  const check = () =>
    act(
      () =>
        projectSyncApi.planPull({
          deviceId,
          projectId: project.id,
          sources: selected,
          into: into.trim(),
          replace,
        }),
      'Could not read what the pull would change.',
    );
  const editing = !pull || pull.state === 'planned';

  return (
    <div className={styles.settings} role="group" aria-label="Pull files from the server">
      <p className={styles.hint}>
        Copies folders or files from anywhere in the server&apos;s home into{' '}
        <span className={styles.mono}>{project.path}</span>, without linking them. Nothing is copied
        until you check what changes and press Pull.
      </p>
      {devices.length > 1 && !pull ? (
        <div className={styles.form}>
          <Field label="Server" className={`${styles.formField} ${styles.formWide}`}>
            <NativeSelect
              value={deviceId}
              onChange={(v) => {
                setDeviceId(v);
                setSelected([]);
              }}
              options={devices.map((d) => ({ value: d.id, label: d.name }))}
            />
          </Field>
        </div>
      ) : null}
      {device && !pull ? (
        <>
          <RemoteFolderPicker
            key={device.id}
            device={device}
            mode="items"
            selected={selected}
            onSelected={setSelected}
          />
          <div className={styles.form}>
            <Field
              label="Into (a subfolder of this project, optional)"
              className={`${styles.formField} ${styles.formWide}`}
            >
              <TextInput
                value={into}
                spellCheck={false}
                placeholder="imports"
                onChange={(e) => setInto(e.target.value)}
              />
            </Field>
            <label className={styles.check}>
              <input
                type="checkbox"
                checked={replace}
                onChange={(e) => setReplace(e.target.checked)}
              />
              <span>Replace files that differ here (undo keeps them). Otherwise they stay.</span>
            </label>
          </div>
        </>
      ) : null}
      {pull && pull.state === 'planned' ? (
        <div className={styles.pullPlan}>
          <p className={styles.summary}>{pullSummary(pull.counts)}</p>
          <p className={styles.hint}>
            Into <span className={styles.mono}>{pull.dest}</span>
            {pull.bytes.toGet ? ` · ${formatBytes(pull.bytes.toGet)} to get` : ''}
          </p>
          {pull.warnings.length ? (
            <ul className={styles.warnings}>
              {pull.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      {pull && !editing ? <PullResult pull={pull} /> : null}
      {pull?.state === 'undone' ? (
        <ul className={styles.warnings}>
          {pull.warnings.slice(0, 1).map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      <div className={styles.formActions}>
        {!pull ? (
          <Button
            variant="primary"
            disabled={busy || !selected.length || !device}
            onClick={() => void check()}
          >
            {busy ? 'Reading both sides…' : 'Check what changes'}
          </Button>
        ) : pull.state === 'planned' ? (
          <>
            <Button
              variant="primary"
              disabled={busy || pull.total === 0}
              onClick={() => void act(() => projectSyncApi.startPull(pull.id), 'Could not pull.')}
            >
              Pull
            </Button>
            <Button variant="quiet" disabled={busy} onClick={() => setPull(null)}>
              Back
            </Button>
          </>
        ) : running ? (
          <Button
            disabled={busy}
            onClick={() => void act(() => projectSyncApi.cancelPull(pull.id), 'Could not stop.')}
          >
            Stop
          </Button>
        ) : pull.state !== 'undone' && pull.done > 0 ? (
          <Button
            disabled={busy}
            onClick={() => void act(() => projectSyncApi.undoPull(pull.id), 'Could not undo.')}
          >
            Undo
          </Button>
        ) : null}
        {!running && !(pull?.state === 'planned') ? (
          <Button variant="quiet" disabled={busy} onClick={onDone}>
            {pull ? 'Done' : 'Cancel'}
          </Button>
        ) : null}
      </div>
    </div>
  );
}
