/**
 * useWorkspaceAutoLoad — automatically loads workspace from config on startup.
 * Fires once when the WebSocket first connects, after the initial snapshot settles.
 * Shows a progress overlay while sessions are being recreated.
 */
import { useEffect, useRef } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { useUiStore } from '@/stores/uiStore';
import { loadFromConfig, importSnapshot } from '@/lib/workspaceSnapshot';
import { reportWorkspaceLoadErrors } from '@/components/ui/WorkspaceLoadingOverlay';

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

        const { startWorkspaceLoad, advanceWorkspaceLoad, finishWorkspaceLoad } = useUiStore.getState();
        // Clear any stale failed-titles from a previous load before we start.
        reportWorkspaceLoadErrors([]);
        startWorkspaceLoad(snapshot.sessions.length);

        // Per contract C7, importSnapshot resolves with { created, failed,
        // failedTitles }.  The legacy onComplete callback signature is preserved
        // for compatibility, but we prefer the return value as the source of
        // truth so we know exactly which sessions failed.
        const { created, failed, failedTitles } = await importSnapshot(snapshot, {
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
        });

        if (created > 0 || failed > 0) {
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
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [connected]);
}
