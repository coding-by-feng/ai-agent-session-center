/**
 * kokoroTts — main-thread engine for local, in-browser Text-to-Speech using
 * Kokoro-82M (Apache-2.0) via kokoro-js. Generation runs in a Web Worker
 * (`kokoroWorker.ts`); this class owns the worker lifecycle, an ordered
 * playback queue, and WebAudio playback. English-only for v1.
 *
 * No network round-trip to our server and no API key — the model is fetched
 * once from the Hugging Face CDN and cached in the browser, then runs offline.
 *
 * Single shared engine, single active "owner": because it's a module singleton,
 * only one consumer (a given terminal, or the settings preview) may drive
 * playback at a time. A `speak()` from a new owner implicitly stops the previous
 * one; `stop(owner)` only acts if that owner still holds the engine. Consumers
 * watch `activeOwner` via `subscribe()` to reset their own UI when they lose it.
 */

export const DEFAULT_KOKORO_VOICE = 'af_heart';

/** Opaque per-consumer token so only the owning component can stop playback. */
export type KokoroOwner = symbol;
const DEFAULT_OWNER: KokoroOwner = Symbol('kokoro-default');

export interface KokoroSpeakOptions {
  voice?: string;
  owner?: KokoroOwner;
}

/** Model/load status surfaced to the UI (spinner + error text + ownership). */
export interface KokoroStatus {
  /** Model is downloading / initializing. */
  loading: boolean;
  /** Model is loaded and ready to synthesize. */
  ready: boolean;
  /** Last fatal load error, if any. */
  error: string | null;
  /** The consumer currently allowed to play, or null when idle. */
  activeOwner: KokoroOwner | null;
}

/**
 * Split arbitrary terminal text into short, speakable chunks so audio can
 * stream sentence-by-sentence (and `stop()` stays snappy). Pure — unit-tested.
 */
export function splitIntoChunks(text: string, maxLen = 500): string[] {
  const cleaned = text.replace(/\s+/g, ' ').trim();
  if (!cleaned) return [];
  // Keep sentence-ending punctuation attached to its sentence.
  const parts = cleaned.match(/[^.!?\n]+[.!?]*\s*/g) ?? [cleaned];
  const chunks: string[] = [];
  let cur = '';
  for (const part of parts) {
    if (cur && (cur + part).length > maxLen) {
      chunks.push(cur.trim());
      cur = part;
    } else {
      cur += part;
    }
  }
  if (cur.trim()) chunks.push(cur.trim());
  return chunks.filter(Boolean);
}

interface PcmMessage {
  type: 'audio';
  id: number;
  epoch: number;
  sampleRate: number;
  pcm: Float32Array;
}

class KokoroTtsEngine {
  private worker: Worker | null = null;
  private audioCtx: AudioContext | null = null;
  private currentSource: AudioBufferSourceNode | null = null;

  /** Bumped on every hard stop so late worker results / audio are discarded. */
  private epoch = 0;
  private nextId = 1;
  private activeOwner: KokoroOwner | null = null;

  private status: KokoroStatus = { loading: false, ready: false, error: null, activeOwner: null };
  private readonly listeners = new Set<(s: KokoroStatus) => void>();

  /** Ordered buffers ready to play (only for the current epoch). */
  private playback: PcmMessage[] = [];
  private draining = false;

  subscribe(cb: (s: KokoroStatus) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  getStatus(): KokoroStatus {
    return this.status;
  }

  private setStatus(patch: Partial<KokoroStatus>): void {
    this.status = { ...this.status, ...patch, activeOwner: this.activeOwner };
    this.listeners.forEach((l) => l(this.status));
  }

  private ensureWorker(): Worker {
    if (this.worker) return this.worker;
    const worker = new Worker(new URL('./kokoroWorker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e: MessageEvent) => this.onWorkerMessage(e.data);
    worker.onerror = (e: ErrorEvent) => {
      this.activeOwner = null;
      this.setStatus({ loading: false, error: e.message || 'Kokoro worker failed to start' });
    };
    this.worker = worker;
    return worker;
  }

  private ensureAudio(): AudioContext {
    if (!this.audioCtx) {
      const Ctor = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.audioCtx = new Ctor();
    }
    // Autoplay policy: resume is allowed because speak() is called from a click.
    if (this.audioCtx.state === 'suspended') void this.audioCtx.resume();
    return this.audioCtx;
  }

  /** Warm up the model without speaking (e.g. on Settings toggle). */
  preload(): void {
    this.ensureWorker().postMessage({ type: 'preload' });
  }

  /**
   * Queue text for local speech. Splits into chunks and streams them in order.
   * A speak() from a different owner takes over the engine (stopping the prior
   * owner's playback).
   */
  speak(text: string, opts?: KokoroSpeakOptions): void {
    const chunks = splitIntoChunks(text);
    if (chunks.length === 0) return;
    const owner = opts?.owner ?? DEFAULT_OWNER;
    const worker = this.ensureWorker();
    this.ensureAudio();
    if (this.activeOwner !== owner) {
      this.hardStop(); // discard the previous owner's in-flight audio
      this.activeOwner = owner;
      this.setStatus({});
    }
    const voice = opts?.voice || DEFAULT_KOKORO_VOICE;
    for (const chunk of chunks) {
      worker.postMessage({ type: 'generate', id: this.nextId++, epoch: this.epoch, text: chunk, voice });
    }
  }

  /**
   * Stop playback for `owner`. If a different owner now holds the engine, this
   * is a no-op (a stale consumer must not cut another's audio). Pass no owner to
   * force-stop unconditionally.
   */
  stop(owner?: KokoroOwner): void {
    if (owner && this.activeOwner && owner !== this.activeOwner) return;
    this.hardStop();
    this.activeOwner = null;
    this.setStatus({});
  }

  /** Tear down the worker entirely (aborts an in-flight model download). */
  terminate(): void {
    this.hardStop();
    this.activeOwner = null;
    if (this.worker) {
      this.worker.terminate();
      this.worker = null;
    }
    this.setStatus({ loading: false, ready: false, error: null });
  }

  /** Internal: drop queued generation + current audio without touching ownership/status. */
  private hardStop(): void {
    this.epoch += 1;
    this.playback = [];
    if (this.worker) this.worker.postMessage({ type: 'reset', epoch: this.epoch });
    // Stopping the source fires its `ended` handler, which resolves the pending
    // drain() promise and nulls currentSource — so the drain loop unwinds
    // cleanly (playback is now empty) without a dangling promise. Don't null
    // onended here or that promise would never resolve.
    if (this.currentSource) {
      try { this.currentSource.stop(); } catch { /* not started / already stopped */ }
    }
  }

  private onWorkerMessage(msg: unknown): void {
    const m = msg as {
      type?: string;
      status?: string;
      error?: string;
      id?: number;
      epoch?: number;
      sampleRate?: number;
      pcm?: Float32Array;
    };
    switch (m.type) {
      case 'status':
        if (m.status === 'loading') this.setStatus({ loading: true, ready: false, error: null });
        else if (m.status === 'ready') this.setStatus({ loading: false, ready: true, error: null });
        break;
      case 'error':
        this.activeOwner = null; // release the engine so a re-enable can re-claim it
        this.setStatus({ loading: false, error: m.error || 'Model failed to load' });
        break;
      case 'genError':
        // One chunk failed — skip it, keep going. Surface nothing fatal.
        break;
      case 'audio': {
        if (m.epoch !== this.epoch) return; // stale (stop() was called)
        if (!m.pcm || m.pcm.length === 0 || typeof m.id !== 'number' || typeof m.sampleRate !== 'number') return;
        this.playback.push({ type: 'audio', id: m.id, epoch: m.epoch, sampleRate: m.sampleRate, pcm: m.pcm });
        void this.drain();
        break;
      }
    }
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      const ctx = this.ensureAudio();
      while (this.playback.length > 0) {
        const item = this.playback.shift()!;
        if (item.epoch !== this.epoch) continue; // discarded by a stop()
        // Copy into a fresh ArrayBuffer-backed array (the worker transferred the
        // original buffer, and copyToChannel wants an ArrayBuffer, not SharedArrayBuffer).
        const data = new Float32Array(item.pcm);
        if (data.length === 0) continue; // guard: createBuffer throws on length 0
        const buffer = ctx.createBuffer(1, data.length, item.sampleRate);
        buffer.copyToChannel(data, 0);
        await new Promise<void>((resolve) => {
          try {
            const source = ctx.createBufferSource();
            source.buffer = buffer;
            source.connect(ctx.destination);
            source.onended = () => {
              if (this.currentSource === source) this.currentSource = null;
              resolve();
            };
            this.currentSource = source;
            if (item.epoch !== this.epoch) { resolve(); return; } // stopped mid-setup
            source.start();
          } catch {
            resolve(); // never leave the loop awaiting a rejected/failed source
          }
        });
      }
    } finally {
      // Always clear the flag — a throw must never permanently wedge playback.
      this.draining = false;
    }
  }
}

export const kokoroTts = new KokoroTtsEngine();
