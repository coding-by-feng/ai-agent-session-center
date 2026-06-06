/**
 * useWorkspaceAutoLoad — automatically loads workspace from config on startup.
 * Fires once when the WebSocket first connects, after the initial snapshot settles.
 * Shows a progress overlay while sessions are being recreated.
 */
import { useEffect, useRef } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';
import { loadFromConfig, importSnapshot, setRestorePending } from '@/lib/workspaceSnapshot';
import { reportWorkspaceLoadErrors } from '@/components/ui/WorkspaceLoadingOverlay';
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

      try {
        const snapshot = await loadFromConfig();
        if (!snapshot || snapshot.sessions.length === 0) return;

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
            if (pinnedIds.size === 0) return;
            sessionFilter = pinnedIds;
          } else {
            const result = await requestRestoreSelection(snapshot);
            if (result.cancelled) {
              // Even on cancel, pinned sessions still come back.
              if (pinnedIds.size === 0) return;
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
        if (willLaunch === 0) return;

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
        // Silent failure — auto-load is best-effort
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
