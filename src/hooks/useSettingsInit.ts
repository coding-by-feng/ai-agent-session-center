/**
 * useSettingsInit — Load persisted settings from IndexedDB on app startup.
 * Call once at the top level (e.g., App.tsx).
 */
import { useEffect, useRef } from 'react';
import { db } from '@/lib/db';
import { useSettingsStore } from '@/stores/settingsStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { soundEngine } from '@/lib/soundEngine';
import type { KeyCombo, ShortcutActionId } from '@/types/shortcut';
import { useIsDesktopApp } from '@/lib/platform';

export function useSettingsInit(): void {
  const loaded = useRef(false);

  useEffect(() => {
    if (loaded.current) return;
    loaded.current = true;

    (async () => {
      try {
        const rows = await db.settings.toArray();
        if (rows.length === 0) return;

        const restored: Record<string, unknown> = {};
        for (const row of rows) {
          const { key, value } = row;
          if (typeof value === 'string') {
            // Try to parse JSON objects/arrays that were stringified
            try {
              const parsed = JSON.parse(value);
              if (typeof parsed === 'object' && parsed !== null) {
                restored[key] = parsed;
                continue;
              }
            } catch {
              // Not JSON — use as-is
            }
          }
          restored[key] = value;
        }

        useSettingsStore.getState().loadFromDb(restored);

        // Load shortcut binding overrides
        if (restored.shortcutBindings && typeof restored.shortcutBindings === 'object') {
          useShortcutStore.getState().loadFromDb(
            restored.shortcutBindings as Partial<Record<ShortcutActionId, KeyCombo>>,
          );
        }
      } catch {
        // IndexedDB not available — use defaults
      }
    })();
  }, []);

  // Sync master volume from settings to the sound engine
  const volume = useSettingsStore((s) => s.soundSettings.volume);
  useEffect(() => {
    soundEngine.setVolume(volume);
  }, [volume]);

  // Push the terminal replay-buffer size to BOTH backends whenever it changes
  // (and once on mount / after settings load). Electron mode has both an IPC PTY
  // host AND the embedded server, so we push to both channels unconditionally —
  // each is best-effort. Backends clamp + default, so a failed push is harmless.
  const replayBufferBytes = useSettingsStore((s) => s.terminalReplayBufferBytes);
  useEffect(() => {
    try {
      window.electronAPI?.setPtyReplayBuffer?.(replayBufferBytes);
    } catch {
      // Electron bridge unavailable (browser mode) — ignore.
    }
    fetch('/api/config/terminal-buffer', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bytes: replayBufferBytes }),
    }).catch(() => {
      // Server unreachable — it keeps its default; will re-push on next change.
    });
  }, [replayBufferBytes]);

  // Keep-awake lives in the desktop app's main process (AASC-16): tell this Mac's
  // server whenever the setting changes. Only the desktop app sends it; the
  // route answers this machine only.
  const keepAwake = useSettingsStore((s) => s.keepAwakeWhileWorking);
  const isDesktopApp = useIsDesktopApp();
  useEffect(() => {
    if (!isDesktopApp) return;
    fetch('/api/config/keep-awake', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled: keepAwake === true }),
    }).catch(() => {
      // Server unreachable — it stays off; re-pushed on the next change.
    });
  }, [keepAwake, isDesktopApp]);

  // Unlock Web Audio on first user interaction so alarm sounds can play
  useEffect(() => {
    if (soundEngine.isUnlocked()) return;

    function unlock() {
      soundEngine.unlock();
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
      document.removeEventListener('touchstart', unlock);
    }

    document.addEventListener('click', unlock);
    document.addEventListener('keydown', unlock);
    document.addEventListener('touchstart', unlock);

    return () => {
      document.removeEventListener('click', unlock);
      document.removeEventListener('keydown', unlock);
      document.removeEventListener('touchstart', unlock);
    };
  }, []);
}
