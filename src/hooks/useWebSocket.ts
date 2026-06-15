import { useEffect, useRef } from 'react';
import { WsClient } from '@/lib/wsClient';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';
import { useRoomStore } from '@/stores/roomStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useWsStore } from '@/stores/wsStore';
import { db, migrateSessionId, persistSessionUpdate, deleteSessionChildrenBatch } from '@/lib/db';
import { isImportInProgress } from '@/lib/workspaceSnapshot';
import { onSessionEnded } from '@/lib/pinnedRespawn';
import { migrateOriginSessionId } from '@/lib/translationLog';
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

          // Close floating popups whose origin session vanished from the snapshot
          // (server pruned it while we were disconnected) — they could never
          // render again and their PTYs would leak. Skip during a workspace
          // restore: floats are being re-opened then and the in-flight session
          // set is intentionally partial.
          if (!isImportInProgress()) {
            useFloatingSessionsStore.getState().closeOrphans(new Set(deduped.keys()));
          }

          // Persist all sessions to IndexedDB
          for (const session of deduped.values()) {
            persistSessionUpdate(session).catch(() => {});
          }

          // #39: Reconcile IndexedDB — delete sessions not in snapshot, AND
          // cascade their child rows (prompts/responses/toolCalls/events/notes/
          // promptQueue/alerts/queueAutomation). Pruning only db.sessions left
          // orphan child rows that accumulated one generation per restart and
          // re-hydrated as zombie "Unknown" queue groups; it also strands rows
          // under a session that was re-keyed while we were disconnected (the
          // snapshot carries only the new id and the server already dropped the
          // replacesId mapping, so those old-id rows can never be migrated —
          // cleaning them is the only correct outcome).
          db.sessions.toCollection().primaryKeys().then((keys) => {
            const snapshotIds = new Set(deduped.keys());
            const staleKeys = keys.filter((k) => !snapshotIds.has(String(k)));
            if (staleKeys.length > 0) {
              db.sessions.bulkDelete(staleKeys).catch(() => {});
              deleteSessionChildrenBatch(staleKeys.map((k) => String(k))).catch(() => {});
            }
          }).catch(() => {});
          break;
        }

        case 'session_update': {
          const { session } = msg;

          // Capture the prior status BEFORE updateSession so we can detect a
          // fresh transition into 'ended' (for pinned auto-respawn).
          const prevStatus = useSessionStore.getState().sessions.get(session.sessionId)?.status;

          // Fix 6: handle replacesId migration in IndexedDB
          // Note: do NOT call removeSession() here — updateSession() handles
          // the re-key atomically (deletes old key + adds new key + follows
          // selectedSessionId). Calling removeSession() first would clear
          // selectedSessionId before updateSession can follow it.
          if (session.replacesId) {
            // Migrate queue items in Zustand store (synchronous, before updateSession
            // changes the selectedSessionId so QueueTab reads with the new ID)
            useQueueStore.getState().migrateSession(session.replacesId, session.sessionId);
            useRoomStore.getState().migrateSession(session.replacesId, session.sessionId);
            // Keep floating popups attached to the surviving session id, else
            // they'd render only under the dead origin id (i.e. never).
            useFloatingSessionsStore
              .getState()
              .migrateOriginSession(session.replacesId, session.sessionId);
            // Re-point persisted AI-popup/REVIEW rows too, so AiPopupHistory
            // (which lists by originSessionId) doesn't go empty for the resumed
            // session after a re-key.
            migrateOriginSessionId(session.replacesId, session.sessionId).catch(() => {});

            migrateSessionId(session.replacesId, session.sessionId)
              .then(() => db.sessions.delete(session.replacesId!))
              .catch(() => {});
          }

          updateSession(session);
          persistSessionUpdate(session).catch(() => {});

          // Pinned auto-respawn: when a session FRESHLY transitions to 'ended'
          // (its process died / connection lost), relaunch it if it's pinned and
          // wasn't deliberately closed. onSessionEnded is a no-op otherwise.
          if (session.status === 'ended' && prevStatus && prevStatus !== 'ended') {
            onSessionEnded(session);
          }

          // Sound system: play event sounds and manage alarms
          handleEventSounds(session);
          checkAlarms(session, () => useSessionStore.getState().sessions);
          break;
        }

        case 'session_removed': {
          // A removed session's floating popups can no longer be reached (they
          // only render under their origin session). Close them first so their
          // PTYs don't leak server-side as invisible orphans.
          useFloatingSessionsStore.getState().closeByOriginSession(msg.sessionId);
          removeSession(msg.sessionId);
          break;
        }

        case 'clearBrowserDb': {
          // Everything is being wiped — close floating popups too so their PTYs
          // don't leak as invisible orphans (their origins are about to vanish).
          useFloatingSessionsStore.getState().closeAll();
          // Wipe in-memory Zustand sessions too, otherwise autoSave can
          // re-publish the just-killed sessions back into the snapshot.
          setSessions(new Map());
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
