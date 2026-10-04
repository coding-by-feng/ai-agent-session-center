/**
 * The first `snapshot` is what tells the UI "the session list has loaded". Before it, an empty session map means
 * "not loaded yet", not "no sessions", and the LIVE page must not say "No agent sessions yet" to a returning user
 * whose sessions are a few milliseconds away. `wsStore.snapshotReceived` carries that, set here and only here.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';

import { useWebSocket } from './useWebSocket';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { Session } from '@/types';

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

const send = (msg: Record<string, unknown>) => act(() => { ws.onMessage?.(msg); });
const session = (id: string): Session => ({ sessionId: id, projectName: 'p', title: id, status: 'idle' }) as Session;

describe('useWebSocket — the first snapshot marks the session list as loaded', () => {
  beforeEach(() => {
    useWsStore.setState({ snapshotReceived: false });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    render(<Harness />);
  });

  afterEach(() => {
    ws.onMessage = null;
  });

  it('is not loaded before any snapshot', () => {
    expect(useWsStore.getState().snapshotReceived).toBe(false);
  });

  it('is loaded once a snapshot arrives, even an empty one (a real "no sessions")', () => {
    send({ type: 'snapshot', sessions: {}, teams: {}, seq: 1 });
    expect(useWsStore.getState().snapshotReceived).toBe(true);
    expect(useSessionStore.getState().sessions.size).toBe(0);
  });

  it('is loaded along with the sessions the snapshot carries', () => {
    send({ type: 'snapshot', sessions: { a: session('a') }, teams: {}, seq: 2 });
    expect(useWsStore.getState().snapshotReceived).toBe(true);
    expect(useSessionStore.getState().sessions.has('a')).toBe(true);
  });

  it('keeps the count of sessions hidden from this device, and 0 when the server sends none', () => {
    send({ type: 'snapshot', sessions: {}, teams: {}, seq: 3, hiddenCount: 4 });
    expect(useWsStore.getState().hiddenCount).toBe(4);
    send({ type: 'snapshot', sessions: {}, teams: {}, seq: 4 });
    expect(useWsStore.getState().hiddenCount).toBe(0);
  });

  it('is not set by a single session update, which is not the whole list', () => {
    send({ type: 'session_update', session: session('b') });
    expect(useWsStore.getState().snapshotReceived).toBe(false);
  });
});
