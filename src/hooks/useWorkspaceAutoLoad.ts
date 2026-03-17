/**
 * useWorkspaceAutoLoad — automatically loads workspace from config on startup
 * (Electron only). Fires once when the WebSocket first connects, after the
 * initial snapshot settles. Does NOT re-trigger when the user creates sessions.
 */
import { useEffect, useRef } from 'react';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore } from '@/stores/roomStore';
import { loadFromConfig, importSnapshot } from '@/lib/workspaceSnapshot';
import type { SessionSnapshot } from '@/lib/workspaceSnapshot';

export function useWorkspaceAutoLoad(): void {
  const connected = useWsStore((s) => s.connected);
  const loaded = useRef(false);

  useEffect(() => {
    // Only auto-load in Electron mode
    if (!window.electronAPI) return;
    // Only run once, on first connection
    if (!connected || loaded.current) return;

    // Wait for the initial snapshot to settle before importing
    const timer = setTimeout(async () => {
      if (loaded.current) return;
      loaded.current = true;

      try {
        const snapshot = await loadFromConfig();
        if (!snapshot || snapshot.sessions.length === 0) return;

        await importSnapshot(snapshot, {
          onSessionCreated: (_terminalId: string, _snap: SessionSnapshot) => {
            // Sessions will appear via WebSocket broadcast — no manual select needed
          },
          onComplete: (created: number, failed: number) => {
            if (created > 0 || failed > 0) {
              // eslint-disable-next-line no-console
              console.info(`[workspace] Auto-loaded ${created} session(s)${failed > 0 ? `, ${failed} failed` : ''}`);
            }
            useRoomStore.getState().loadFromStorage();
          },
        });
      } catch {
        // Silent failure — auto-load is best-effort
      }
    }, 1000);

    return () => clearTimeout(timer);
  }, [connected]);
}
