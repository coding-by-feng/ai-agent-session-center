// Ruling P4-54: the person's "It is ready — send anyway" lives in this window only.
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { isStartReleased, setReleaseWindow, useIsReleaseWindow, useStartReleaseStore } from './startReleaseStore';

const card = { sessionId: 's1', terminalId: 'term-1' };

beforeEach(() => {
  useStartReleaseStore.setState({ released: new Set(), releaseWindow: false });
});

describe('startReleaseStore', () => {
  it('a released card stays released', () => {
    expect(isStartReleased(card)).toBe(false);
    useStartReleaseStore.getState().release(card);
    expect(isStartReleased(card)).toBe(true);
  });

  it('the hold returns for a replaced card (a new terminal, or a new session id)', () => {
    useStartReleaseStore.getState().release(card);
    expect(isStartReleased({ sessionId: 's1', terminalId: 'term-2' })).toBe(false);
    expect(isStartReleased({ sessionId: 's2', terminalId: 'term-1' })).toBe(false);
    expect(isStartReleased({ sessionId: 's1', terminalId: null })).toBe(false);
  });

  it('releasing never mutates the set a subscriber already holds', () => {
    const before = useStartReleaseStore.getState().released;
    useStartReleaseStore.getState().release(card);
    expect(before.size).toBe(0);
  });

  // Ruling P4-57: only the window that fires the queue can honour a release, so only it offers one.
  it('the release window is closed until the scheduler opens it, and a subscriber sees it change', () => {
    const { result } = renderHook(() => useIsReleaseWindow());
    expect(result.current).toBe(false);
    act(() => setReleaseWindow(true));
    expect(result.current).toBe(true);
    act(() => setReleaseWindow(false));
    expect(result.current).toBe(false);
  });

  // "Not reachable by a central": a central acts through the server's /mcp tools and routes. Nothing there, and
  // nothing that syncs or persists this window's state, may know the store.
  it('is imported only by the queue panel (its hold banner) and the queue scheduler', () => {
    const importers: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const path = join(dir, name);
        if (statSync(path).isDirectory()) walk(path);
        else if (/\.(ts|tsx)$/.test(name) && readFileSync(path, 'utf8').includes('startReleaseStore')) importers.push(path);
      }
    };
    walk(join(__dirname, '..'));
    walk(join(__dirname, '..', '..', 'server'));
    const names = importers.map((p) => p.split('/').pop()).sort();
    expect(names).toEqual([
      'QueueHoldBanner.test.tsx',
      'QueueHoldBanner.tsx',
      'QueueTab.test.tsx',
      'QueueTab.tsx',
      'startReleaseStore.test.ts',
      'useGlobalQueueScheduler.test.tsx',
      'useGlobalQueueScheduler.ts',
    ]);
  });
});
