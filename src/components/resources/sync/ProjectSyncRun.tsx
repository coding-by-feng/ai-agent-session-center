/**
 * ProjectSyncRun — a link's latest compare: what changed on each side, the decisions it still
 * owes, then the run and its progress, Retry for what failed, and Undo. Only the latest run of a
 * link can run or be undone, so the dialog shows no other.
 */
import { useCallback, useEffect, useState } from 'react';
import type {
  SyncAction,
  SyncChange,
  SyncDirection,
  SyncEntry,
  SyncEntryFilter,
  SyncRun,
} from '@/types/projectSync';
import { projectSyncApi, SyncRequestError } from '@/lib/projectSyncApi';
import { formatBytes, runSummary, runTraffic } from '@/lib/projectSyncFormat';
import Button from '@/components/ui/Button';
import Chip, { type ChipTone } from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect from '@/components/ui/NativeSelect';
import Pagination from '@/components/ui/Pagination';
import { EntryRow, RepoRow } from './ProjectSyncEntry';
import styles from '@/styles/modules/ProjectSync.module.css';

const PAGE = 100;
const FILTERS: { value: SyncEntryFilter; label: string }[] = [
  { value: 'changes', label: 'Changes' },
  { value: 'decisions', label: 'Needs a decision' },
  { value: 'failed', label: 'Failed' },
  { value: 'credentials', label: 'Credential files' },
  { value: 'links', label: 'Links' },
  { value: 'all', label: 'Everything' },
];
const STATE: Record<SyncRun['state'], { label: string; tone: ChipTone }> = {
  comparing: { label: 'Comparing', tone: 'accent' },
  review: { label: 'Review', tone: 'info' },
  running: { label: 'Syncing', tone: 'accent' },
  complete: { label: 'Done', tone: 'success' },
  partial: { label: 'Partly done', tone: 'warning' },
  failed: { label: 'Failed', tone: 'danger' },
  cancelled: { label: 'Cancelled', tone: 'warning' },
  interrupted: { label: 'Interrupted', tone: 'warning' },
  undone: { label: 'Undone', tone: 'neutral' },
};
/** Questions the server asks before a run starts, and the button that answers yes. */
type AskCode = 'live-sessions' | 'mass-delete';
const ASK_YES: Record<AskCode, string> = {
  'live-sessions': 'Sync anyway',
  'mass-delete': 'Delete them',
};
const isAskCode = (c: string | undefined): c is AskCode =>
  c === 'live-sessions' || c === 'mass-delete';
/**
 * Brings an answer to the footer's buttons into view as it appears: the footer sits below a long
 * plan, and a question shown out of sight reads as a button that did nothing. Module scope keeps
 * the ref stable, so it runs when the answer mounts, not on every poll.
 */
const reveal = (el: HTMLElement | null) => {
  el?.scrollIntoView?.({ block: 'nearest' });
};
const RETRY_STATES: ReadonlySet<SyncRun['state']> = new Set([
  'partial',
  'failed',
  'cancelled',
  'interrupted',
]);

interface Bulk {
  title: string;
  changes: SyncChange[];
  actions: { label: string; action: SyncAction }[];
}

/**
 * One choice for every entry of a kind, worded as each row's select words it (repositories
 * decide on their own row).
 */
function bulksFor(run: SyncRun, direction: SyncDirection): Bulk[] {
  const has = (c: SyncChange) => (run.counts[c] ?? 0) > 0;
  if (direction === 'two-way') {
    const changes = (['conflict', 'different'] as const).filter(has);
    return changes.length
      ? [
          {
            title: 'Every conflict',
            changes,
            actions: [
              { label: 'Keep both', action: 'keep-both' },
              { label: 'Keep this computer’s', action: 'push' },
              { label: 'Keep the server’s', action: 'pull' },
            ],
          },
        ]
      : [];
  }
  return [
    ...(has('different')
      ? [
          {
            title: 'Every different file',
            changes: ['different'] as SyncChange[],
            actions: [
              { label: 'Copy to the server (backups kept)', action: 'push' as const },
              { label: 'Keep the server copy', action: 'keep' as const },
            ],
          },
        ]
      : []),
    ...(has('drift')
      ? [
          {
            title: 'Every file changed on the server',
            changes: ['drift'] as SyncChange[],
            actions: [
              { label: 'Copy to the server (backups kept)', action: 'push' as const },
              { label: 'Keep the server’s', action: 'keep' as const },
            ],
          },
        ]
      : []),
    ...(has('extra')
      ? [
          {
            title: 'Every server-only file',
            changes: ['extra'] as SyncChange[],
            actions: [
              { label: 'Delete on the server (to trash)', action: 'delete-device' as const },
            ],
          },
        ]
      : []),
  ];
}

function progress(run: SyncRun): string {
  if (run.state === 'review') return runTraffic(run);
  const parts = [`${run.done}/${run.total} done`];
  if (run.failed) parts.push(`${run.failed} failed`);
  if (run.state === 'running') {
    if (run.bytes.toSend)
      parts.push(`${formatBytes(run.bytes.sent)} of ${formatBytes(run.bytes.toSend)} sent`);
    if (run.bytes.toGet)
      parts.push(`${formatBytes(run.bytes.got ?? 0)} of ${formatBytes(run.bytes.toGet)} received`);
  }
  return parts.join(' · ');
}

export default function ProjectSyncRun({
  run,
  direction,
  onRun,
}: {
  run: SyncRun;
  direction: SyncDirection;
  onRun: (r: SyncRun) => void;
}) {
  const [filter, setFilter] = useState<SyncEntryFilter>('changes');
  const [group, setGroup] = useState<string>('*');
  const [page, setPage] = useState(1);
  const [entries, setEntries] = useState<{ list: SyncEntry[]; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ask, setAsk] = useState<{ code: AskCode; message: string } | null>(null);
  /** What the user already said yes to for this run: one Sync can meet both questions. */
  const [confirmed, setConfirmed] = useState<{ liveSessions?: boolean; deletes?: boolean }>({});
  const [undoAsk, setUndoAsk] = useState(false);
  const repos = new Set(run.groups.filter((g) => g.isRepo).map((g) => g.id));

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
        if (e instanceof SyncRequestError && isAskCode(e.code))
          setAsk({ code: e.code, message: e.message });
        else setError(e instanceof Error ? e.message : 'Request failed.');
      } finally {
        setBusy(false);
      }
    },
    [onRun],
  );
  const start = (yes?: AskCode) => {
    const next = {
      ...confirmed,
      ...(yes === 'live-sessions' ? { liveSessions: true } : {}),
      ...(yes === 'mass-delete' ? { deletes: true } : {}),
    };
    setAsk(null);
    void act(async () => {
      try {
        const started = await projectSyncApi.start(run.id, next);
        setConfirmed({});
        return started;
      } catch (e) {
        // A yes carries to the next question of this same press of Sync, never to a later Retry.
        setConfirmed(e instanceof SyncRequestError && isAskCode(e.code) ? next : {});
        throw e;
      }
    });
  };
  const notNow = () => {
    setAsk(null);
    setConfirmed({});
  };
  const bulk = (b: Bulk, action: SyncAction) =>
    void act(async () => {
      let last = run;
      for (const change of b.changes)
        last = await projectSyncApi.decide(run.id, { bulk: { change, action } });
      return last;
    });
  const undo = () => {
    setUndoAsk(false);
    void act(async () => (await projectSyncApi.undo(run.id)).run);
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
  const runnable =
    !run.stale && !!run.planned && (run.state === 'review' || RETRY_STATES.has(run.state));
  // As the server judges it: a run that started can have written, even if nothing finished.
  const undoable =
    !running &&
    run.state !== 'undone' &&
    run.startedAt !== undefined &&
    (run.done > 0 ||
      run.state === 'interrupted' ||
      run.state === 'failed' ||
      run.state === 'cancelled');
  const remaining = run.total - run.done;
  const totalPages = Math.max(1, Math.ceil((entries?.total ?? 0) / PAGE));
  const groupOptions = [
    { value: '*', label: 'All folders' },
    ...run.groups.map((g) => ({ value: g.id, label: g.id === '' ? '(project root files)' : g.id })),
  ];
  const bulks = run.state === 'review' ? bulksFor(run, direction) : [];

  return (
    <div className={styles.run}>
      <div className={styles.runHead}>
        <Chip tone={STATE[run.state].tone}>{STATE[run.state].label}</Chip>
        <span className={styles.summary}>{runSummary(run)}</span>
        <span className={styles.hint}>{progress(run)}</span>
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

      {repos.size ? (
        <ul className={styles.repos} aria-label="Repositories">
          {run.groups
            .filter((g) => g.isRepo)
            .map((g) => (
              <RepoRow
                key={g.id}
                group={g}
                run={run}
                direction={direction}
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
        {/* Acts on pick, then reads "Choose…" again: it is a shortcut, not a setting. */}
        {bulks.map((b) => (
          <Field key={b.title} label={b.title}>
            <NativeSelect<SyncAction | ''>
              value=""
              disabled={busy}
              onChange={(a) => a && bulk(b, a)}
              options={[
                { value: '', label: 'Choose…' },
                ...b.actions.map((a) => ({ value: a.action, label: a.label })),
              ]}
            />
          </Field>
        ))}
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
              direction={direction}
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
        {runnable && !ask ? (
          // A review with nothing to copy still runs: it records both sides as the new base.
          <Button
            variant="primary"
            disabled={
              busy || run.pendingDecisions > 0 || (run.state !== 'review' && remaining <= 0)
            }
            onClick={() => start()}
          >
            {run.state !== 'review'
              ? `Retry ${remaining} remaining`
              : run.total
                ? `Sync ${run.total} change${run.total === 1 ? '' : 's'}`
                : 'Mark as in sync'}
          </Button>
        ) : null}
        {run.pendingDecisions > 0 && runnable ? (
          <span className={styles.hint}>
            {run.pendingDecisions} decision{run.pendingDecisions === 1 ? '' : 's'} left
          </span>
        ) : run.state === 'review' && !run.total ? (
          <span className={styles.hint}>Nothing to copy: both sides match.</span>
        ) : null}
        {undoable && !undoAsk ? (
          <Button variant="danger" disabled={busy} onClick={() => setUndoAsk(true)}>
            Undo this run
          </Button>
        ) : null}
      </div>
      {error ? (
        <p role="alert" ref={reveal} className={styles.error}>
          {error}
        </p>
      ) : null}
      {ask ? (
        <div role="alert" ref={reveal} className={styles.confirm}>
          <span>{ask.message}</span>
          <Button
            size="sm"
            variant={ask.code === 'mass-delete' ? 'danger' : 'primary'}
            onClick={() => start(ask.code)}
            disabled={busy}
          >
            {ASK_YES[ask.code]}
          </Button>
          <Button size="sm" onClick={notNow}>
            Not now
          </Button>
        </div>
      ) : null}
      {undoAsk ? (
        <div role="alert" ref={reveal} className={styles.confirm}>
          <span>
            Undo puts back what this run replaced or deleted, on this computer and on the server,
            and removes what it added. Files changed since are left alone.
          </span>
          <Button size="sm" variant="danger" onClick={undo} disabled={busy}>
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
