// sessionRefresh.test.ts — the phone's pull to refresh (AASC-18): re-request the
// session list, reconnect a dropped socket, and never replace the list with junk.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { Session } from '@/types';
import { dedupeSessionRecord, refreshSessionList } from './sessionRefresh';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { WsClient } from '@/lib/wsClient';

const s = (id: string, over: Partial<Session> = {}): Session =>
  ({ sessionId: id, title: id, status: 'idle', lastActivityAt: 1, ...over }) as unknown as Session;

beforeEach(() => {
  useSessionStore.setState({ sessions: new Map([['old', s('old')]]) });
  useWsStore.setState({ connected: true, client: null, snapshotReceived: true });
});
afterEach(() => vi.unstubAllGlobals());

describe('dedupeSessionRecord', () => {
  it('keeps the most recently active copy of a session', () => {
    const map = dedupeSessionRecord({ k1: s('a', { lastActivityAt: 1, title: 'old' }), k2: s('a', { lastActivityAt: 5, title: 'new' }) });
    expect(map?.get('a')?.title).toBe('new');
    expect(map?.size).toBe(1);
  });

  it('refuses a reply that is not a record of sessions', () => {
    expect(dedupeSessionRecord({ ok: true, data: [] })).toBeNull();
    expect(dedupeSessionRecord([s('a')])).toBeNull();
    expect(dedupeSessionRecord(null)).toBeNull();
    expect(dedupeSessionRecord({})?.size).toBe(0);
  });
});

describe('refreshSessionList', () => {
  it('replaces the list with the server one', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ a: s('a') }) }) as Response);
    vi.stubGlobal('fetch', fetchMock);
    await expect(refreshSessionList()).resolves.toBe(true);
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions', expect.anything());
    expect([...useSessionStore.getState().sessions.keys()]).toEqual(['a']);
  });

  it('keeps the list on an error reply', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, json: async () => ({}) }) as Response));
    await expect(refreshSessionList()).resolves.toBe(false);
    expect([...useSessionStore.getState().sessions.keys()]).toEqual(['old']);
  });

  it('reconnects a dropped socket now, and leaves a live one alone', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => ({}) }) as Response));
    const reconnectNow = vi.fn();
    useWsStore.setState({ client: { reconnectNow } as unknown as WsClient, connected: true });
    await refreshSessionList();
    expect(reconnectNow).not.toHaveBeenCalled();
    useWsStore.setState({ connected: false });
    await refreshSessionList();
    expect(reconnectNow).toHaveBeenCalledTimes(1);
  });
});
