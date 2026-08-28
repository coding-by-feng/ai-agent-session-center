/**
 * useWorkspaceAutoLoad — automatically loads workspace from config on startup.
 * Fires once when the WebSocket first connects, after the initial snapshot settles.
 * Shows a progress overlay while sessions are being recreated.
 *
 * ## Only ONE device may do this
 *
 * The restore is not a local action: `importSnapshot` opens with
 * `POST /api/sessions/clear-all`, which kills every PTY and deletes every
 * session on the SERVER, then rebuilds from the shared snapshot. This hook is
 * mounted in `App.tsx`, so it used to run on every client — meaning opening the
 * dashboard on a phone destroyed and rebuilt the workspace the desktop app was
 * using, leaving duplicate cards, dead terminals and orphans in "Ungrouped".
 *
 * The server now hands out a single restore claim per process lifetime
 * (`presenceManager`). A client that is denied must skip the restore ENTIRELY —
 * including the restore picker, which is the UI that leads to the destructive
 * call. It still renders the workspace normally; it simply receives it over the
 * WebSocket snapshot instead of rebuilding it.
 */
import { useEffect, useRef } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore } from '@/stores/roomStore';
import { loadFromConfig, importSnapshot, setRestorePending } from '@/lib/workspaceSnapshot';
import { reportWorkspaceLoadErrors } from '@/components/ui/WorkspaceLoadingOverlay';
import { claimWorkspaceRestore, releaseWorkspaceRestore } from '@/lib/presenceClient';
import {
  requestRestoreSelection,
  getAutoResumeAll,
} from '@/components/modals/RestorePickerModal';

export function useWorkspaceAutoLoad(): void {
  const connected = useWsStore((s) => s.connected);
  const loaded = useRef(false);

  useEffect(() => {
    // Only run once, on first connection
    if (!connected || loaded.current) return;

    // Wait for the initial snapshot to settle before importing
    const timer = setTimeout(async () => {
      if (loaded.current) return;
      loaded.current = true;

      // Claim BEFORE touching the snapshot. A denied client must not reach the
      // restore picker: showing it would let the user "resume" and trigger the
      // clear-all this gate exists to prevent — and pinned sessions are restored
      // even when the picker is cancelled, so cancelling is not a safe fallback.
      const claim = await claimWorkspaceRestore();
      if (!claim.granted) {
        // Operational info, not debug noise: this line is how you tell a
        // "viewer" device apart from one whose restore silently failed.
        console.info(
          `[workspace] Restore skipped — already owned by ${claim.by ?? 'another device'}` +
            ` (${claim.liveSessions ?? 0} live session(s)). This device is a viewer.`,
        );
        setRestorePending(false);
        // Rooms ONLY — never sessions. Rooms live in each client's
        // localStorage, so a viewer device (a phone on the LAN) otherwise
        // shows an empty room list while the desktop has a dozen: the room
        // dropdown reads "No room" and nothing else, and the session list
        // can't group. The snapshot's rooms already carry CURRENT live
        // session ids (buildSnapshot alias-resolves and filters them), so
        // they line up with the sessions this viewer receives over the
        // WebSocket.
        //
        // Deliberately NOT importSnapshot(): that clears and recreates
        // sessions, which is precisely what the denied claim above exists to
        // prevent. Best-effort — a viewer with no rooms is degraded, not
        // broken, so a failure here must not surface as an error.
        try {
          const snapshot = await loadFromConfig();
          const rooms = snapshot?.rooms ?? [];
          if (rooms.length > 0) {
            useRoomStore.getState().hydrateRooms(rooms);
            console.info(`[workspace] Viewer: hydrated ${rooms.length} room(s) from the server snapshot.`);
          }
        } catch {
          /* best-effort — viewer keeps whatever rooms it already had */
        }
        return;
      }

      try {
        const snapshot = await loadFromConfig();
        if (!snapshot || snapshot.sessions.length === 0) {
          // Nothing was restored, so nothing is owned — let the next client
          // (or a reload after the snapshot is written) try again.
          void releaseWorkspaceRestore();
          return;
        }

        // PINNED sessions are "always there" — they auto-recreate on every
        // restart without asking. Compute their ids up front so we can force
        // them into the restore set regardless of the picker outcome.
        const pinnedIds = new Set(
          snapshot.sessions.filter((s) => s.pinned).map((s) => s.originalSessionId),
        );

        // Show the restore picker unless the user opted into auto-resume-all.
        // The picker resolves with either:
        //   - selectedIds: null   → resume every session (legacy / "Resume all")
        //   - selectedIds: Set    → resume only those originalSessionIds
        //   - cancelled: true     → resume nothing this restart
        let sessionFilter: Set<string> | null = null;
        if (!getAutoResumeAll()) {
          const nonPinned = snapshot.sessions.filter((s) => !s.pinned);
          if (nonPinned.length === 0) {
            // Nothing to ask about — every snapshot session is pinned. Skip the
            // picker entirely and restore them all.
            if (pinnedIds.size === 0) { void releaseWorkspaceRestore(); return; }
            sessionFilter = pinnedIds;
          } else {
            const result = await requestRestoreSelection(snapshot);
            if (result.cancelled) {
              // Even on cancel, pinned sessions still come back.
              if (pinnedIds.size === 0) { void releaseWorkspaceRestore(); return; }
              sessionFilter = pinnedIds;
            } else if (result.selectedIds === null) {
              sessionFilter = null; // resume everything (pinned included)
            } else {
              // User's picks ∪ pinned — a pin overrides an unchecked pinned row.
              sessionFilter = new Set([...result.selectedIds, ...pinnedIds]);
            }
          }
        }

        // Effective count for the progress bar reflects what we'll actually
        // launch (filter applied client-side here; importSnapshot re-applies it).
        const willLaunch = sessionFilter
          ? snapshot.sessions.filter((s) => sessionFilter!.has(s.originalSessionId)).length
          : snapshot.sessions.length;
        if (willLaunch === 0) { void releaseWorkspaceRestore(); return; }

        const { startWorkspaceLoad, advanceWorkspaceLoad, finishWorkspaceLoad } = useUiStore.getState();
        // Clear any stale failed-titles from a previous load before we start.
        reportWorkspaceLoadErrors([]);
        startWorkspaceLoad(willLaunch);

        // Per contract C7, importSnapshot resolves with { created, failed,
        // failedTitles }.  The legacy onComplete callback signature is preserved
        // for compatibility, but we prefer the return value as the source of
        // truth so we know exactly which sessions failed.
        const { created, failed, failedTitles } = await importSnapshot(
          snapshot,
          {
            onProgress: (done, _total, currentTitle) => {
              advanceWorkspaceLoad(done, currentTitle);
            },
            onSessionCreated: () => {
              // Sessions will appear via WebSocket broadcast — no manual select needed
            },
            onComplete: () => {
              // Aggregate counts and titles come from the resolved promise; nothing
              // to do here.  Kept to satisfy the existing callback signature.
            },
          },
          sessionFilter,
        );

        if (created > 0 || failed > 0) {
          // intentional: workspace load summary is operational info, not a debug log
          // eslint-disable-next-line no-console
          console.info(`[workspace] Auto-loaded ${created} session(s)${failed > 0 ? `, ${failed} failed` : ''}`);
        }

        // Room loading + reconciliation is handled inside importSnapshot.
        // If any sessions failed, surface the titles in the overlay so the user
        // knows exactly what was lost.  The overlay stays visible (in error
        // mode) until the user dismisses it.
        if (failed > 0 && failedTitles.length > 0) {
          reportWorkspaceLoadErrors(failedTitles);
          finishWorkspaceLoad();
        } else {
          // Brief delay so the bar reaches 100% visually before dismissing
          setTimeout(finishWorkspaceLoad, 600);
        }
      } catch {
        // Silent failure — auto-load is best-effort. Hand the claim back so a
        // reload can retry: a claim held by a client whose restore died would
        // otherwise make the workspace permanently un-restorable for this
        // server lifetime.
        void releaseWorkspaceRestore();
        useUiStore.getState().finishWorkspaceLoad();
      } finally {
        // Always unblock auto-save once the restore decision is made —
        // regardless of which branch (success, cancel, error, or early-return)
        // we exit through. Without this, a WS reconnect that cancels the 1s
        // startup timer would leave _restorePending=true permanently.
        setRestorePending(false);
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [connected]);
}
