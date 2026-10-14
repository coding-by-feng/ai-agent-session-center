import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

const syncPlanUsage = vi.hoisted(() => vi.fn());
const showToast = vi.hoisted(() => vi.fn());
vi.mock('@/lib/planUsageApi', () => ({ syncPlanUsage }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast }));

import { MIN_SYNCING_MS, useSyncPlanUsage } from './useSyncPlanUsage';

const REPLY = { cli: 'claude', checkedAt: 5_000, asOf: 4_000, changed: true };

beforeEach(() => {
  vi.useFakeTimers();
  syncPlanUsage.mockReset();
  showToast.mockReset();
  syncPlanUsage.mockResolvedValue(REPLY);
});
afterEach(() => {
  vi.useRealTimers();
});

const flush = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });

describe('useSyncPlanUsage', () => {
  it('starts idle', () => {
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    expect(result.current.state).toEqual({ status: 'idle' });
  });

  it('is syncing the moment it is asked, and stays so long enough to be seen even when the reply is instant', async () => {
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    expect(result.current.state.status).toBe('syncing');
    expect(syncPlanUsage).toHaveBeenCalledWith('claude', expect.any(AbortSignal));
    await flush(MIN_SYNCING_MS - 1);
    expect(result.current.state.status).toBe('syncing');
    await flush(1);
    expect(result.current.state).toEqual({ status: 'done', checkedAt: 5_000, changed: true });
  });

  it('waits for a slow reply instead of cutting it off at the minimum', async () => {
    syncPlanUsage.mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(REPLY), 3_000)));
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    await flush(2_999);
    expect(result.current.state.status).toBe('syncing');
    await flush(1);
    expect(result.current.state.status).toBe('done');
  });

  it('ignores a click while one is in flight', async () => {
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    act(() => { result.current.sync(); });
    act(() => { result.current.sync(); });
    expect(syncPlanUsage).toHaveBeenCalledTimes(1);
    await flush(MIN_SYNCING_MS);
  });

  it('says it failed, and the next click tries again', async () => {
    syncPlanUsage.mockRejectedValueOnce(new Error('Rate limit exceeded'));
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    await flush(MIN_SYNCING_MS);
    expect(result.current.state).toEqual({ status: 'failed' });
    act(() => { result.current.sync(); });
    await flush(MIN_SYNCING_MS);
    expect(result.current.state.status).toBe('done');
    expect(syncPlanUsage).toHaveBeenCalledTimes(2);
  });

  it('says so in a toast when it fails: a touch screen has no panel to read it in', async () => {
    syncPlanUsage.mockRejectedValueOnce(new Error('Rate limit exceeded'));
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    await flush(MIN_SYNCING_MS);
    expect(showToast).toHaveBeenCalledTimes(1);
    expect(showToast).toHaveBeenCalledWith("Couldn't sync plan usage", 'error');
  });

  it('shows no toast for an answer, whether or not the numbers moved', async () => {
    const { result } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    await flush(MIN_SYNCING_MS);
    expect(showToast).not.toHaveBeenCalled();
  });

  it('does nothing without a CLI', () => {
    const { result } = renderHook(() => useSyncPlanUsage(null));
    act(() => { result.current.sync(); });
    expect(syncPlanUsage).not.toHaveBeenCalled();
    expect(result.current.state.status).toBe('idle');
  });

  it('forgets the last answer when the CLI changes: it belongs to the other account', async () => {
    const { result, rerender } = renderHook(({ cli }) => useSyncPlanUsage(cli), { initialProps: { cli: 'claude' as 'claude' | 'codex' } });
    act(() => { result.current.sync(); });
    await flush(MIN_SYNCING_MS);
    expect(result.current.state.status).toBe('done');
    rerender({ cli: 'codex' });
    expect(result.current.state.status).toBe('idle');
  });

  it('keeps the answer when only the session changes within one CLI', async () => {
    const { result, rerender } = renderHook(({ cli }) => useSyncPlanUsage(cli), { initialProps: { cli: 'claude' as 'claude' | 'codex' } });
    act(() => { result.current.sync(); });
    await flush(MIN_SYNCING_MS);
    rerender({ cli: 'claude' });
    expect(result.current.state.status).toBe('done');
  });

  it('stops the request and stays quiet when it unmounts mid-sync', async () => {
    let signal: AbortSignal | undefined;
    syncPlanUsage.mockImplementation((_cli: string, s: AbortSignal) => {
      signal = s;
      return new Promise((_resolve, reject) => s.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    });
    const { result, unmount } = renderHook(() => useSyncPlanUsage('claude'));
    act(() => { result.current.sync(); });
    unmount();
    expect(signal?.aborted).toBe(true);
    await flush(MIN_SYNCING_MS);
    expect(vi.getTimerCount()).toBe(0);
    expect(showToast).not.toHaveBeenCalled(); // an abort is not a failure anyone should hear about
  });
});
