import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useFloatingSessionsStore } from './floatingSessionsStore';

// close() snapshots terminal output via translationLog (Dexie) before killing
// the PTY — stub it out so these unit tests don't touch IndexedDB.
vi.mock('@/lib/translationLog', () => ({
  captureResponse: vi.fn().mockResolvedValue(undefined),
}));

function openFloat(terminalId: string, originSessionId: string) {
  useFloatingSessionsStore.getState().open({
    terminalId,
    label: `L:${terminalId}`,
    originSessionId,
  });
}

function originsOf(): Array<[string, string]> {
  return useFloatingSessionsStore.getState().floats.map((f) => [f.terminalId, f.originSessionId]);
}

describe('floatingSessionsStore — per-session helpers', () => {
  beforeEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    // close() fetches /output then DELETEs the PTY; both best-effort.
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({ output: '' }) })));
  });
  afterEach(() => {
    useFloatingSessionsStore.setState({ floats: [] });
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  describe('closeByOriginSession', () => {
    it('closes every float of the given origin and leaves the rest', () => {
      openFloat('t-A1', 'A');
      openFloat('t-A2', 'A');
      openFloat('t-B1', 'B');

      useFloatingSessionsStore.getState().closeByOriginSession('A');

      expect(originsOf()).toEqual([['t-B1', 'B']]);
    });

    it('issues a DELETE for each closed terminal (kills the server PTY)', async () => {
      openFloat('t-A1', 'A');
      openFloat('t-A2', 'A');

      useFloatingSessionsStore.getState().closeByOriginSession('A');

      // The store removal is synchronous; the PTY-kill DELETE is deferred behind
      // the output-snapshot fetch, so wait for it.
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => {
        const deletedIds = fetchMock.mock.calls
          .filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')
          .map((c) => String(c[0]));
        expect(deletedIds.some((u) => u.includes('t-A1'))).toBe(true);
        expect(deletedIds.some((u) => u.includes('t-A2'))).toBe(true);
      });
    });

    it('is a no-op when no float matches the origin', () => {
      openFloat('t-B1', 'B');
      useFloatingSessionsStore.getState().closeByOriginSession('A');
      expect(originsOf()).toEqual([['t-B1', 'B']]);
    });
  });

  describe('migrateOriginSession', () => {
    it('re-points matching floats from the old origin id to the new one', () => {
      openFloat('t-A1', 'old');
      openFloat('t-A2', 'old');
      openFloat('t-B1', 'other');

      useFloatingSessionsStore.getState().migrateOriginSession('old', 'new');

      expect(originsOf()).toEqual([
        ['t-A1', 'new'],
        ['t-A2', 'new'],
        ['t-B1', 'other'],
      ]);
    });

    it('does not kill PTYs — migration only re-keys (no DELETE)', () => {
      openFloat('t-A1', 'old');
      useFloatingSessionsStore.getState().migrateOriginSession('old', 'new');

      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      const deletes = fetchMock.mock.calls.filter(
        (c) => (c[1] as RequestInit | undefined)?.method === 'DELETE',
      );
      expect(deletes).toHaveLength(0);
      expect(useFloatingSessionsStore.getState().floats).toHaveLength(1);
    });

    it('is a no-op when old === new', () => {
      openFloat('t-A1', 'same');
      const before = useFloatingSessionsStore.getState().floats;
      useFloatingSessionsStore.getState().migrateOriginSession('same', 'same');
      // Same reference — no state churn.
      expect(useFloatingSessionsStore.getState().floats).toBe(before);
    });

    it('is a no-op (same reference) when no float matches the old id', () => {
      openFloat('t-A1', 'A');
      const before = useFloatingSessionsStore.getState().floats;
      useFloatingSessionsStore.getState().migrateOriginSession('nonexistent', 'new');
      expect(useFloatingSessionsStore.getState().floats).toBe(before);
    });
  });

  describe('closeOrphans', () => {
    it('closes floats whose origin is not in the live set, keeps the rest', () => {
      openFloat('t-A1', 'A');
      openFloat('t-B1', 'B');
      openFloat('t-C1', 'C');

      // Only A and C are still live (B vanished from a fresh snapshot).
      useFloatingSessionsStore.getState().closeOrphans(new Set(['A', 'C']));

      expect(originsOf()).toEqual([['t-A1', 'A'], ['t-C1', 'C']]);
    });

    it('closes everything when the live set is empty', () => {
      openFloat('t-A1', 'A');
      openFloat('t-B1', 'B');
      useFloatingSessionsStore.getState().closeOrphans(new Set());
      expect(useFloatingSessionsStore.getState().floats).toHaveLength(0);
    });

    it('is a no-op when every origin is still live', () => {
      openFloat('t-A1', 'A');
      openFloat('t-B1', 'B');
      useFloatingSessionsStore.getState().closeOrphans(new Set(['A', 'B']));
      expect(originsOf()).toEqual([['t-A1', 'A'], ['t-B1', 'B']]);
    });
  });

  describe('open — eviction at MAX_FLOATS', () => {
    it('evicts the oldest float and kills its PTY when the cap is exceeded', async () => {
      // MAX_FLOATS is 4. Fill it, then open a 5th.
      openFloat('t-1', 'A');
      openFloat('t-2', 'A');
      openFloat('t-3', 'A');
      openFloat('t-4', 'A');
      openFloat('t-5', 'B');

      const ids = useFloatingSessionsStore.getState().floats.map((f) => f.terminalId);
      expect(ids).toEqual(['t-2', 't-3', 't-4', 't-5']); // oldest (t-1) evicted

      // The evicted float's PTY is DELETEd so it doesn't leak.
      const fetchMock = global.fetch as unknown as ReturnType<typeof vi.fn>;
      await vi.waitFor(() => {
        const deletedIds = fetchMock.mock.calls
          .filter((c) => (c[1] as RequestInit | undefined)?.method === 'DELETE')
          .map((c) => String(c[0]));
        expect(deletedIds.some((u) => u.includes('t-1'))).toBe(true);
      });
    });
  });
});
