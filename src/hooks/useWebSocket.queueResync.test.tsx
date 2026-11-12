/**
 * A `queue_update` broadcast while this window's socket was down (phone locked or backgrounded, Mac asleep,
 * network blip, server restart) is never replayed. Boot pulls every queue once (`main.tsx` → `syncFromServer`),
 * so without a re-pull on RECONNECT a client keeps a stale queue until it reloads. The first connect does not
 * pull: boot already did, and the boot pull is the one that seeds.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useQueueStore } from '@/stores/queueStore';

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

function Harness() {
  useWebSocket(null);
  return null;
}

const status = (value: string) => act(() => { ws.onStatus?.(value); });

describe('useWebSocket — queues re-pulled on reconnect', () => {
  const realSync = useQueueStore.getState().syncFromServer;
  let syncFromServer: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // The centrals/confirm reads on connect are other files' business: never over a real network here.
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    syncFromServer = vi.fn(async () => undefined);
    useQueueStore.setState({ syncFromServer } as never);
    render(<Harness />);
  });

  afterEach(() => {
    useQueueStore.setState({ syncFromServer: realSync } as never);
    ws.onMessage = null;
    ws.onStatus = null;
    vi.unstubAllGlobals();
  });

  it('does not pull on the first connect (boot already did, and seeded)', () => {
    status('connected');
    expect(syncFromServer).not.toHaveBeenCalled();
  });

  it('pulls every queue, without seeding, each time the socket comes back', () => {
    status('connected');
    status('disconnected');
    status('reconnecting');
    status('connected');
    expect(syncFromServer).toHaveBeenCalledTimes(1);
    expect(syncFromServer).toHaveBeenCalledWith({ seed: false });

    status('disconnected');
    status('connected');
    expect(syncFromServer).toHaveBeenCalledTimes(2);
  });

  it('ignores a repeated "connected" with no drop in between', () => {
    status('connected');
    status('connected');
    expect(syncFromServer).not.toHaveBeenCalled();
  });
});

describe('useWebSocket — an item added while the socket was down appears after reconnect', () => {
  afterEach(() => {
    ws.onMessage = null;
    ws.onStatus = null;
    vi.unstubAllGlobals();
    useQueueStore.setState({ queues: new Map() } as never);
  });

  it('shows the other device\'s new prompt once the socket is back', async () => {
    const serverQueues = { queues: [] as unknown[] };
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      url === '/api/queues'
        ? new Response(JSON.stringify(serverQueues), { status: 200 })
        : new Response('{}', { status: 404 })));
    render(<Harness />);
    status('connected');
    status('disconnected');

    // Another device adds a prompt; its queue_update is broadcast while this socket is down, so it is lost.
    serverQueues.queues = [{
      sessionId: 's1',
      items: [{ id: 1, sessionId: 's1', text: 'added on the phone', position: 0, createdAt: 1 }],
      automation: null,
      updatedAt: 1,
    }];

    await act(async () => {
      ws.onStatus?.('connected');
      await new Promise((r) => setTimeout(r, 0));
    });

    expect(useQueueStore.getState().queues.get('s1')?.map((i) => i.text)).toEqual(['added on the phone']);
  });
});
