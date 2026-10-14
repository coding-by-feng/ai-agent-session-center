/**
 * @module sessionRefresh
 * Ask for the session list again: the phone's pull to refresh on LIVE (AASC-18).
 *
 * Two things, because a phone usually pulls when the list looks stuck:
 *  - a socket that dropped (the phone slept, the network changed) reconnects
 *    now rather than at the next back-off step; a live one is left alone, so a
 *    refresh never costs the terminal subscriptions or a held control baton;
 *  - the list is fetched over HTTP (GET /api/sessions, already filtered for a
 *    remote device) and replaces the store's, exactly as a snapshot does.
 */
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import type { Session } from '@/types';

function isSessionLike(value: unknown): value is Session {
  return !!value && typeof value === 'object' && !Array.isArray(value)
    && typeof (value as Session).status === 'string';
}

/**
 * The reply as a session list: one entry per session id, keeping the most
 * recently active copy, as the WebSocket snapshot handler does (useWebSocket,
 * "Fix 6"). Null when the reply is not a record of sessions (an error body, an
 * array): the list on screen is kept rather than replaced with a wrong one.
 */
export function dedupeSessionRecord(record: unknown): Map<string, Session> | null {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return null;
  const entries = Object.entries(record as Record<string, unknown>);
  if (!entries.every(([, value]) => isSessionLike(value))) return null;
  const deduped = new Map<string, Session>();
  for (const [id, value] of entries) {
    const session = value as Session;
    const sid = typeof session.sessionId === 'string' && session.sessionId ? session.sessionId : id;
    const existing = deduped.get(sid);
    if (!existing || (session.lastActivityAt || 0) > (existing.lastActivityAt || 0)) {
      deduped.set(sid, session);
    }
  }
  return deduped;
}

/** Re-request the session list. Resolves to whether the list was refreshed; never throws. */
export async function refreshSessionList(): Promise<boolean> {
  const ws = useWsStore.getState();
  if (!ws.connected) ws.client?.reconnectNow();
  try {
    const res = await fetch('/api/sessions', { cache: 'no-store' });
    if (!res.ok) return false;
    const sessions = dedupeSessionRecord(await res.json());
    if (!sessions) return false;
    useSessionStore.getState().setSessions(sessions);
    // The list is now the server's, as after a snapshot (see wsStore.snapshotReceived).
    if (!useWsStore.getState().snapshotReceived) useWsStore.getState().setSnapshotReceived(true);
    return true;
  } catch {
    return false;
  }
}
