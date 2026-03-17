/**
 * useWorkspaceAutoLoad — automatically loads workspace from config on startup
 * (Electron only). Runs once after the WebSocket snapshot arrives.
 */
import { useEffect, useRef } from 'react';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { loadFromConfig, importSnapshot } from '@/lib/workspaceSnapshot';
import type { SessionSnapshot } from '@/lib/workspaceSnapshot';

export function useWorkspaceAutoLoad(): void {
  const sessions = useSessionStore((s) => s.sessions);
  const loaded = useRef(false);

  useEffect(() => {
    // Only auto-load in Electron mode
    if (!window.electronAPI) return;
    // Only run once, after we have the initial snapshot from WebSocket
    if (loaded.current || sessions.size === 0) return;
    // Wait a short moment for the snapshot to fully settle
    const timer = setTimeout(async () => {
      if (loaded.current) return;
      loaded.current = true;

      try {
        const snapshot = await loadFromConfig();
        if (!snapshot || snapshot.sessions.length === 0) return;

        await importSnapshot(snapshot, {
          onSessionCreated: (_terminalId: string, _snap: SessionSnapshot) => {
            // No need to select — just let them appear
          },
          onComplete: (created: number, failed: number) => {
            if (created > 0 || failed > 0) {
              // eslint-disable-next-line no-console
              console.info(`[workspace] Auto-loaded ${created} session(s)${failed > 0 ? `, ${failed} failed` : ''}`);
            }
            // Restore room assignments from the snapshot
            useRoomStore.getState().loadFromStorage();
          },
        });
      } catch {
        // Silent failure — auto-load is best-effort
      }
    }, 1500);

    return () => clearTimeout(timer);
  }, [sessions.size]);
}
