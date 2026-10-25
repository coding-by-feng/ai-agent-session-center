/**
 * What a central does reaches `mcpStore` two ways, both through `useWebSocket`: the `mcp_task_update` and
 * `mcp_activity` messages the server sends to this Mac's windows, and a read of GET /api/mcp/tasks every time
 * the socket connects (a message sent while the socket was down is never replayed, and a window opened mid-task
 * has heard of none). Only the dashboard window reads: a pop-out shows no central's panel or worker card, and the
 * phone app may not see a central at all.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useMcpStore } from '@/stores/mcpStore';
import type { McpActivityRow, McpTaskView } from '@/types';

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

const task = (over: Partial<McpTaskView> = {}): McpTaskView => ({
  taskId: 'T1',
  centralId: 'c1',
  sessionId: 'w1',
  state: 'running',
  title: 'fix the flaky queue test',
  createdAt: 1_000,
  sentAt: 1_100,
  updatedAt: 2_000,
  error: null,
  answerChars: null,
  ...over,
});

const row = (over: Partial<McpActivityRow> = {}): McpActivityRow => ({
  id: 1,
  at: 1_700_000_000_000,
  centralId: 'c1',
  centralSessionId: null,
  tool: 'prompt_send',
  risk: 'steers',
  targetSessionId: 'w1',
  taskId: null,
  summary: 'Sent a prompt to 1 session',
  outcome: 'ok',
  detail: null,
  ...over,
});

const send = (msg: Record<string, unknown>) => act(() => { ws.onMessage?.(msg); });
const status = (value: string) => act(() => { ws.onStatus?.(value); });

describe('useWebSocket — what a central does', () => {
  const real = { load: useMcpStore.getState().load, loadTasks: useMcpStore.getState().loadTasks };
  let load: ReturnType<typeof vi.fn>;
  let loadTasks: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    load = vi.fn(async () => undefined);
    loadTasks = vi.fn(async () => undefined);
    useMcpStore.setState({
      centrals: new Map(), available: null, passwordEnabled: null, revision: 0,
      tasks: new Map(), activity: [], taskRevision: 0,
      load, loadTasks,
    } as never);
  });

  afterEach(() => {
    useMcpStore.setState({ ...real } as never);
    window.history.pushState({}, '', '/');
    ws.onMessage = null;
    ws.onStatus = null;
    vi.unstubAllGlobals();
  });

  describe('mcp_task_update', () => {
    beforeEach(() => {
      render(<Harness />);
    });

    it('puts the task in the store, by its id', () => {
      send({ type: 'mcp_task_update', task: task() });

      expect(useMcpStore.getState().tasks.get('T1')).toEqual(task());
    });

    it('replaces the task with its next change', () => {
      send({ type: 'mcp_task_update', task: task({ state: 'sent', updatedAt: 1_500 }) });
      send({ type: 'mcp_task_update', task: task({ state: 'blocked', updatedAt: 2_500 }) });

      expect(useMcpStore.getState().tasks.size).toBe(1);
      expect(useMcpStore.getState().tasks.get('T1')?.state).toBe('blocked');
    });

    it('ignores a message with no task, and keeps what it held', () => {
      send({ type: 'mcp_task_update', task: task() });
      send({ type: 'mcp_task_update' });
      send({ type: 'mcp_task_update', task: { taskId: 'broken' } });

      expect([...useMcpStore.getState().tasks.keys()]).toEqual(['T1']);
    });

    it('does not change which centrals the window knows', () => {
      send({ type: 'mcp_task_update', task: task() });

      expect(useMcpStore.getState().centrals.size).toBe(0);
      expect(useMcpStore.getState().available).toBeNull();
    });
  });

  describe('mcp_activity', () => {
    beforeEach(() => {
      render(<Harness />);
    });

    it('puts the row first in the store', () => {
      send({ type: 'mcp_activity', row: row({ id: 1 }) });
      send({ type: 'mcp_activity', row: row({ id: 2, outcome: 'refused', summary: 'Refused: that session is hands-off' }) });

      expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([2, 1]);
      expect(useMcpStore.getState().activity[0].outcome).toBe('refused');
    });

    it('holds a row once, whichever way it came', () => {
      send({ type: 'mcp_activity', row: row({ id: 3 }) });
      send({ type: 'mcp_activity', row: row({ id: 3 }) });

      expect(useMcpStore.getState().activity).toHaveLength(1);
    });

    it('ignores a message with no row, and keeps what it held', () => {
      send({ type: 'mcp_activity', row: row({ id: 1 }) });
      send({ type: 'mcp_activity' });
      send({ type: 'mcp_activity', row: { id: 2 } });

      expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([1]);
    });

    it('keeps no token a bad server sent along with a row', () => {
      send({ type: 'mcp_activity', row: { ...row(), token: 'aasc_mcp_SECRET' } });

      expect(JSON.stringify(useMcpStore.getState().activity)).not.toContain('SECRET');
    });
  });

  // The same rule as for the list: a pop-out shows no worker badge and no ACTIVITY tab, so it is given no task and no
  // row. It would otherwise hold tasks it never reads (it never calls loadTasks, so they could not even be told to
  // have ended), and a badge would show there if anything ever stopped gating on them.
  describe('in a pop-out window', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/?popout=session');
      render(<Harness />);
    });

    it('keeps no task the feed sends (a pop-out shows no worker badge)', () => {
      send({ type: 'mcp_task_update', task: task() });

      expect(useMcpStore.getState().tasks.size).toBe(0);
      expect(useMcpStore.getState().taskRevision).toBe(0);
    });

    it('keeps no row the feed sends (a pop-out shows no ACTIVITY tab)', () => {
      send({ type: 'mcp_activity', row: row() });

      expect(useMcpStore.getState().activity).toHaveLength(0);
    });
  });

  // The Electron desktop window is the dashboard window (it has no `AASC-Mobile/` token in its user agent, which is
  // what marks the phone shell), so it follows the feed.
  describe('in the Electron desktop window', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', {
        ...navigator,
        userAgent:
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AASC/2.10.57 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36',
      });
      render(<Harness />);
    });

    it('keeps the task and the row the feed sends', () => {
      send({ type: 'mcp_task_update', task: task() });
      send({ type: 'mcp_activity', row: row() });

      expect(useMcpStore.getState().tasks.get('T1')).toEqual(task());
      expect(useMcpStore.getState().activity.map((r) => r.id)).toEqual([1]);
    });

    it('reads the tasks when the socket connects', () => {
      status('connected');

      expect(loadTasks).toHaveBeenCalledTimes(1);
    });
  });

  describe('reading the tasks when the socket connects', () => {
    it('reads them in the dashboard window', () => {
      render(<Harness />);

      status('connected');

      expect(loadTasks).toHaveBeenCalledTimes(1);
    });

    it('reads them again at every reconnect, since nothing sent while the socket was down is replayed', () => {
      render(<Harness />);

      status('connected');
      status('reconnecting');
      status('connected');

      expect(loadTasks).toHaveBeenCalledTimes(2);
    });

    it('reads the centrals too, as before', () => {
      render(<Harness />);

      status('connected');

      expect(load).toHaveBeenCalledTimes(1);
    });

    it('does not read them while the socket is down or still reconnecting', () => {
      render(<Harness />);

      status('reconnecting');
      status('disconnected');

      expect(loadTasks).not.toHaveBeenCalled();
    });

    it('does not read them in a pop-out window', () => {
      window.history.pushState({}, '', '/?popout=queue');
      render(<Harness />);

      status('connected');

      expect(loadTasks).not.toHaveBeenCalled();
    });

    it('does not read them in the phone app, which may not see a central', () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)' });
      render(<Harness />);

      status('connected');

      expect(loadTasks).not.toHaveBeenCalled();
    });
  });
});
