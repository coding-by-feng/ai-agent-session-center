/**
 * ttsEngine — fetches MP3 audio from the backend /api/tts/synthesize endpoint
 * and plays it via an HTMLAudioElement. Maintains a single-consumer queue so
 * multiple short chunks play sequentially without gaps.
 */

export interface TTSRequestOptions {
  /** Per-user Google Cloud API key with Text-to-Speech API enabled. Required. */
  apiKey: string;
  voiceEn?: string;
  voiceZh?: string;
  speakingRate?: number;
  lang?: 'en' | 'zh' | 'auto';
}

interface QueueItem {
  text: string;
  opts: TTSRequestOptions;
  /** Signal so the caller can await completion if desired. */
  resolve: () => void;
  reject: (err: Error) => void;
}

class TTSEngine {
  private queue: QueueItem[] = [];
  private playing = false;
  private audio: HTMLAudioElement | null = null;
  private currentBlobUrl: string | null = null;
  private stopped = false;

  /** Queue text for speech. Returns a promise that resolves when this item finishes. */
  speak(text: string, opts: TTSRequestOptions): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return Promise.resolve();
    if (!opts?.apiKey) return Promise.reject(new Error('Google TTS API key not configured'));
    this.stopped = false;
    return new Promise<void>((resolve, reject) => {
      this.queue.push({ text: trimmed, opts, resolve, reject });
      void this.drain();
    });
  }

  /** Stop any in-flight playback, clear the queue, and revoke blob URLs. */
  stop(): void {
    this.stopped = true;
    this.queue.forEach((q) => q.resolve()); // resolve (not reject) so awaiters unblock quietly
    this.queue = [];
    if (this.audio) {
      try { this.audio.pause(); } catch { /* ignore */ }
      this.audio.src = '';
      this.audio = null;
    }
    if (this.currentBlobUrl) {
      URL.revokeObjectURL(this.currentBlobUrl);
      this.currentBlobUrl = null;
    }
    this.playing = false;
  }

  isPlaying(): boolean {
    return this.playing;
  }

  private async drain(): Promise<void> {
    if (this.playing) return;
    this.playing = true;
    while (this.queue.length > 0 && !this.stopped) {
      const item = this.queue.shift()!;
      try {
        const blobUrl = await this.fetchSpeech(item.text, item.opts);
        if (this.stopped) {
          URL.revokeObjectURL(blobUrl);
          item.resolve();
          break;
        }
        await this.playUrl(blobUrl);
        item.resolve();
      } catch (err) {
        item.reject(err instanceof Error ? err : new Error(String(err)));
      }
    }
    this.playing = false;
  }

  private async fetchSpeech(text: string, opts: TTSRequestOptions): Promise<string> {
    const res = await fetch('/api/tts/synthesize', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text, ...opts }),
    });
    if (!res.ok) {
      let msg = `HTTP ${res.status}`;
      try { const j = await res.json(); msg = j.error || msg; } catch { /* ignore */ }
      throw new Error(`TTS request failed: ${msg}`);
    }
    const blob = await res.blob();
    return URL.createObjectURL(blob);
  }

  private playUrl(blobUrl: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const audio = new Audio(blobUrl);
      this.audio = audio;
      this.currentBlobUrl = blobUrl;
      const cleanup = (): void => {
        URL.revokeObjectURL(blobUrl);
        if (this.currentBlobUrl === blobUrl) this.currentBlobUrl = null;
        if (this.audio === audio) this.audio = null;
      };
      audio.onended = () => { cleanup(); resolve(); };
      audio.onerror = () => { cleanup(); reject(new Error('Audio playback failed')); };
      audio.play().catch((err) => { cleanup(); reject(err instanceof Error ? err : new Error(String(err))); });
    });
  }
}

export const ttsEngine = new TTSEngine();

/** Probe a user-supplied Google TTS API key. */
export async function checkTTSStatus(apiKey: string): Promise<{ ok: boolean; error?: string }> {
  if (!apiKey) return { ok: false, error: 'No API key configured' };
  try {
    const res = await fetch('/api/tts/status', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ apiKey }),
    });
    const json = await res.json();
    return json.data ?? { ok: false, error: 'Unexpected response' };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}
