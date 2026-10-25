// syncStatusStore.test.ts — one sync list for every surface of the RESOURCES tab (Oct 23 2026):
// read once per account, shown stale from the browser until a live read lands, joined while in
// flight, dropped when the account changed, and read again when the jobs a surface started end.
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cloudApi } from '@/lib/cloudApi';
import type { CloudJob, SyncItem, SyncStatus } from '@/types/cloudResources';
import { cacheKey, readCache } from './cloudCache';
import {
  JOB_POLL_MS,
  followJobs,
  hydrateSyncStatus,
  loadSyncStatus,
  reloadSyncStatus,
  resetSyncStatus,
  useSyncStatus,
  useSyncStatusStore,
} from './syncStatusStore';

const binding = {
  backendOrigin: 'https://fixture.invalid',
  accountId: '00000000-0000-4000-8000-000000000001',
  deviceId: '00000000-0000-4000-8000-000000000002',
  deviceName: 'Fixture',
  generation: 1,
};
const other = { ...binding, accountId: '00000000-0000-4000-8000-000000000009' };
const key = cacheKey(binding);
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const item = (n: number, fields: Partial<SyncItem> = {}): SyncItem => ({
  resourceId: id(n),
  catalogId: `cat-${n}`,
  name: `r${n}`,
  agent: 'claude',
  kind: 'skill',
  scope: 'global',
  state: 'synced',
  cloudVersion: 1,
  syncedVersion: 1,
  memory: false,
  ...fields,
});
const LIVE: SyncStatus = {
  items: [item(1), item(2, { state: 'cloud-only', catalogId: null })],
  waiting: 1,
};
const job = (state: CloudJob['state']): CloudJob => ({
  id: id(50),
  kind: 'publish',
  state,
  steps: [{ id: 's', label: 'demo', state: state === 'complete' ? 'complete' : 'running' }],
});

beforeEach(() => {
  localStorage.clear();
  resetSyncStatus();
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('reading the list', () => {
  it('shows the list this browser saved as stale, then the live one', async () => {
    localStorage.setItem(
      'aasc.cloud.browse.' + key,
      JSON.stringify({
        resources: [],
        projects: [],
        jobs: [],
        savedAt: 1,
        sync: { items: [item(1, { state: 'local-changed' })], waiting: 1 },
      }),
    );
    hydrateSyncStatus(key);
    expect(useSyncStatusStore.getState()).toMatchObject({ stale: true, value: { waiting: 1 } });
    vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue(LIVE);
    await loadSyncStatus(binding);
    expect(useSyncStatusStore.getState()).toMatchObject({
      stale: false,
      loading: false,
      value: LIVE,
    });
    expect(readCache(key).sync).toEqual(LIVE);
  });

  it('joins a read already in flight instead of asking twice', async () => {
    const read = vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue(LIVE);
    await Promise.all([loadSyncStatus(binding), loadSyncStatus(binding), loadSyncStatus(binding)]);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('reads again after an action, even while a read from before it is still running', async () => {
    // Stop syncing lands while a scan's read is running; joining that read would show the
    // resource as it was before the stop until something else read the list again.
    let answer!: (value: SyncStatus) => void;
    const AFTER: SyncStatus = { items: [item(1, { state: 'stopped' })], waiting: 0 };
    const read = vi
      .spyOn(cloudApi, 'syncStatus')
      .mockReturnValueOnce(new Promise((r) => (answer = r)))
      .mockResolvedValueOnce(AFTER);
    const running = loadSyncStatus(binding, 0);
    const after = reloadSyncStatus(binding);
    answer(LIVE);
    await Promise.all([running, after]);
    expect(read).toHaveBeenCalledTimes(2);
    expect(useSyncStatusStore.getState().value).toEqual(AFTER);
  });

  it('an action on an account the tab has left reads nothing', async () => {
    const read = vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue(LIVE);
    hydrateSyncStatus(cacheKey(other));
    await reloadSyncStatus(binding);
    expect(read).not.toHaveBeenCalled();
    expect(useSyncStatusStore.getState().key).toBe(cacheKey(other));
  });

  it('drops an answer that lands after the account changed', async () => {
    let answer!: (value: SyncStatus) => void;
    vi.spyOn(cloudApi, 'syncStatus').mockReturnValue(new Promise((r) => (answer = r)));
    const reading = loadSyncStatus(binding);
    hydrateSyncStatus(cacheKey(other));
    answer(LIVE);
    await reading;
    expect(useSyncStatusStore.getState()).toMatchObject({ key: cacheKey(other), value: null });
  });

  it('drops a read from before a connection change, even back to the same account', async () => {
    let answer!: (value: SyncStatus) => void;
    vi.spyOn(cloudApi, 'syncStatus')
      .mockReturnValueOnce(new Promise((r) => (answer = r)))
      .mockResolvedValue({ items: [], waiting: 0 });
    const old = loadSyncStatus(binding, 1);
    const fresh = loadSyncStatus(binding, 2); // reconnected: a new epoch, the same account
    answer(LIVE);
    await Promise.all([old, fresh]);
    expect(useSyncStatusStore.getState()).toMatchObject({ epoch: 2, value: { items: [] } });
  });

  it('keeps the job history when the saved list is in an older shape (no catalogId)', () => {
    const old = { ...item(1) } as Partial<SyncItem>;
    delete old.catalogId;
    localStorage.setItem(
      'aasc.cloud.browse.' + key,
      JSON.stringify({
        resources: [],
        projects: [],
        savedAt: 1,
        sync: { items: [old], waiting: 0 },
        jobs: [{ job: job('complete'), generation: 1 }],
      }),
    );
    const cache = readCache(key);
    expect(cache.sync).toBeUndefined();
    expect(cache.jobs).toHaveLength(1);
  });
});

describe('what a surface reads', () => {
  it('maps items to Library rows by catalog id; one not on this Mac has none', async () => {
    vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue(LIVE);
    await loadSyncStatus(binding);
    const { result } = renderHook(() => useSyncStatus(key));
    expect(result.current.byCatalog.get('cat-1')?.resourceId).toBe(id(1));
    expect([...result.current.byCatalog.keys()]).toEqual(['cat-1']);
    // Another account's surface sees nothing of it.
    const { result: elsewhere } = renderHook(() => useSyncStatus(cacheKey(other)));
    expect(elsewhere.current.value).toBeNull();
  });
});

describe('following jobs', () => {
  it('polls a running job until it ends, then reads the list once', async () => {
    vi.useFakeTimers();
    const read = vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue(LIVE);
    const poll = vi
      .spyOn(cloudApi, 'job')
      .mockResolvedValueOnce(job('running'))
      .mockResolvedValueOnce(job('complete'));
    hydrateSyncStatus(key);
    followJobs([job('queued')], binding, [id(1)]);
    const { result } = renderHook(() => useSyncStatus(key));
    expect(result.current.moving.has(id(1))).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(JOB_POLL_MS * 2 + 10);
    });
    expect(poll).toHaveBeenCalledTimes(2);
    expect(read).toHaveBeenCalledTimes(1);
    expect(result.current.moving.size).toBe(0);
    expect(result.current.jobs[id(50)].state).toBe('complete');
    // Remembered for the Cloud sync tab's Activity.
    expect(readCache(key).jobs.map((j) => j.job.state)).toEqual(['complete']);
  });

  it('reads the list at once when the jobs already ended', async () => {
    const read = vi.spyOn(cloudApi, 'syncStatus').mockResolvedValue(LIVE);
    followJobs([job('complete')], binding);
    await vi.waitFor(() => expect(read).toHaveBeenCalledTimes(1));
  });
});
