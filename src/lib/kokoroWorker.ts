/// <reference lib="webworker" />
/**
 * kokoroWorker — runs Kokoro-82M (via kokoro-js / transformers.js) off the main
 * thread. It lazily downloads the ONNX model on first `generate`/`preload`,
 * caches it in the browser (Cache Storage), and streams raw PCM back to the
 * main-thread `kokoroTts` engine.
 *
 * Message protocol (main → worker):
 *   { type: 'preload' }
 *   { type: 'generate', id, epoch, text, voice }
 *   { type: 'reset', epoch }              // drop queued + stale jobs (on stop())
 *
 * Message protocol (worker → main):
 *   { type: 'status', status: 'loading' | 'ready' }
 *   { type: 'error', error }              // model load failed
 *   { type: 'audio', id, epoch, sampleRate, pcm }   // pcm = Float32Array (transferred)
 *   { type: 'genError', id, epoch, error }          // one chunk failed to synthesize
 */
import { KokoroTTS } from 'kokoro-js';
import { env } from '@huggingface/transformers';
// Aliased in vite.config.ts to the copy inside @huggingface/transformers/dist,
// so the URL is always version-matched to the runtime that loads it.
import ortWasmUrl from 'ort-wasm-binary?url';

// On import, transformers.js defaults `wasmPaths` to a jsDelivr URL. That makes
// onnxruntime-web dynamically import its WASM glue from the CDN on every load —
// which is what fails with "no available backend found ... Failed to fetch
// dynamically imported module" when offline, behind a firewall, or where
// jsDelivr is blocked. It also contradicts this feature's offline promise.
//
// Passing an object (rather than a URL prefix string) leaves both the `mjs`
// override and the prefix unset, which is precisely the condition under which
// onnxruntime-web uses the glue already bundled into `ort.bundle.min.mjs` — no
// dynamic import at all. Only the binary itself is fetched, from our own origin.
if (env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = { wasm: ortWasmUrl };
}

const ctx = self as unknown as DedicatedWorkerGlobalScope;

const MODEL_ID = 'onnx-community/Kokoro-82M-v1.0-ONNX';
const DEFAULT_VOICE = 'af_heart';

interface GenerateJob {
  type: 'generate';
  id: number;
  epoch: number;
  text: string;
  voice?: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tts: any = null;
let loadPromise: Promise<unknown> | null = null;
let currentEpoch = 0;
const queue: GenerateJob[] = [];
let processing = false;

// Stop hammering the (~90MB) download after repeated failures — e.g. a CSP
// block or offline first run. The engine must terminate + recreate the worker
// (feature re-enable) to clear this and try again.
const MAX_LOAD_FAILURES = 2;
let loadFailures = 0;
let gaveUp = false;

function ensureModel(): Promise<unknown> {
  if (tts) return Promise.resolve(tts);
  if (gaveUp) {
    return Promise.reject(new Error('Local voice model failed to load — re-enable local voice to retry'));
  }
  if (!loadPromise) {
    ctx.postMessage({ type: 'status', status: 'loading' });
    loadPromise = KokoroTTS.from_pretrained(MODEL_ID, {
      // q8 + wasm runs everywhere reliably (no WebGPU quantization pitfalls).
      // WebGPU is a future perf optimization, not needed for v1 correctness.
      dtype: 'q8',
      device: 'wasm',
    })
      .then((model: unknown) => {
        tts = model;
        loadFailures = 0;
        ctx.postMessage({ type: 'status', status: 'ready' });
        return model;
      })
      .catch((err: unknown) => {
        loadPromise = null;
        loadFailures += 1;
        if (loadFailures >= MAX_LOAD_FAILURES) gaveUp = true;
        ctx.postMessage({ type: 'error', error: errMsg(err) });
        throw err;
      });
  }
  return loadPromise;
}

async function processQueue(): Promise<void> {
  if (processing) return;
  processing = true;
  try {
    const model = await ensureModel().catch(() => null);
    if (!model) {
      queue.length = 0;
      return;
    }
    while (queue.length > 0) {
      const job = queue.shift()!;
      if (job.epoch !== currentEpoch) continue; // stale — user hit stop
      try {
        const audio = await (model as { generate: (t: string, o: { voice: string }) => Promise<{ audio: Float32Array; sampling_rate: number }> })
          .generate(job.text, { voice: job.voice || DEFAULT_VOICE });
        if (job.epoch !== currentEpoch) continue; // stopped while generating
        const pcm = audio.audio;
        if (!pcm || pcm.length === 0) continue; // symbol-only chunk phonemized to silence — nothing to play
        ctx.postMessage(
          { type: 'audio', id: job.id, epoch: job.epoch, sampleRate: audio.sampling_rate, pcm },
          [pcm.buffer],
        );
      } catch (err) {
        ctx.postMessage({ type: 'genError', id: job.id, epoch: job.epoch, error: errMsg(err) });
      }
    }
  } finally {
    processing = false;
  }
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return err.message;
  const s = String(err);
  return s === '[object Object]' ? 'Unknown TTS error' : s;
}

ctx.onmessage = (e: MessageEvent) => {
  const msg = e.data;
  switch (msg?.type) {
    case 'preload':
      ensureModel().catch(() => { /* error already posted */ });
      break;
    case 'reset':
      currentEpoch = msg.epoch;
      queue.length = 0; // drop everything queued for the previous epoch
      break;
    case 'generate':
      queue.push(msg as GenerateJob);
      void processQueue();
      break;
  }
};
