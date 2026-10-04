/**
 * Every pop-out window (`?popout=…`) connects through the same `useWebSocket(null)` as the dashboard, so
 * every side effect in that hook runs in every window. Two of them do real damage when run twice:
 *
 *  - pinned auto-respawn. A pinned session whose process dies is relaunched by `onSessionEnded`. Two
 *    windows each schedule it, the server's duplicate check ignores ended sessions, and two terminals
 *    come up resuming one conversation;
 *  - the room list. Rooms live in each window's localStorage copy and are only ever read at boot. A
 *    pop-out that has been open for an hour holds an hour-old copy, and migrating it on a re-key writes
 *    that copy back over every room edit the main window made since.
 *
 * So the main window owns both. Each case runs the same message through a dashboard and a pop-out, so
 * the URL is the only thing that differs.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { onSessionEnded } from '@/lib/pinnedRespawn';
import type { Session, ServerMessage } from '@/types';

const ws = vi.hoisted(() => ({ onMessage: null as ((msg: unknown) => void) | null }));

vi.mock('@/lib/wsClient', () => ({
  WsClient: class {
    constructor(opts: { onMessage: (msg: unknown) => void }) { ws.onMessage = opts.onMessage; }
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

function Harness() {
  useWebSocket(null);
  return null;
}

const ROOMS = [{ id: 'r1', name: 'Room', sessionIds: ['old-id'], collapsed: false, createdAt: 1 }];
const send = (msg: Partial<ServerMessage> & Record<string, unknown>) => act(() => { ws.onMessage?.(msg); });
const session = (over: Partial<Session>): Session => ({ projectName: 'p', title: 't', status: 'idle', ...over }) as Session;

function mount(search: string) {
  window.history.pushState({}, '', `/${search}`);
  render(<Harness />);
}

describe('useWebSocket — what only the main window may do', () => {
  beforeEach(() => {
    vi.mocked(onSessionEnded).mockClear();
    localStorage.setItem('session-rooms', JSON.stringify(ROOMS));
    useRoomStore.setState({ rooms: ROOMS.map((r) => ({ ...r, sessionIds: [...r.sessionIds] })) });
    useSessionStore.setState({
      sessions: new Map([['pin-1', session({ sessionId: 'pin-1', status: 'working', pinned: true })]]),
      selectedSessionId: null,
    });
  });

  afterEach(() => {
    window.history.pushState({}, '', '/');
    ws.onMessage = null;
  });

  describe('pinned auto-respawn', () => {
    const died = () => send({ type: 'session_update', session: session({ sessionId: 'pin-1', status: 'ended', pinned: true }) });

    it('is scheduled by the dashboard when a pinned session dies', () => {
      mount('');
      died();
      expect(onSessionEnded).toHaveBeenCalledTimes(1);
    });

    it.each(['queue', 'session', 'project', 'terminal', 'a-kind-from-a-newer-build'])(
      'is left to the main window in a %s pop-out',
      (kind) => {
        mount(`?popout=${kind}&sessionId=pin-1`);
        died();
        expect(onSessionEnded).not.toHaveBeenCalled();
      },
    );
  });

  describe('the room list on a re-key', () => {
    const rekeyed = () =>
      send({ type: 'session_update', session: session({ sessionId: 'new-id', replacesId: 'old-id' }) });
    const stored = () => JSON.parse(localStorage.getItem('session-rooms') ?? '[]') as typeof ROOMS;

    it('is migrated and saved by the dashboard', () => {
      mount('');
      rekeyed();
      expect(useRoomStore.getState().rooms[0].sessionIds).toEqual(['new-id']);
      expect(stored()[0].sessionIds).toEqual(['new-id']);
    });

    it('is not written back by a pop-out, whose copy may be hours stale', () => {
      // Another window edited the rooms since this one loaded them.
      const edited = [{ ...ROOMS[0], name: 'Renamed in main', sessionIds: ['old-id', 'added-in-main'] }];
      localStorage.setItem('session-rooms', JSON.stringify(edited));

      mount('?popout=queue&sessionId=old-id');
      rekeyed();

      expect(stored()).toEqual(edited);
    });
  });

  it('still migrates this window’s own queue and selection on a re-key, in a pop-out too', () => {
    // These are in-memory, per window, and the window needs them to keep showing its session.
    mount('?popout=queue&sessionId=old-id');
    useSessionStore.setState({
      sessions: new Map([['old-id', session({ sessionId: 'old-id' })]]),
      selectedSessionId: 'old-id',
    });
    send({ type: 'session_update', session: session({ sessionId: 'new-id', replacesId: 'old-id' }) });
    expect(useSessionStore.getState().selectedSessionId).toBe('new-id');
  });
});
