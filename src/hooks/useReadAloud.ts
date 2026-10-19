/**
 * useReadAloud — a read-aloud button's state and action (AASC-20).
 *
 * Speaks through the cloud TTS the desktop's hold-to-speak mic uses (ttsEngine →
 * /api/tts/synthesize). The Google key is the user's own and stays client-side,
 * sent with each request; there is no ambient credential to fall back on. With
 * no key (or voice output off) the button says where to turn it on instead of
 * failing silently.
 *
 * One voice at a time across the app: `ttsEngine` is a single player, so which
 * button is "speaking" is module state every button reads (`useSyncExternalStore`).
 * Starting one stops the other; a button that unmounts stops its own reading,
 * since nothing would be left on screen to stop it with.
 */
import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { ttsEngine } from '@/lib/ttsEngine';
import { toSpeakableText, chunkSpeech } from '@/lib/speakable';
import { useSettingsStore } from '@/stores/settingsStore';
import { showToast } from '@/components/ui/ToastContainer';

let speakingKey: string | null = null;
const listeners = new Set<() => void>();

function setSpeaking(key: string | null): void {
  speakingKey = key;
  listeners.forEach((notify) => notify());
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** Stop whatever is being read aloud. */
export function stopReadAloud(): void {
  ttsEngine.stop();
  setSpeaking(null);
}

export const READ_ALOUD_SETUP_HINT =
  'Read aloud uses Google Text-to-Speech: turn on voice output and add your API key in Settings.';

/**
 * Is read aloud set up on this device (voice output on, a key saved)? The phone shows
 * its 🔊 buttons only then (Oct 20 2026): before, every answer carried one that could
 * only say "set it up" — in a Settings page the phone didn't have.
 */
export function useReadAloudReady(): boolean {
  const enabled = useSettingsStore((s) => s.ttsEnabled);
  const hasKey = useSettingsStore((s) => s.googleTtsApiKey.trim().length > 0);
  return enabled && hasKey;
}

export interface ReadAloud {
  /** This button's reading is playing (or loading). */
  speaking: boolean;
  /** Start reading what `source` returns, or stop when already reading. */
  toggle: (source: () => string | Promise<string>) => void;
}

/** `key` names the button: the same answer read from two places is two buttons. */
export function useReadAloud(key: string): ReadAloud {
  const speaking = useSyncExternalStore(subscribe, () => speakingKey === key, () => false);
  const enabled = useSettingsStore((s) => s.ttsEnabled);
  const apiKey = useSettingsStore((s) => s.googleTtsApiKey);
  const voiceEn = useSettingsStore((s) => s.ttsVoiceEn);
  const voiceZh = useSettingsStore((s) => s.ttsVoiceZh);
  const speakingRate = useSettingsStore((s) => s.ttsSpeakingRate);

  useEffect(() => () => {
    if (speakingKey === key) stopReadAloud();
  }, [key]);

  const toggle = useCallback((source: () => string | Promise<string>) => {
    if (speakingKey === key) {
      stopReadAloud();
      return;
    }
    if (!enabled || !apiKey.trim()) {
      showToast(READ_ALOUD_SETUP_HINT, 'info', 6000);
      return;
    }
    ttsEngine.stop();
    setSpeaking(key);
    const opts = { apiKey, voiceEn, voiceZh, speakingRate };
    void (async () => {
      try {
        const chunks = chunkSpeech(toSpeakableText(await source()));
        if (chunks.length === 0 && speakingKey === key) showToast('There is no answer to read yet', 'info');
        for (const chunk of chunks) {
          if (speakingKey !== key) return;
          await ttsEngine.speak(chunk, opts);
        }
      } catch (err) {
        if (speakingKey === key) showToast(err instanceof Error ? err.message : 'Read aloud failed', 'error');
      } finally {
        if (speakingKey === key) setSpeaking(null);
      }
    })();
  }, [key, enabled, apiKey, voiceEn, voiceZh, speakingRate]);

  return { speaking, toggle };
}
