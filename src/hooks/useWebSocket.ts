import { useEffect, useRef } from 'react';
import { WsClient } from '@/lib/wsClient';
import { useSessionStore } from '@/stores/sessionStore';
import { useWsStore } from '@/stores/wsStore';
import { db, migrateSessionId, persistSessionUpdate } from '@/lib/db';
import type { Session, ServerMessage } from '@/types';
import { handleEventSounds, checkAlarms } from '@/lib/alarmEngine';

export function useWebSocket(token: string | null): WsClient | null {
  const clientRef = useRef<WsClient | null>(null);

  useEffect(() => {
    const { addSession, updateSession, removeSession, setSessions } =
      useSessionStore.getState();
    const { setConnected, setReconnecting, setLastSeq } = useWsStore.getState();

    function handleMessage(msg: ServerMessage): void {
      switch (msg.type) {
        case 'snapshot': {
          // Fix 6: deduplicate by sessionId, keep most recent lastActivityAt
          const deduped = new Map<string, Session>();
          for (const [id, session] of Object.entries(msg.sessions)) {
            const sid = session.sessionId || id;
            const existing = deduped.get(sid);
            if (
              !existing ||
              (session.lastActivityAt || 0) > (existing.lastActivityAt || 0)
            ) {
              deduped.set(sid, session);
            }
          }
          setSessions(deduped);
          setLastSeq(msg.seq);

          // Persist all sessions to IndexedDB
          for (const session of deduped.values()) {
            persistSessionUpdate(session).catch(() => {});
          }

          // #39: Reconcile IndexedDB — delete sessions not in snapshot
          db.sessions.toCollection().primaryKeys().then((keys) => {
            const snapshotIds = new Set(deduped.keys());
            const staleKeys = keys.filter((k) => !snapshotIds.has(String(k)));
            if (staleKeys.length > 0) {
              db.sessions.bulkDelete(staleKeys).catch(() => {});
            }
          }).catch(() => {});
          break;
        }

        case 'session_update': {
          const { session } = msg;

          // Fix 6: handle replacesId migration in IndexedDB
          // Note: do NOT call removeSession() here — updateSession() handles
          // the re-key atomically (deletes old key + adds new key + follows
          // selectedSessionId). Calling removeSession() first would clear
          // selectedSessionId before updateSession can follow it.
          if (session.replacesId) {
            migrateSessionId(session.replacesId, session.sessionId)
              .then(() => db.sessions.delete(session.replacesId!))
              .catch(() => {});
          }

          updateSession(session);
          persistSessionUpdate(session).catch(() => {});

          // Sound system: play event sounds and manage alarms
          handleEventSounds(session);
          checkAlarms(session, () => useSessionStore.getState().sessions);
          break;
        }

        case 'session_removed': {
          removeSession(msg.sessionId);
          break;
        }

        case 'clearBrowserDb': {
          db.delete().then(() => db.open()).catch(() => {});
          break;
        }

        // Terminal and stats messages are handled by other hooks/components
        case 'team_update':
        case 'hook_stats':
        case 'terminal_output':
        case 'terminal_ready':
        case 'terminal_closed':
          break;
      }
    }

    function handleStatus(status: 'connected' | 'disconnected' | 'reconnecting'): void {
      setConnected(status === 'connected');
      setReconnecting(status === 'reconnecting');
    }

    const { setClient } = useWsStore.getState();

    const client = new WsClient({
      url: '/ws',
      token,
      onMessage: handleMessage,
      onStatus: handleStatus,
    });

    clientRef.current = client;
    setClient(client);
    client.connect();

    return () => {
      client.dispose();
      clientRef.current = null;
      setClient(null);
    };
  }, [token]);

  return clientRef.current;
}
