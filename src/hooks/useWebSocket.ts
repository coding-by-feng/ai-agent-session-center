import { useEffect, useRef } from 'react';
import { WsClient } from '@/lib/wsClient';
import { useSessionStore } from '@/stores/sessionStore';
import { useQueueStore } from '@/stores/queueStore';
import type { QueueItem, QueueAutomationConfig } from '@/stores/queueStore';
import { useRoomStore } from '@/stores/roomStore';
import { useFloatingSessionsStore } from '@/stores/floatingSessionsStore';
import { useWsStore } from '@/stores/wsStore';
import { usePresenceStore } from '@/stores/presenceStore';
import { useMcpStore } from '@/stores/mcpStore';
import { useMcpConfirmStore } from '@/stores/mcpConfirmStore';
import { usePhoneConfirmStore } from '@/stores/phoneConfirmStore';
import { getClientId } from '@/lib/deviceIdentity';
import { isPopoutWindow } from '@/lib/windowRole';
import { isNativeMobileApp } from '@/lib/platform';
import { db, migrateSessionId, persistSessionUpdate, deleteSessionChildrenBatch } from '@/lib/db';
import { isImportInProgress } from '@/lib/workspaceSnapshot';
import { onSessionEnded } from '@/lib/pinnedRespawn';
import { migrateOriginSessionId } from '@/lib/translationLog';
import type { Session, ServerMessage } from '@/types';
import { handleEventSounds, checkAlarms } from '@/lib/alarmEngine';
import { useQueueSentStore } from '@/stores/queueSentStore';
import { usePromptSnippetStore, type PromptSnippet } from '@/stores/promptSnippetStore';
import { receiveRooms, handleRoomOpMessage, onRoomsSocketConnected } from '@/lib/roomSync';
import { handleKeepAwakeOpMessage, handleSkillNoteOpMessage } from '@/lib/skillNoteOps';

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
    const nativeApp = isNativeMobileApp();
    // Only the dashboard window follows the central sessions (server/mcp): it alone offers the New Session form, the
    // Hands off button, the ACTIVITY tab and the worker badges. A pop-out gets none of them, so it is given none of
    // the lists, tasks or rows either: a `centrals_update` (the server sends it to every window of this Mac) must
    // not make a pop-out `available`, which is what would show the first three there. The phone app may not see a
    // central at all.
    const followsCentrals = !popout && !nativeApp;

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
          // Nor in the phone app: respawning belongs to the desktop (AASC-17).
          if (!popout && !nativeApp && session.status === 'ended' && prevStatus && prevStatus !== 'ended') {
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

        // The Mac's queue sent a prompt (AASC-20): the CONVERSATION badge record.
        // Only sessions this device may see are sent here (broadcastSubject).
        case 'queue_sent': {
          const m = msg as unknown as { sessionId?: string; text?: string; sentAt?: number };
          if (typeof m.sessionId === 'string' && typeof m.text === 'string' && typeof m.sentAt === 'number') {
            useQueueSentStore.getState().add(m.sessionId, { text: m.text, sentAt: m.sentAt });
          }
          break;
        }

        // The saved-prompt library changed on the Mac (AASC-20): the whole list,
        // kept only if its revision is newer than the one held.
        case 'snippets_update': {
          const m = msg as unknown as { revision?: number; snippets?: unknown };
          if (typeof m.revision === 'number' && Array.isArray(m.snippets)) {
            usePromptSnippetStore.getState().applyServerList({
              revision: m.revision,
              snippets: m.snippets as PromptSnippet[],
            });
          }
          break;
        }

        // The Mac's room list changed (AASC-20): the whole list, cut for what
        // this device may see. The Mac's own window ignores it (it is the source).
        case 'rooms_update': {
          receiveRooms({ revision: msg.revision, rooms: msg.rooms });
          break;
        }

        // Another device asked for a room change; only the Mac's main window applies it.
        case 'room_op': {
          handleRoomOpMessage(msg);
          break;
        }

        // A central asked for a skill-note change (POST /api/skill-notes/ops); the notes live in this browser, so
        // only the writer's main window applies it and answers the server with the result.
        case 'skill_note_op': {
          void handleSkillNoteOpMessage(msg);
          break;
        }

        // A central turned keep-awake on or off (POST /api/keep-awake/ops): the setting lives in this window, so the
        // writer's main window sets it (its effect tells the server) and answers the server with the result.
        case 'keep_awake_op': {
          void handleKeepAwakeOpMessage(msg);
          break;
        }

        // The live central sessions changed (server/mcp): the whole list, token-free, sent to this
        // Mac's own windows only (a remote device never receives it). A pop-out ignores it (see followsCentrals).
        case 'centrals_update': {
          if (followsCentrals) useMcpStore.getState().applyCentrals(msg.centrals);
          break;
        }

        // What a central does (server/mcp), to this Mac's own windows only like the list above: one change
        // of a task it handed out (a worker's badge), one new row of its activity log (its panel).
        case 'mcp_task_update': {
          if (followsCentrals) useMcpStore.getState().applyTaskUpdate(msg.task);
          break;
        }
        case 'mcp_activity': {
          if (followsCentrals) useMcpStore.getState().applyActivityRow(msg.row);
          break;
        }

        // A central is waiting on the person (server/mcp/confirm.ts): the card to show, and later that it was
        // answered, expired or withdrawn. This Mac's own windows only; a pop-out never shows a card.
        case 'mcp_confirm': {
          if (followsCentrals) useMcpConfirmStore.getState().apply(msg.confirm);
          break;
        }
        case 'mcp_confirm_resolved': {
          if (followsCentrals) useMcpConfirmStore.getState().resolved(msg.cardId);
          break;
        }

        // The same, for the cards a paired phone may answer (server/mcp/phoneConfirmRoutes.ts, P5-15): sent to remote
        // clients only, and kept by the phone app alone. The dashboard window follows the Mac's own feed above.
        case 'mcp_phone_confirm': {
          if (nativeApp) usePhoneConfirmStore.getState().apply(msg.confirm);
          break;
        }
        case 'mcp_phone_confirm_resolved': {
          if (nativeApp) usePhoneConfirmStore.getState().resolved(msg.cardId);
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
      // Every window reads the room list on each (re)connect: a paired phone may
      // not read the workspace snapshot, and the server may have restarted.
      if (status === 'connected') onRoomsSocketConnected();
      // The live centrals are read on each (re)connect too: a `centrals_update` sent while the
      // socket was down is never replayed. Only the dashboard window uses them (the New Session
      // form lives there; a phone may not start a central, and its read would only be refused).
      // So are the tasks in flight: a window opened mid-task has heard of none, and one that was away has
      // missed their ends (the worker badges read them).
      if (status === 'connected' && followsCentrals) {
        void useMcpStore.getState().load();
        void useMcpStore.getState().loadTasks();
        // Confirmations still waiting: one opened while the socket was down is never replayed.
        void useMcpConfirmStore.getState().load();
      }
      // The phone's own pending cards, for the same reason: one opened while the socket was down is never replayed.
      if (status === 'connected' && nativeApp) void usePhoneConfirmStore.getState().load();
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
