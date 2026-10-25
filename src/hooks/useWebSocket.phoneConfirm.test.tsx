/**
 * The phone's confirmation feed reaches its store through `useWebSocket` (AASC P5-15): `mcp_phone_confirm` and
 * `mcp_phone_confirm_resolved` go to `phoneConfirmStore` in the phone app only, and the pending list is read each time
 * the socket connects there. The dashboard window and a pop-out follow the Mac's own feed instead and ignore both.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useMcpConfirmStore } from '@/stores/mcpConfirmStore';
import { usePhoneConfirmStore } from '@/stores/phoneConfirmStore';
import { useMcpStore } from '@/stores/mcpStore';
import type { McpConfirmView } from '@/types/mcpConfirm';

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
vi.mock('@/lib/roomSync', () => ({
  receiveRooms: vi.fn(),
  handleRoomOpMessage: vi.fn(),
  onRoomsSocketConnected: vi.fn(),
}));
vi.mock('@/lib/skillNoteOps', () => ({
  handleSkillNoteOpMessage: vi.fn(async () => undefined),
  handleKeepAwakeOpMessage: vi.fn(async () => undefined),
}));

function Harness() {
  useWebSocket(null);
  return null;
}

const PHONE_UA = 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)';
const ELECTRON_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) AASC/2.10.57 Chrome/132.0.0.0 Electron/34.0.0 Safari/537.36';

const view = (over: Partial<McpConfirmView> = {}): McpConfirmView => ({
  cardId: 'card-1',
  centralId: 'c1',
  tool: 'session_kill',
  risk: 'ask',
  summary: 'Stop the session "api"',
  detail: null,
  targetSessionId: null,
  createdAt: Date.now(),
  expiresAt: Date.now() + 600_000,
  ...over,
});

const send = (msg: Record<string, unknown>) => act(() => { ws.onMessage?.(msg); });
const status = (value: string) => act(() => { ws.onStatus?.(value); });

describe('useWebSocket — the phone confirmation feed', () => {
  const real = {
    phoneLoad: usePhoneConfirmStore.getState().load,
    macLoad: useMcpConfirmStore.getState().load,
    mcpLoad: useMcpStore.getState().load,
    mcpLoadTasks: useMcpStore.getState().loadTasks,
  };
  let phoneLoad: ReturnType<typeof vi.fn>;
  let macLoad: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    phoneLoad = vi.fn(async () => undefined);
    macLoad = vi.fn(async () => undefined);
    usePhoneConfirmStore.setState({ confirms: [], load: phoneLoad } as never);
    useMcpConfirmStore.setState({ confirms: [], load: macLoad } as never);
    useMcpStore.setState({ load: vi.fn(async () => undefined), loadTasks: vi.fn(async () => undefined) } as never);
  });

  afterEach(() => {
    usePhoneConfirmStore.setState({ load: real.phoneLoad } as never);
    useMcpConfirmStore.setState({ load: real.macLoad } as never);
    useMcpStore.setState({ load: real.mcpLoad, loadTasks: real.mcpLoadTasks } as never);
    vi.unstubAllGlobals();
    window.history.pushState({}, '', '/');
    ws.onMessage = null;
    ws.onStatus = null;
  });

  describe('in the phone app', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: PHONE_UA });
      render(<Harness />);
    });

    it('mcp_phone_confirm puts the card in the phone store only', () => {
      send({ type: 'mcp_phone_confirm', confirm: view() });
      expect(usePhoneConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
      expect(useMcpConfirmStore.getState().confirms).toEqual([]);
    });

    it('mcp_phone_confirm_resolved takes it out', () => {
      send({ type: 'mcp_phone_confirm', confirm: view() });
      send({ type: 'mcp_phone_confirm_resolved', cardId: 'card-1', state: 'allowed' });
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
    });

    it('a malformed mcp_phone_confirm is ignored and keeps what was held', () => {
      send({ type: 'mcp_phone_confirm', confirm: view() });
      send({ type: 'mcp_phone_confirm' });
      send({ type: 'mcp_phone_confirm', confirm: { cardId: 'broken' } });
      expect(usePhoneConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });

    it('reads the pending list when the socket connects, not the Mac one', () => {
      status('connected');
      expect(phoneLoad).toHaveBeenCalledTimes(1);
      expect(macLoad).not.toHaveBeenCalled();
      status('disconnected');
      expect(phoneLoad).toHaveBeenCalledTimes(1);
    });
  });

  describe('in the dashboard window', () => {
    beforeEach(() => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: ELECTRON_UA });
      render(<Harness />);
    });

    it('the desktop window ignores the phone types and reads no phone list', () => {
      send({ type: 'mcp_phone_confirm', confirm: view() });
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
      status('connected');
      expect(phoneLoad).not.toHaveBeenCalled();
      expect(macLoad).toHaveBeenCalledTimes(1);
    });

    it('still follows the Mac feed (followsCentrals unchanged)', () => {
      send({ type: 'mcp_confirm', confirm: view() });
      expect(useMcpConfirmStore.getState().confirms.map((c) => c.cardId)).toEqual(['card-1']);
    });
  });

  describe('in a pop-out window', () => {
    it('ignores the phone types too', () => {
      window.history.pushState({}, '', '/?popout=session');
      render(<Harness />);
      send({ type: 'mcp_phone_confirm', confirm: view() });
      status('connected');
      expect(usePhoneConfirmStore.getState().confirms).toEqual([]);
      expect(phoneLoad).not.toHaveBeenCalled();
    });
  });
});
