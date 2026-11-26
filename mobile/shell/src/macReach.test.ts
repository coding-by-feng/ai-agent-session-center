// macReach.test.ts — Online / Offline for each row of the list of computers (Nov 27 2026).
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AccountMac } from './accountMacs';
import { accountReachKey, REACH_MS, reachOne, reachTargets } from './macReach';
import type { SavedMac } from './savedMacs';

afterEach(() => vi.useRealTimers());

const saved = (over: Partial<SavedMac> = {}): SavedMac => ({
  id: 'mac-1', name: 'Kason-MBP', port: 3333, lan: '192.168.1.20', tailnet: '100.101.102.103', lanAllowed: false,
  backendDeviceId: null, status: 'active', confirmCode: null, phoneName: 'Pixel', lastPath: null, ...over,
});
const listed = (over: Partial<AccountMac> = {}): AccountMac => ({
  deviceId: '7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f', name: 'Office', lan: null, tailnet: '100.64.0.9', port: 3333, lastUsedAt: null, ...over,
});

describe('reachTargets', () => {
  it('probes a saved computer on the paths opening it would use: no home network unless allowed', () => {
    expect(reachTargets([saved()], [])).toEqual([{ key: 'mac-1', origins: ['http://100.101.102.103:3333'] }]);
    expect(reachTargets([saved({ lanAllowed: true })], [])[0].origins).toEqual(['http://192.168.1.20:3333', 'http://100.101.102.103:3333']);
  });

  it('skips a computer still waiting for approval', () => {
    expect(reachTargets([saved({ status: 'pending' })], [])).toEqual([]);
  });

  it('probes an account computer on its listed addresses, and on nothing without a port', () => {
    expect(reachTargets([], [listed({ lan: '192.168.1.30' })])).toEqual([
      { key: accountReachKey('7d3e9a2c-1b4f-4c6d-8e2f-3a5b6c7d8e9f'), origins: ['http://192.168.1.30:3333', 'http://100.64.0.9:3333'] },
    ]);
    expect(reachTargets([], [listed({ port: null })])[0].origins).toEqual([]);
    expect(reachTargets([], [listed({ tailnet: '8.8.8.8', lan: '8.8.4.4' })])[0].origins).toEqual([]);
  });
});

describe('reachOne', () => {
  it('is online at the first path that answers', async () => {
    const probe = vi.fn(async (o: string) => o.includes('100.'));
    expect(await reachOne(probe, { key: 'k', origins: ['http://192.168.1.20:3333', 'http://100.1.1.1:3333'] })).toBe('online');
  });

  it('is offline when every path says no, or throws', async () => {
    const probe = vi.fn(async (o: string) => {
      if (o.includes('192')) throw new Error('refused');
      return false;
    });
    expect(await reachOne(probe, { key: 'k', origins: ['http://192.168.1.20:3333', 'http://100.1.1.1:3333'] })).toBe('offline');
  });

  it('is offline with nothing to try', async () => {
    expect(await reachOne(vi.fn(), { key: 'k', origins: [] })).toBe('offline');
  });

  it('says nothing until a path answers, and offline only once REACH_MS has passed', async () => {
    vi.useFakeTimers();
    let settled: string | null = null;
    void reachOne(() => new Promise<boolean>(() => undefined), { key: 'k', origins: ['http://100.1.1.1:3333'] }).then((r) => { settled = r; });
    await vi.advanceTimersByTimeAsync(REACH_MS - 1);
    expect(settled).toBeNull();
    await vi.advanceTimersByTimeAsync(1);
    expect(settled).toBe('offline');
  });
});
