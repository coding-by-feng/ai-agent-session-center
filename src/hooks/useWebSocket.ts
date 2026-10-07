import { useEffect, useRef } from 'react';
import { WsClient } from '@/lib/wsClient';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';
import type { QueueItem, QueueAutomationConfig } from '@/stores/queueStore';
import { useRoomStore } from '@/stores/roomStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useWsStore } from '@/stores/wsStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { getClientId } from '@/lib/deviceIdentity';
import { isPopoutWindow } from '@/lib/windowRole';
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
    const { setConnected, setReconnecting, setLastSeq, setSnapshotReceived, setHiddenCount } = useWsStore.getState();
    // Every pop-out (`?popout=…`) connects through this same hook, so whatever it
    // does, every window does. Two things must happen once, in the main window:
    // relaunching a pinned session that died (two windows = two terminals resuming
    // one conversation) and migrating the room list on a re-key (a pop-out's copy
    // was read at boot and may be hours stale, and the migration writes it back
    // over the main window's edits). Sounds and alarms still run in each window.
    const popout = isPopoutWindow();

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
          // The session map is now the real list (see wsStore.snapshotReceived),
          // minus what is not shared with this device (wsStore.hiddenCount).
          setSnapshotReceived(true);
          setHiddenCount(typeof msg.hiddenCount === 'number' ? msg.hiddenCount : 0);

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
            if (!popout) {
              useRoomStore.getState().migrateSession(session.replacesId, session.sessionId);
            }
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
          // (its process died / connection lost), relaunch it if it's still pinned.
          // A deliberate kill is already unpinned server-side, so it never gets
          // here as pinned. onSessionEnded is a no-op otherwise. Not in a pop-out:
          // the main window owns respawning (see `popout` above).
          if (!popout && session.status === 'ended' && prevStatus && prevStatus !== 'ended') {
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

        case 'presence_update': {
          usePresenceStore.getState().applyPresence(msg);
          break;
        }

        case 'control_denied': {
          // A write was dropped because another device holds this session. The
          // server throttles these (terminal_input fires per keystroke), so
          // this is a notice to explain the silence, not a per-key event.
          usePresenceStore.getState().setDenial({
            sessionId: msg.sessionId,
            by: msg.by,
            at: Date.now(),
          });
          break;
        }

        case 'control_requested': {
          // Broadcast to everyone; only the addressed holder should react.
          if (msg.toClientId === getClientId()) {
            usePresenceStore.getState().addRequest({
              sessionId: msg.sessionId,
              fromClientId: msg.fromClientId,
              fromLabel: msg.fromLabel,
              at: Date.now(),
            });
          }
          break;
        }

        // Another device — or another window of this one — changed this
        // session's shared queue. Applying it here (rather than re-fetching) is
        // what makes the phone, the desktop and a floated queue agree live
        // instead of only after a reload. `originClientId` is the sender's
        // WINDOW origin id, not its device id: only this window's own echo is
        // dropped (see `queueStore.applyRemoteQueue`).
        case 'queue_update': {
          const m = msg as unknown as {
            sessionId?: string;
            items?: unknown;
            automation?: unknown;
            originClientId?: string | null;
          };
          if (typeof m.sessionId === 'string' && Array.isArray(m.items)) {
            useQueueStore.getState().applyRemoteQueue(
              m.sessionId,
              m.items as QueueItem[],
              (m.automation ?? null) as QueueAutomationConfig | null,
              m.originClientId ?? null,
            );
          }
          break;
        }

        // Terminal and stats messages are handled by other hooks/components
        case 'team_update':
        case 'hook_stats':
        case 'terminal_output':
        case 'terminal_ready':
        case 'terminal_closed':
        case 'terminal_cleared':
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
