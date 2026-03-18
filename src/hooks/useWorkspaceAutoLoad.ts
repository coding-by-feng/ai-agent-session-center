/**
 * useWorkspaceAutoLoad — automatically loads workspace from config on startup.
 * Fires once when the WebSocket first connects, after the initial snapshot settles.
 * Shows a progress overlay while sessions are being recreated.
 */
import { useEffect, useRef } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore } from '@/stores/roomStore';
import { useUiStore } from '@/stores/uiStore';
import { loadFromConfig, importSnapshot } from '@/lib/workspaceSnapshot';
import type { SessionSnapshot } from '@/lib/workspaceSnapshot';

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
        startWorkspaceLoad(snapshot.sessions.length);

        await importSnapshot(snapshot, {
          onProgress: (done, total, currentTitle) => {
            advanceWorkspaceLoad(done, currentTitle);
          },
          onSessionCreated: (_terminalId: string, _snap: SessionSnapshot) => {
            // Sessions will appear via WebSocket broadcast — no manual select needed
          },
          onComplete: (created: number, failed: number) => {
            if (created > 0 || failed > 0) {
              // eslint-disable-next-line no-console
              console.info(`[workspace] Auto-loaded ${created} session(s)${failed > 0 ? `, ${failed} failed` : ''}`);
            }
            useRoomStore.getState().loadFromStorage();
            // Brief delay so the bar reaches 100% visually before dismissing
            setTimeout(finishWorkspaceLoad, 600);
          },
        });
      } catch {
        // Silent failure — auto-load is best-effort
        useUiStore.getState().finishWorkspaceLoad();
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [connected]);
}
