/**
 * ttsVoices.ts — the Google Text-to-Speech voices AASC offers, English and Chinese.
 * One list for the desktop's Settings → Sound and the phone's Settings → Voice
 * (Oct 20 2026), so the two never offer different voices for the same setting.
 */
export interface TtsVoiceOption {
  value: string;
  label: string;
}

export const TTS_EN_VOICES: readonly TtsVoiceOption[] = [
  { value: 'en-US-Chirp3-HD-Aoede', label: 'Aoede (Chirp 3 HD, female)' },
  { value: 'en-US-Chirp3-HD-Charon', label: 'Charon (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Fenrir', label: 'Fenrir (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Kore', label: 'Kore (Chirp 3 HD, female)' },
  { value: 'en-US-Chirp3-HD-Leda', label: 'Leda (Chirp 3 HD, female)' },
  { value: 'en-US-Chirp3-HD-Orus', label: 'Orus (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Puck', label: 'Puck (Chirp 3 HD, male)' },
  { value: 'en-US-Chirp3-HD-Zephyr', label: 'Zephyr (Chirp 3 HD, female)' },
  { value: 'en-US-Studio-O', label: 'Studio O (female)' },
  { value: 'en-US-Studio-Q', label: 'Studio Q (male)' },
  { value: 'en-US-Neural2-F', label: 'Neural2 F (female)' },
  { value: 'en-US-Neural2-D', label: 'Neural2 D (male)' },
];

export const TTS_ZH_VOICES: readonly TtsVoiceOption[] = [
  { value: 'cmn-CN-Chirp3-HD-Aoede', label: 'Aoede (Chirp 3 HD, female)' },
  { value: 'cmn-CN-Chirp3-HD-Charon', label: 'Charon (Chirp 3 HD, male)' },
  { value: 'cmn-CN-Chirp3-HD-Kore', label: 'Kore (Chirp 3 HD, female)' },
  { value: 'cmn-CN-Chirp3-HD-Puck', label: 'Puck (Chirp 3 HD, male)' },
  { value: 'cmn-CN-Wavenet-A', label: 'Wavenet A (female)' },
  { value: 'cmn-CN-Wavenet-B', label: 'Wavenet B (male)' },
];

/** What "Preview voice" / "Play a sample" says: one English and one Chinese sentence. */
export const TTS_SAMPLE_TEXT = 'Hello. 你好,这是语音预览。Ready to read your terminal output.';

/** The speaking rates the phone's stepper offers (the desktop slider covers the same range). */
export const TTS_RATES = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2] as const;

/** The voice's label, or the raw id for a voice no longer listed. */
export function ttsVoiceLabel(list: readonly TtsVoiceOption[], value: string): string {
  return list.find((v) => v.value === value)?.label ?? value;
}

/** The next rate up (+1) or down (−1) from `rate`, which may sit between two steps. */
export function stepTtsRate(rate: number, dir: 1 | -1): number {
  if (dir > 0) return TTS_RATES.find((r) => r > rate + 1e-9) ?? TTS_RATES[TTS_RATES.length - 1];
  return [...TTS_RATES].reverse().find((r) => r < rate - 1e-9) ?? TTS_RATES[0];
}
