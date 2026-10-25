/**
 * The live centrals reach `mcpStore` two ways, both through `useWebSocket`: the `centrals_update` message the
 * server sends to this Mac's windows, and a read of GET /api/mcp/centrals every time the socket connects (a
 * message sent while the socket was down is never replayed). Only the dashboard window reads: a pop-out
 * mounts no New Session form, and the phone app may not start a central.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useMcpStore } from '@/stores/mcpStore';
import type { CentralSummary } from '@/types';

const ws = vi.hoisted(() => ({
  onMessage: null as ((msg: unknown) => void) | null,
  onStatus: null as ((status: string) => void) | null,
}));

vi.mock('@/lib/wsClient', () => ({
  WsClient: class {
    constructor(opts: { onMessage: (msg: unknown) => void; onStatus: (status: string) => void }) {
      ws.onMessage = opts.onMessage;
      ws.onStatus = opts.onStatus;
    }
    connect() {}
    dispose() {}
  },
}));
vi.mock('@/lib/db', () => ({
  db: {
    sessions: { toCollection: () => ({ primaryKeys: async () => [] }), delete: async () => undefined, bulkDelete: async () => undefined },
    delete: async () => undefined,
    open: async () => undefined,
  },
  migrateSessionId: async () => undefined,
  persistSessionUpdate: async () => undefined,
  deleteSessionChildrenBatch: async () => undefined,
}));
vi.mock('@/lib/workspaceSnapshot', () => ({ isImportInProgress: () => false }));
vi.mock('@/lib/pinnedRespawn', () => ({ onSessionEnded: vi.fn() }));
vi.mock('@/lib/translationLog', () => ({ migrateOriginSessionId: async () => undefined }));
vi.mock('@/lib/alarmEngine', () => ({ handleEventSounds: vi.fn(), checkAlarms: vi.fn() }));
// Reading the room list is the socket's other connect-time job; not what is looked at here.
vi.mock('@/lib/roomSync', () => ({
  receiveRooms: vi.fn(),
  handleRoomOpMessage: vi.fn(),
  onRoomsSocketConnected: vi.fn(),
}));

function Harness() {
  useWebSocket(null);
  return null;
}

const row = (over: Partial<CentralSummary> = {}): CentralSummary => ({
  centralId: 'c1',
  kind: 'global',
  scopeRef: null,
  cli: 'claude',
  sessionId: null,
  toolsets: ['sessions'],
  createdAt: 1,
  workerCount: 0,
  ...over,
});

const send = (msg: Record<string, unknown>) => act(() => { ws.onMessage?.(msg); });
const status = (value: string) => act(() => { ws.onStatus?.(value); });

describe('useWebSocket — central sessions', () => {
  const realLoad = useMcpStore.getState().load;
  const realLoadTasks = useMcpStore.getState().loadTasks;
  let load: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    load = vi.fn(async () => undefined);
    // The tasks in flight are read at connect too (their own test file looks at that): never over a real network here.
    useMcpStore.setState({ centrals: new Map(), available: null, passwordEnabled: null, revision: 0, load, loadTasks: vi.fn(async () => undefined) } as never);
  });

  afterEach(() => {
    useMcpStore.setState({ load: realLoad, loadTasks: realLoadTasks } as never);
    window.history.pushState({}, '', '/');
    ws.onMessage = null;
    ws.onStatus = null;
    vi.unstubAllGlobals();
  });

  describe('centrals_update', () => {
    beforeEach(() => {
      render(<Harness />);
    });

    it('puts the list in the store', () => {
      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' }), row({ centralId: 'b', kind: 'room', scopeRef: 'room-1' })] });

      const { centrals, available } = useMcpStore.getState();
      expect([...centrals.keys()]).toEqual(['a', 'b']);
      expect(available).toBe(true);
    });

    it('replaces the list, so a central that ended is gone', () => {
      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });
      send({ type: 'centrals_update', centrals: [] });

      expect(useMcpStore.getState().centrals.size).toBe(0);
    });

    it('ignores a message with no list, and keeps what it held', () => {
      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });
      send({ type: 'centrals_update' });

      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
    });
  });

  // A pop-out gets no Hands off button, no ACTIVITY tab and no worker badges: `available` is what shows the first two,
  // and the server sends `centrals_update` to every window of this Mac, pop-outs included. A window that never read
  // the list must not be made "available" by it.
  describe('in a pop-out window', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/?popout=session');
      render(<Harness />);
    });

    it('centrals_update does not make a pop-out available', () => {
      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });

      expect(useMcpStore.getState().available).toBeNull();
    });

    it('holds no list from it either, and does not count it', () => {
      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });

      expect(useMcpStore.getState().centrals.size).toBe(0);
      expect(useMcpStore.getState().revision).toBe(0);
    });

    it('stays unavailable through any number of them, so it never gains Hands off or an ACTIVITY tab at a later change', () => {
      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });
      send({ type: 'centrals_update', centrals: [] });
      send({ type: 'centrals_update', centrals: [row({ centralId: 'b' })] });

      expect(useMcpStore.getState().available).toBeNull();
    });
  });

  // `nativeApp` is the Capacitor phone shell, found by the `AASC-Mobile/` token its WebView user agent carries
  // (mobile/capacitor.config.ts). The Electron desktop window has no such token, so it is the dashboard window and
  // follows the centrals: the window that offers Hands off and the ACTIVITY tab must never be taken for the phone.
  describe('in the Electron desktop window', () => {
    it('is made available by centrals_update, and holds the list', () => {
      vi.stubGlobal('navigator', {
        ...navigator,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AASC/2.10.57 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36',
      });
      render(<Harness />);

      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });

      expect(useMcpStore.getState().available).toBe(true);
      expect([...useMcpStore.getState().centrals.keys()]).toEqual(['a']);
    });

    it('reads the list when the socket connects', () => {
      vi.stubGlobal('navigator', {
        ...navigator,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AASC/2.10.57 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36',
      });
      render(<Harness />);

      status('connected');

      expect(load).toHaveBeenCalledTimes(1);
    });
  });

  describe('in the phone app', () => {
    it('does not make it available either (it may not see a central)', () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)' });
      render(<Harness />);

      send({ type: 'centrals_update', centrals: [row({ centralId: 'a' })] });

      expect(useMcpStore.getState().available).toBeNull();
    });
  });

  describe('reading the list when the socket connects', () => {
    it('reads it in the dashboard window', () => {
      render(<Harness />);

      status('connected');

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('reads it again at every reconnect, since nothing sent while the socket was down is replayed', () => {
      render(<Harness />);

      status('connected');
      status('reconnecting');
      status('connected');

      expect(load).toHaveBeenCalledTimes(2);
    });

    it('does not read it while the socket is down or still reconnecting', () => {
      render(<Harness />);

      status('reconnecting');
      status('disconnected');

      expect(load).not.toHaveBeenCalled();
    });

    it('does not read it in a pop-out window, which has no New Session form', () => {
      window.history.pushState({}, '', '/?popout=queue');
      render(<Harness />);

      status('connected');

      expect(load).not.toHaveBeenCalled();
    });

    it('does not read it in the phone app, which may not start a central', () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)' });
      render(<Harness />);

      status('connected');

      expect(load).not.toHaveBeenCalled();
    });
  });
});
