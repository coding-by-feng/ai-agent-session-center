/**
 * The confirm feed and the skill-note op reach their handlers through `useWebSocket`: `mcp_confirm` and
 * `mcp_confirm_resolved` go to `mcpConfirmStore` in the dashboard window only (a pop-out never shows a card), the
 * pending list is read each time the socket connects, and `skill_note_op` and `keep_awake_op` go to their op handlers
 * (which themselves apply them only in the room writer's window).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useMcpConfirmStore } from '@/stores/mcpConfirmStore';
import { useMcpStore } from '@/stores/mcpStore';
import type { McpConfirmView } from '@/types/mcpConfirm';

const ws = vi.hoisted(() => ({
  onMessage: null as ((msg: unknown) => void) | null,
  onStatus: null as ((status: string) => void) | null,
}));
const skillNoteOp = vi.hoisted(() => ({ handle: vi.fn(async () => undefined), keepAwake: vi.fn(async () => undefined) }));

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
vi.mock('@/lib/roomSync', () => ({
  receiveRooms: vi.fn(),
  handleRoomOpMessage: vi.fn(),
  onRoomsSocketConnected: vi.fn(),
}));
vi.mock('@/lib/skillNoteOps', () => ({ handleSkillNoteOpMessage: skillNoteOp.handle, handleKeepAwakeOpMessage: skillNoteOp.keepAwake }));

function Harness() {
  useWebSocket(null);
  return null;
}

const FUTURE = Date.now() + 600_000;

const view = (over: Partial<McpConfirmView> = {}): McpConfirmView => ({
  cardId: 'card-1',
  centralId: 'c1',
  tool: 'session_kill',
  risk: 'ask',
  summary: 'Close the session "api"',
  detail: null,
  targetSessionId: null,
  createdAt: Date.now(),
  expiresAt: FUTURE,
  ...over,
});

const send = (msg: Record<string, unknown>) => act(() => { ws.onMessage?.(msg); });
const status = (value: string) => act(() => { ws.onStatus?.(value); });

describe('useWebSocket — confirmations and skill-note ops', () => {
  const real = {
    load: useMcpConfirmStore.getState().load,
    mcpLoad: useMcpStore.getState().load,
    mcpLoadTasks: useMcpStore.getState().loadTasks,
  };
  let load: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    load = vi.fn(async () => undefined);
    useMcpConfirmStore.setState({ confirms: [], load } as never);
    useMcpStore.setState({ load: vi.fn(async () => undefined), loadTasks: vi.fn(async () => undefined) } as never);
    skillNoteOp.handle.mockClear();
  });

  afterEach(() => {
    useMcpConfirmStore.setState({ load: real.load } as never);
    useMcpStore.setState({ load: real.mcpLoad, loadTasks: real.mcpLoadTasks } as never);
    window.history.pushState({}, '', '/');
    ws.onMessage = null;
    ws.onStatus = null;
  });

  describe('in the dashboard window', () => {
    beforeEach(() => {
      render(<Harness />);
    });

    it('mcp_confirm puts the card in the store', () => {
      send({ type: 'mcp_confirm', confirm: view() });
      expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });

    it('mcp_confirm_resolved takes it out', () => {
      send({ type: 'mcp_confirm', confirm: view() });
      send({ type: 'mcp_confirm_resolved', cardId: 'card-1', state: 'allowed' });
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
    });

    it('a malformed mcp_confirm is ignored and keeps what was held', () => {
      send({ type: 'mcp_confirm', confirm: view() });
      send({ type: 'mcp_confirm' });
      send({ type: 'mcp_confirm', confirm: { cardId: 'broken' } });
      expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });

    it('reads the pending list when the socket connects', () => {
      status('connected');
      expect(load).toHaveBeenCalledTimes(1);
      status('disconnected');
      expect(load).toHaveBeenCalledTimes(1);
    });

    it('skill_note_op goes to the skill-note op handler', () => {
      const msg = { type: 'skill_note_op', opId: 'op-1', key: 'claude:tdd', set: { fav: true } };
      send(msg);
      expect(skillNoteOp.handle).toHaveBeenCalledWith(msg);
    });

    it('keep_awake_op goes to the keep-awake op handler', () => {
      const msg = { type: 'keep_awake_op', opId: 'op-2', on: true };
      send(msg);
      expect(skillNoteOp.keepAwake).toHaveBeenCalledWith(msg);
      expect(skillNoteOp.handle).not.toHaveBeenCalledWith(msg);
    });
  });

  describe('in a pop-out window', () => {
    beforeEach(() => {
      window.history.pushState({}, '', '/?popout=session');
      render(<Harness />);
    });

    it('keeps no card the feed sends and reads no list', () => {
      send({ type: 'mcp_confirm', confirm: view() });
      status('connected');
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
      expect(load).not.toHaveBeenCalled();
    });
  });
});
