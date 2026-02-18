/**
 * useSettingsInit — Load persisted settings from IndexedDB on app startup.
 * Call once at the top level (e.g., App.tsx).
 */
import { useEffect, useRef } from 'react';
import { db } from '@/lib/db';
import { useSettingsStore } from '@/stores/settingsStore';
import { soundEngine } from '@/lib/soundEngine';

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
