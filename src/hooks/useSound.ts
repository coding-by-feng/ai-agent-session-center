import { useCallback, useEffect, useRef } from 'react';
import { useSettingsStore } from '@/stores/settingsStore';
import {
  soundEngine,
  ACTION_LABELS,
  ACTION_CATEGORIES,
  type SoundAction,
  type SoundName,
} from '@/lib/soundEngine';

export { ACTION_LABELS, ACTION_CATEGORIES };
export type { SoundAction, SoundName };

interface UseSoundReturn {
  /** Play the sound for a given action (respects enabled + mute settings). */
  play: (action: SoundAction) => void;
  /** Preview a sound by name (ignores mute, for settings UI). */
  preview: (soundName: SoundName) => void;
  /** Whether sound is globally enabled. */
  enabled: boolean;
  /** Current master volume (0-1). */
  volume: number;
}

export function useSound(): UseSoundReturn {
  const { soundSettings } = useSettingsStore();
  const settingsRef = useRef(soundSettings);
  settingsRef.current = soundSettings;

  // Sync volume to engine
  useEffect(() => {
    soundEngine.setVolume(soundSettings.volume);
  }, [soundSettings.volume]);

  // Unlock audio on first user interaction
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

  const play = useCallback((action: SoundAction) => {
    const settings = settingsRef.current;
    if (!settings.enabled) return;

    // Per-category muting
    if (settings.muteApproval && action === 'approvalNeeded') return;
    if (settings.muteInput && action === 'inputNeeded') return;

    soundEngine.play(action);
  }, []);

  const preview = useCallback((soundName: SoundName) => {
    soundEngine.preview(soundName);
  }, []);

  return {
    play,
    preview,
    enabled: soundSettings.enabled,
    volume: soundSettings.volume,
  };
}
