/**
 * syncStatusStore — the AASC-62 sync list, read once and shared by every surface of the RESOURCES
 * tab (Oct 23 2026): Library rows and the detail pane's cloud button, the bulk bar, the Cloud sync
 * tab and its badge show the same answer.
 *
 * - **Keyed by account** (`cacheKey`). The last answer is kept in this browser (cloudCache) and
 *   shown as stale until a live read confirms it. An answer that lands after the account changed
 *   is dropped, and so is one from before a connection change that came back to the same account
 *   (the session `epoch`): a read belongs to the connection it was made over.
 * - **One read at a time per account**: a second read while one is in flight joins it. Reading
 *   the list lists every cloud head and hashes each synced resource on disk, so it runs on open,
 *   after a scan, after a job and on Check again, never on a timer.
 * - **Jobs a surface starts are followed here** (polled every second until they end), so the list
 *   is read again when the last one ends, wherever it was started. Each job is also remembered
 *   in the browser's history, which the Cloud sync tab's Activity shows.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import type { CloudJob, SyncItem, SyncStatus } from '@/types/cloudResources';
import { cloudApi, type CloudReviewBinding } from '@/lib/cloudApi';
import { cacheKey, readCache, rememberJob, writeCache } from './cloudCache';
import { cloudError } from './cloudSession';

const ACTIVE: readonly CloudJob['state'][] = ['queued', 'running'];
export const JOB_POLL_MS = 1000;

interface SyncStatusState {
  key: string;
  /** The cloud session epoch the current reads belong to. */
  epoch: number;
  value: SyncStatus | null;
  /** The value came from this browser's cache and no live read has confirmed it yet. */
  stale: boolean;
  loading: boolean;
  error: string | null;
  /** Jobs started from this tab that have not ended: id → the cloud ids they move (may be empty). */
  following: Readonly<Record<string, readonly string[]>>;
  /** The last state of every job followed here, so a finished one can say how it went. */
  jobs: Readonly<Record<string, CloudJob>>;
  /** The browser refused to save the list or a job (private mode, full storage). */
  cacheError: boolean;
}

const EMPTY: SyncStatusState = {
  key: '',
  epoch: 0,
  value: null,
  stale: true,
  loading: false,
  error: null,
  following: {},
  jobs: {},
  cacheError: false,
};

export const useSyncStatusStore = create<SyncStatusState>(() => EMPTY);

let inflight: { key: string; epoch: number; promise: Promise<void>; again?: Promise<void> } | null =
  null;

/**
 * Show this account's saved list (stale) until a live read lands; a new account starts empty. A new
 * `epoch` on the same account keeps the list but drops reads still in flight from before it.
 */
export function hydrateSyncStatus(key: string, epoch?: number): void {
  const state = useSyncStatusStore.getState();
  if (state.key === key) {
    if (epoch !== undefined && epoch !== state.epoch) {
      inflight = null;
      useSyncStatusStore.setState({ epoch, loading: false, stale: true });
    }
    return;
  }
  inflight = null;
  useSyncStatusStore.setState({
    ...EMPTY,
    key,
    epoch: epoch ?? 0,
    value: key ? (readCache(key).sync ?? null) : null,
  });
}

/**
 * Read the list from the Mac. Joins a read already running for the same account and epoch.
 * Without an `epoch` it belongs to the current one (an action's follow-up read).
 */
export function loadSyncStatus(binding: CloudReviewBinding, epoch?: number): Promise<void> {
  const key = cacheKey(binding);
  hydrateSyncStatus(key, epoch);
  const at = useSyncStatusStore.getState().epoch;
  if (inflight?.key === key && inflight.epoch === at) return inflight.promise;
  useSyncStatusStore.setState({ loading: true });
  const current = () => {
    const s = useSyncStatusStore.getState();
    return s.key === key && s.epoch === at;
  };
  const promise = cloudApi.syncStatus(binding).then(
    (value) => {
      if (!current()) return;
      const saved = writeCache(key, { sync: value, savedAt: Date.now() });
      useSyncStatusStore.setState((s) => ({
        value,
        stale: false,
        loading: false,
        error: null,
        cacheError: s.cacheError || !saved,
      }));
    },
    (error: unknown) => {
      if (!current()) return;
      useSyncStatusStore.setState({ loading: false, error: cloudError(error) });
    },
  );
  const settled = promise.finally(() => {
    if (inflight?.promise === settled) inflight = null;
  });
  inflight = { key, epoch: at, promise: settled };
  return settled;
}

/**
 * Read the list again after something changed it here (a stop, a removal, a job that ended). A
 * read already running may have started before the change, so this one starts after it (one queued
 * read at most). An account the tab has since left reads nothing: its answer would replace the
 * list of the account now shown.
 */
export function reloadSyncStatus(binding: CloudReviewBinding): Promise<void> {
  const key = cacheKey(binding);
  const state = useSyncStatusStore.getState();
  if (state.key && state.key !== key) return Promise.resolve();
  const running = inflight;
  if (running?.key === key && running.epoch === state.epoch) {
    running.again ??= running.promise.then(() => loadSyncStatus(binding));
    return running.again;
  }
  return loadSyncStatus(binding);
}

/**
 * Follow jobs a sync or a save started: remember each in the browser's history, poll the active
 * ones, and read the list again once the last one ends. `resourceIds` are the cloud ids they move
 * (a Library row shows "Syncing…" while one of its ids is followed).
 */
export function followJobs(
  started: readonly CloudJob[],
  binding: CloudReviewBinding,
  resourceIds: readonly string[] = [],
): void {
  const key = cacheKey(binding);
  for (const job of started) remember(key, job, binding.generation);
  const active = started.filter((j) => ACTIVE.includes(j.state));
  if (!active.length) {
    void reloadSyncStatus(binding);
    return;
  }
  useSyncStatusStore.setState((s) => ({
    following: { ...s.following, ...Object.fromEntries(active.map((j) => [j.id, resourceIds])) },
  }));
  for (const job of active) poll(job.id, binding, key);
}

function remember(key: string, job: CloudJob, generation: number): void {
  const saved = rememberJob(key, job, generation);
  useSyncStatusStore.setState((s) => ({
    jobs: { ...s.jobs, [job.id]: job },
    cacheError: s.cacheError || !saved,
  }));
}

function poll(id: string, binding: CloudReviewBinding, key: string): void {
  const stillHere = () => useSyncStatusStore.getState().key === key;
  const finish = () => {
    if (!stillHere()) return;
    const rest = { ...useSyncStatusStore.getState().following };
    delete rest[id];
    useSyncStatusStore.setState({ following: rest });
    if (!Object.keys(rest).length) void reloadSyncStatus(binding);
  };
  const tick = () => {
    if (!stillHere()) return;
    cloudApi.job(id, binding).then(
      (job) => {
        if (!stillHere()) return;
        remember(key, job, binding.generation);
        if (ACTIVE.includes(job.state)) setTimeout(tick, JOB_POLL_MS);
        else finish();
      },
      // A job that can't be read any more (the connection changed, the Mac restarted) ends here;
      // the list read after it says where things stand.
      () => finish(),
    );
  };
  setTimeout(tick, JOB_POLL_MS);
}

/** Forget everything (tests; an account the Mac disconnected from). */
export function resetSyncStatus(): void {
  inflight = null;
  useSyncStatusStore.setState(EMPTY);
}

/** What a surface reads: the list for this account, and its items by Library id and by cloud id. */
export function useSyncStatus(key: string) {
  const state = useSyncStatusStore();
  const value = state.key === key ? state.value : null;
  const byCatalog = useMemo(() => {
    const map = new Map<string, SyncItem>();
    for (const item of value?.items ?? []) if (item.catalogId) map.set(item.catalogId, item);
    return map;
  }, [value]);
  const moving = useMemo(() => new Set(Object.values(state.following).flat()), [state.following]);
  return {
    value,
    stale: state.key === key ? state.stale : true,
    loading: state.key === key && state.loading,
    error: state.key === key ? state.error : null,
    byCatalog,
    /** Cloud ids a followed job is moving right now. */
    moving,
    busy: Object.keys(state.following).length > 0,
    jobs: state.jobs,
    cacheError: state.cacheError,
  };
}
