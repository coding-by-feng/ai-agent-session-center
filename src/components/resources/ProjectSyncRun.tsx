import { useCallback, useEffect, useState } from 'react';
import {
  allowedSyncActions,
  type SyncAction,
  type SyncChange,
  type SyncEntry,
  type SyncEntryFilter,
  type SyncGroup,
  type SyncGroupDecision,
  type SyncRun,
} from '@/types/projectSync';
import { projectSyncApi, SyncRequestError } from '@/lib/projectSyncApi';
import { CHANGE_LABEL, formatBytes, runSummary } from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import Pagination from '@/components/ui/Pagination';
import styles from '@/styles/modules/ProjectSync.module.css';

const PAGE = 100;
const CHANGE_TONE: Partial<Record<SyncChange, 'info' | 'success' | 'warning' | 'danger'>> = {
  add: 'success',
  change: 'info',
  delete: 'danger',
  drift: 'warning',
  conflict: 'danger',
  different: 'warning',
  blocked: 'warning',
};
const ACTION_LABEL: Record<SyncAction, string> = {
  push: 'Copy to device',
  'delete-device': 'Delete on device (to trash)',
  keep: 'Keep device copy',
  skip: 'Skip',
  review: 'Choose…',
};
const FILTERS: { value: SyncEntryFilter; label: string }[] = [
  { value: 'changes', label: 'Changes' },
  { value: 'decisions', label: 'Needs a decision' },
  { value: 'failed', label: 'Failed' },
  { value: 'credentials', label: 'Credential files' },
  { value: 'links', label: 'Links' },
  { value: 'all', label: 'Everything' },
];
const REPO_STATE: Record<NonNullable<SyncGroup['state']>, string> = {
  'in-step': 'in step',
  'local-ahead': 'this machine is ahead',
  'device-changed': 'changed on the device',
  'different-repo': 'a different repository on the device',
  busy: 'git is busy (.lock file)',
};
const short = (sha?: string) => (sha ? sha.slice(0, 10) : '—');
const RETRY_STATES: ReadonlySet<SyncRun['state']> = new Set([
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);

function RepoRow({
  group,
  run,
  onDecide,
  busy,
}: {
  group: SyncGroup;
  run: SyncRun;
  onDecide: (g: string, d: SyncGroupDecision) => void;
  busy: boolean;
}) {
  const changed = group.state === 'device-changed' || group.state === 'different-repo';
  return (
    <li className={styles.repoRow}>
      <div className={styles.repoHead}>
        <span className={styles.mono}>⎇ {group.id}</span>
        <Chip tone={changed || group.state === 'busy' ? 'warning' : 'neutral'}>
          {REPO_STATE[group.state ?? 'in-step']}
        </Chip>
      </div>
      <p className={styles.hint}>
        This machine {group.local?.head ?? '—'} {short(group.local?.commit)} · device{' '}
        {group.device?.head ?? '—'} {short(group.device?.commit)}
      </p>
      {run.state === 'review' && group.state !== 'busy' && group.state !== 'in-step' ? (
        <Field label="Repository" className={styles.repoField}>
          <NativeSelect<SyncGroupDecision>
            className={styles.repoSelect}
            value={group.decision ?? 'review'}
            disabled={busy}
            onChange={(d) => onDecide(group.id, d)}
            options={[
              ...(group.decision === 'review'
                ? [{ value: 'review' as const, label: 'Choose…' }]
                : []),
              { value: 'sync', label: 'Sync changes', disabled: changed },
              { value: 'overwrite', label: 'Overwrite the device repository (backups kept)' },
              { value: 'skip', label: 'Skip this repository' },
            ]}
          />
        </Field>
      ) : null}
    </li>
  );
}

function EntryRow({
  entry,
  run,
  repo,
  busy,
  onAction,
}: {
  entry: SyncEntry;
  run: SyncRun;
  repo: boolean;
  busy: boolean;
  onAction: (id: string, a: SyncAction) => void;
}) {
  const [diff, setDiff] = useState<{ patch: string | null; note?: string } | null>(null);
  const [loading, setLoading] = useState(false);
  const options = allowedSyncActions(entry.change).filter(
    (a) =>
      (a !== 'push' || entry.local) && (a !== 'delete-device' || (!entry.local && entry.device)),
  );
  const editable = run.state === 'review' && !repo && options.length > 1;
  const canDiff =
    !entry.flags.includes('credential') &&
    (entry.local ?? entry.device)?.kind === 'file' &&
    entry.change !== 'same';
  const showDiff = async () => {
    if (diff) return setDiff(null);
    setLoading(true);
    try {
      setDiff(await projectSyncApi.diff(run.id, entry.id));
    } catch (e) {
      setDiff({ patch: null, note: e instanceof Error ? e.message : 'Preview failed.' });
    } finally {
      setLoading(false);
    }
  };
  return (
    <li className={styles.entry}>
      <div className={styles.entryMain}>
        <span className={styles.path} title={entry.path}>
          {entry.flags.includes('credential') ? '🔒 ' : ''}
          {(entry.local ?? entry.device)?.kind === 'symlink' ? '↪ ' : ''}
          {entry.path}
        </span>
        <Chip tone={CHANGE_TONE[entry.change]}>{CHANGE_LABEL[entry.change]}</Chip>
        {entry.state === 'done' ? <Chip tone="success">done</Chip> : null}
        {entry.state === 'failed' ? <Chip tone="danger">failed</Chip> : null}
        {editable ? (
          <NativeSelect<SyncAction>
            aria-label={`Action for ${entry.path}`}
            className={styles.actionSelect}
            value={entry.action}
            disabled={busy}
            onChange={(a) => onAction(entry.id, a)}
            options={[
              ...(entry.action === 'review' ? (['review'] as SyncAction[]) : []),
              ...options,
            ].map((a) => ({ value: a, label: ACTION_LABEL[a] }))}
          />
        ) : (
          <span className={styles.actionText}>
            {repo && entry.change !== 'same' ? 'with repository' : ACTION_LABEL[entry.action]}
          </span>
        )}
        {canDiff ? (
          <Button
            size="sm"
            variant="quiet"
            aria-expanded={!!diff}
            onClick={() => void showDiff()}
            disabled={loading}
          >
            {diff ? 'Hide diff' : loading ? 'Loading…' : 'Diff'}
          </Button>
        ) : null}
      </div>
      {entry.reason || entry.error ? (
        <p className={entry.error ? styles.error : styles.hint}>{entry.error ?? entry.reason}</p>
      ) : null}
      {diff ? (
        diff.patch ? (
          <pre className={styles.diff}>
            {diff.patch.split('\n').map((line, i) => (
              <span
                key={i}
                className={
                  line.startsWith('+') && !line.startsWith('+++')
                    ? styles.diffAdd
                    : line.startsWith('-') && !line.startsWith('---')
                      ? styles.diffDel
                      : undefined
                }
              >
                {line + '\n'}
              </span>
            ))}
          </pre>
        ) : (
          <p className={styles.hint}>{diff.note}</p>
        )
      ) : null}
    </li>
  );
}

export default function ProjectSyncRun({
  run,
  latest,
  onRun,
}: {
  run: SyncRun;
  latest: boolean;
  onRun: (r: SyncRun) => void;
}) {
  const [filter, setFilter] = useState<SyncEntryFilter>('changes');
  const [group, setGroup] = useState<string>('*');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<{ list: SyncEntry[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [liveAsk, setLiveAsk] = useState<string | null>(null);
  const repos = new Set(run.groups.filter((g) => g.isRepo).map((g) => g.id));
  const [undoAsk, setUndoAsk] = useState(false);

  useEffect(() => {
    if (run.state === 'comparing') return;
    let alive = true;
    projectSyncApi
      .entries(run.id, {
        filter,
        ...(group === '*' ? {} : { group }),
        offset: (page - 1) * PAGE,
        limit: PAGE,
      })
      .then((p) => {
        if (!alive) return;
        // A decision or filter can shrink the list below the open page.
        if (p.total > 0 && p.offset >= p.total) setPage(Math.max(1, Math.ceil(p.total / PAGE)));
        else setEntries({ list: p.entries, total: p.total });
      })
      .catch((e) => alive && setError(e instanceof Error ? e.message : 'Could not load the plan.'));
    return () => {
      alive = false;
    };
  }, [
    run.id,
    run.updatedAt,
    run.state,
    run.done,
    run.failed,
    run.pendingDecisions,
    filter,
    group,
    page,
  ]);

  const act = useCallback(
    async (fn: () => Promise<SyncRun>) => {
      setBusy(true);
      setError(null);
      try {
        onRun(await fn());
      } catch (e) {
        if (e instanceof SyncRequestError && e.code === 'live-sessions') setLiveAsk(e.message);
        else setError(e instanceof Error ? e.message : 'Request failed.');
      } finally {
        setBusy(false);
      }
    },
    [onRun],
  );
  const start = (confirm: boolean) => {
    setLiveAsk(null);
    void act(() => projectSyncApi.start(run.id, confirm));
  };
  const undo = async () => {
    setUndoAsk(false);
    setBusy(true);
    setError(null);
    try {
      onRun((await projectSyncApi.undo(run.id)).run);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Undo failed.');
    } finally {
      setBusy(false);
    }
  };

  if (run.state === 'comparing')
    return (
      <EmptyState
        busy
        title="Comparing both sides…"
        hint="Large projects take a while the first time; later compares reuse the last hashes."
      />
    );

  const running = run.state === 'running';
  const runnable = !run.stale && (run.state === 'review' || RETRY_STATES.has(run.state));
  const remaining = run.total - run.done;
  const totalPages = Math.max(1, Math.ceil((entries?.total ?? 0) / PAGE));
  const groupOptions = [
    { value: '*', label: 'All folders' },
    ...run.groups.map((g) => ({ value: g.id, label: g.id === '' ? '(project root files)' : g.id })),
  ];

  return (
    <div className={styles.run}>
      <div className={styles.runHead}>
        <Chip
          tone={
            run.state === 'complete'
              ? 'success'
              : run.state === 'review'
                ? 'info'
                : running
                  ? 'accent'
                  : 'warning'
          }
        >
          {run.state}
        </Chip>
        <span className={styles.summary}>{runSummary(run)}</span>
        <span className={styles.hint}>
          {run.state === 'review'
            ? `${run.total} to apply${run.bytes.toSend ? ` · ${formatBytes(run.bytes.toSend)} to send` : ''}`
            : `${run.done}/${run.total} done${run.failed ? ` · ${run.failed} failed` : ''}${
                running && run.bytes.toSend
                  ? ` · ${formatBytes(run.bytes.sent)} of ${formatBytes(run.bytes.toSend)}`
                  : ''
              }`}
        </span>
      </div>
      {run.stale ? (
        <p role="alert" className={styles.error}>
          {run.stale}
        </p>
      ) : null}
      {run.error && run.error !== run.stale ? (
        <p role="alert" className={styles.error}>
          {run.error}
        </p>
      ) : null}
      {run.warnings.length ? (
        <ul className={styles.warnings}>
          {run.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      ) : null}
      {error ? (
        <p role="alert" className={styles.error}>
          {error}
        </p>
      ) : null}
      {liveAsk ? (
        <div role="alert" className={styles.confirm}>
          <span>{liveAsk}</span>
          <Button size="sm" variant="primary" onClick={() => start(true)} disabled={busy}>
            Run anyway
          </Button>
          <Button size="sm" onClick={() => setLiveAsk(null)}>
            Not now
          </Button>
        </div>
      ) : null}

      {run.groups.some((g) => g.isRepo) ? (
        <ul className={styles.repos} aria-label="Repositories">
          {run.groups
            .filter((g) => g.isRepo)
            .map((g) => (
              <RepoRow
                key={g.id}
                group={g}
                run={run}
                busy={busy}
                onDecide={(id, d) =>
                  void act(() => projectSyncApi.decide(run.id, { groups: { [id]: d } }))
                }
              />
            ))}
        </ul>
      ) : null}

      <div className={styles.toolbar}>
        <Field label="Show">
          <NativeSelect<SyncEntryFilter>
            value={filter}
            onChange={(f) => {
              setFilter(f);
              setPage(1);
            }}
            options={FILTERS}
          />
        </Field>
        <Field label="Folder">
          <NativeSelect
            value={group}
            onChange={(g) => {
              setGroup(g);
              setPage(1);
            }}
            options={groupOptions}
          />
        </Field>
        {run.state === 'review' && (run.counts.different ?? 0) > 0 ? (
          <>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  projectSyncApi.decide(run.id, { bulk: { change: 'different', action: 'push' } }),
                )
              }
            >
              Replace all different (backups kept)
            </Button>
            <Button
              size="sm"
              disabled={busy}
              onClick={() =>
                void act(() =>
                  projectSyncApi.decide(run.id, { bulk: { change: 'different', action: 'keep' } }),
                )
              }
            >
              Keep all device copies
            </Button>
          </>
        ) : null}
        {run.state === 'review' && (run.counts.extra ?? 0) > 0 ? (
          <Button
            size="sm"
            disabled={busy}
            onClick={() =>
              void act(() =>
                projectSyncApi.decide(run.id, {
                  bulk: { change: 'extra', action: 'delete-device' },
                }),
              )
            }
          >
            Delete all device-only files (to trash)
          </Button>
        ) : null}
      </div>

      {entries && entries.list.length === 0 ? (
        <EmptyState
          compact
          title={filter === 'changes' ? 'No changes in this view.' : 'Nothing matches this view.'}
        />
      ) : (
        <ul className={styles.entries} aria-label="Planned changes">
          {(entries?.list ?? []).map((e) => (
            <EntryRow
              key={e.id}
              entry={e}
              run={run}
              repo={repos.has(e.groupId)}
              busy={busy}
              onAction={(id, a) =>
                void act(() => projectSyncApi.decide(run.id, { entries: { [id]: a } }))
              }
            />
          ))}
        </ul>
      )}
      {totalPages > 1 ? (
        <Pagination page={page} totalPages={totalPages} onPageChange={setPage} label="Plan pages" />
      ) : null}

      <div className={styles.footer}>
        {running ? (
          <Button onClick={() => void act(() => projectSyncApi.cancel(run.id))} disabled={busy}>
            Cancel remaining
          </Button>
        ) : null}
        {latest && runnable ? (
          <Button
            variant="primary"
            disabled={busy || run.pendingDecisions > 0 || remaining <= 0}
            onClick={() => start(false)}
          >
            {run.state === 'review'
              ? `Run ${run.total} change${run.total === 1 ? '' : 's'}`
              : `Retry ${remaining} remaining`}
          </Button>
        ) : null}
        {run.pendingDecisions > 0 && runnable ? (
          <span className={styles.hint}>
            {run.pendingDecisions} decision{run.pendingDecisions === 1 ? '' : 's'} left
          </span>
        ) : null}
        {latest && !running && run.done > 0 && run.state !== 'undone' && !undoAsk ? (
          <Button variant="danger" disabled={busy} onClick={() => setUndoAsk(true)}>
            Undo this run
          </Button>
        ) : null}
      </div>
      {undoAsk ? (
        <div role="alert" className={styles.confirm}>
          <span>
            Undo puts back what this run replaced or deleted on the device and removes what it
            added. Files changed on the device since are left alone.
          </span>
          <Button size="sm" variant="danger" onClick={() => void undo()} disabled={busy}>
            Undo run
          </Button>
          <Button size="sm" onClick={() => setUndoAsk(false)}>
            Keep it
          </Button>
        </div>
      ) : null}
    </div>
  );
}
