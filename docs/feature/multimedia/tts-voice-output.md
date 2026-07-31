# TTS Voice Output (Hold-to-Speak + Local Click-to-Speak)

## Function
Read the latest terminal output aloud. Two independent providers:

1. **Google Cloud TTS (hold-to-speak)** — hold **Space** (or the mic button)
   while focused on a terminal. Bilingual EN + zh-CN via Google Cloud
   Text-to-Speech; releasing the key stops playback. Requires a per-user API key.
2. **Local voice (click-to-speak)** — a **🔊 speaker button** in the terminal
   toolbar (click to start, click to stop) that reads output aloud with an
   on-device **English** voice (Kokoro-82M) running entirely in the browser via
   a Web Worker. No API key, no server round-trip; the model downloads once
   (~90 MB) from the Hugging Face CDN, then runs offline.

## Purpose
Reduce screen fatigue. When eyes are tired after a long work session, the user
can listen to what the assistant is doing in a specific terminal without
reading. The local provider additionally removes the cloud dependency — no
credentials, offline after first use.

## Source files
### Google Cloud provider (hold-to-speak)
- `server/ttsManager.ts` — GCP TTS REST client, concurrency cap, bilingual splitter, long-text chunker, key probe
- `server/apiRouter.ts` — `POST /api/tts/synthesize`, `POST /api/tts/status`, `redactTtsError` helper, Zod schemas
- `src/lib/ttsEngine.ts` — browser-side fetch + queued MP3 playback, `checkTTSStatus` probe
- `test/ttsManager.test.ts` — language-splitter + API-key-guard unit tests

### Local Kokoro provider (click-to-speak)
- `src/lib/kokoroWorker.ts` — Web Worker hosting Kokoro-82M via `kokoro-js` (q8/WASM); lazy model load, PCM generation, epoch-guarded stop, give-up backoff after `MAX_LOAD_FAILURES`
- `src/lib/kokoroTts.ts` — main-thread singleton engine: worker lifecycle, per-consumer `owner` tokens, ordered WebAudio playback (`drain()`), load-status `subscribe()`, `speak`/`stop`/`preload`/`terminate`, pure `splitIntoChunks()`
- `src/lib/kokoroTts.test.ts` — `splitIntoChunks` unit tests
- `src/lib/kokoroWorker.test.ts` — guards the ONNX `wasmPaths` override (no-CDN invariant)
- `vite.config.ts` / `vitest.config.ts` — `ort-wasm-binary` alias resolving the ONNX WASM binary on disk
- `server/index.ts` — CSP: `connect-src` includes Hugging Face hosts so the model can download, and `script-src` carries `'wasm-unsafe-eval'` so the runtime can compile

### Shared UI + settings
- `src/hooks/useTerminal.ts` — `readRecentText({ lines?, sinceAbsLine? }) → { text, absBottom }` exposes buffer text
- `src/components/terminal/TerminalContainer.tsx` — Google spacebar/hold + local click-to-speak toggle, both 1.2s polling loops; local owner/voice refs + ownership/error-aware status subscription
- `src/components/terminal/TerminalToolbar.tsx` — mic button (`ttsEnabled`, pointer hold) + speaker button (`localTtsEnabled`, click toggle, spinner while `localTtsLoading`)
- `src/components/settings/SoundSettings.tsx` — **Cloud Voice (Google · English + 中文)**: API key field (Show/Hide), enable toggle, speaking-rate slider, EN/中文 voice pickers, **Preview voice** + **Test API key** buttons; **Local Voice (offline · English · no API key)**: enable toggle, voice picker, **Preview voice**, load-status line
- `src/stores/settingsStore.ts` — `googleTtsApiKey`, `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`, `ttsSpeakingRate`, `ttsLocalEnabled`, `ttsLocalVoice`
- `src/lib/tooltips.ts` — `termSpeak` (mic) + `termSpeakLocal` (speaker) copy

## Implementation
### Auth — per-user API key (no shared credentials)
There is **no ambient identity**. No gcloud / ADC. No service-account file. No
`GOOGLE_APPLICATION_CREDENTIALS` env var. Every user of the dashboard supplies
their own Google Cloud API key (restricted to the Text-to-Speech API in their
own GCP project) via **Settings → Sound → Cloud Voice (Google · English +
中文)**. The key is:

- stored locally in the browser (IndexedDB, alongside `anthropicApiKey` /
  `openaiApiKey`)
- sent in the request body of every `POST /api/tts/synthesize` call
- forwarded by the backend as `?key=...` to the Google TTS REST endpoint
- never logged — `apiRouter.ts` redacts the key in any error payload via the
  `redactTtsError(msg, apiKey)` helper (`msg.split(apiKey).join('***')`), and
  `ttsManager.ts` redacts via `msg.replace(apiKey, '***')` before logging

This design ensures two users on the same machine (e.g. a shared workstation
with one dashboard instance) each use their own GCP billing and quota, and a
key stored by user A is never readable by the server for user B's request.

If the key field is blank:
- the Enable-voice toggle in Settings is disabled
- `TerminalContainer` computes `ttsEnabled = userToggle && key.length > 0`, so
  the mic button is hidden and spacebar does nothing
- `ttsEngine.speak()` rejects with "Google TTS API key not configured"

### Bilingual synthesis
`splitByLanguage(text)` walks char-by-char, classifying CJK vs ASCII/punctuation
(`CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf\uff00-\uffef\u3000-\u303f]/` — CJK
Unified, CJK Ext-A, Halfwidth/Fullwidth Forms, CJK Symbols & Punctuation).
Whitespace and punctuation stick to the current run. `synthesize()` then runs
each segment through `chunkSegment(text, MAX_CHARS_PER_REQUEST)` to keep every
request under `MAX_CHARS_PER_REQUEST = 4500` chars (Google's hard limit is 5000
bytes),
cutting at `\n`, `. `, `。`, or space boundaries. Each chunk is synthesized via
`callSynth()` with its voice (`en-US-Chirp3-HD-*` for `en-US`, or
`cmn-CN-Chirp3-HD-*` for `cmn-CN`) at `audioConfig.effectsProfileId =
['headphone-class-device']`. The resulting MP3 buffers are `Buffer.concat`'d;
MP3 frames are self-synchronising so concatenation plays seamlessly. Defaults:
`DEFAULT_VOICE_EN = 'en-US-Chirp3-HD-Aoede'`, `DEFAULT_VOICE_ZH =
'cmn-CN-Chirp3-HD-Aoede'`, `speakingRate` default `1.0`. When `opts.lang` is
`'en'` or `'zh'` the auto-splitter is bypassed and the whole text uses that one
voice.

### Hold-to-speak flow
1. Settings: paste API key, flip `ttsEnabled = true`.
2. User focuses a session terminal and holds **Space** (or clicks+holds mic).
3. `TerminalContainer.startTts()` reads the current buffer tail (20 lines) via
   `readRecentText({ lines: 20 })`, records `absBottom` in `ttsLastAbsRef`, and
   calls `ttsEngine.speak(initial.text, { apiKey, voiceEn, voiceZh, speakingRate })`.
4. A `setInterval(..., 1200)` polling loop (`ttsPollRef`) calls
   `readRecentText({ sinceAbsLine: ttsLastAbsRef.current })` — any new lines
   since the last snapshot (`snap.absBottom > ttsLastAbsRef.current`) are queued.
5. `keyup` / `pointerup` / `blur` / settings toggle off / key removed →
   `stopTts()` clears the interval and calls `ttsEngine.stop()`, which clears the
   queue and kills the in-flight `<audio>`.

### Browser playback (ttsEngine)
`ttsEngine` is a singleton with a single-consumer queue. `speak(text, opts)`
pushes a `QueueItem` and triggers `drain()`, which fetches one MP3 blob at a time
(`POST /api/tts/synthesize`), creates an object URL, and plays it via a fresh
`Audio` element — each blob URL is revoked on `onended`/`onerror`. `stop()` sets
`stopped = true`, resolves (not rejects) pending awaiters, pauses the current
audio, and revokes the active blob URL. `checkTTSStatus(apiKey)` POSTs to
`/api/tts/status` and returns the `data` envelope (`{ ok, error? }`).

### Local voice (offline, English) — Kokoro
Entirely client-side; the server is never involved. Enabled via **Settings →
Sound → Local Voice** (`ttsLocalEnabled`), voice via `ttsLocalVoice` (default
`af_heart`; 8 US/UK voices).

- **Model**: Kokoro-82M (Apache-2.0), `onnx-community/Kokoro-82M-v1.0-ONNX`,
  loaded with `dtype: 'q8', device: 'wasm'`. The ONNX runtime (`ort-wasm-simd-threaded.jsep`)
  is served from our own origin; only the model **weights** (~90 MB) fetch once from
  `huggingface.co` and cache in the browser (offline thereafter).
- **ONNX runtime must never come from a CDN.** On import, transformers.js sets
  `env.backends.onnx.wasm.wasmPaths` to a jsDelivr URL, which makes
  onnxruntime-web `import()` its WASM glue remotely — surfacing as
  *"no available backend found … Failed to fetch dynamically imported module"*
  whenever jsDelivr is unreachable, and quietly breaking the offline promise.
  `kokoroWorker.ts` overrides it **after** import with `{ wasm: ortWasmUrl }`:
  - The **object** form matters. A plain string is read as a URL *prefix*, which
    sends ORT straight back to fetching the glue remotely. Leaving both `mjs` and
    the prefix unset is the exact condition under which onnxruntime-web uses the
    glue already bundled in `ort.bundle.min.mjs` — no dynamic import at all.
  - `ortWasmUrl` comes from `import 'ort-wasm-binary?url'`, aliased in
    **`vite.config.ts`** (and mirrored in `vitest.config.ts`) to the copy inside
    `@huggingface/transformers/dist`, so the binary is always version-matched to
    the runtime loading it. It can't be deep-imported by specifier because
    neither package's `exports` map exposes `./dist/*`. A missing binary throws
    at config load — deliberately failing the build rather than silently
    reverting to the CDN.
  - Locked by `src/lib/kokoroWorker.test.ts`; `@huggingface/transformers` is a
    direct dependency because the worker imports `env` from it.
- **Worker** (`kokoroWorker.ts`): lazily loads the model on first `preload`/`generate`,
  synthesizes each chunk to Float32 PCM, and transfers it back. A monotonic
  `epoch` (set by the engine on stop) drops stale jobs; empty/silent chunks are
  skipped. After `MAX_LOAD_FAILURES` (2) it gives up until the worker is recreated.
  Message protocol — main → worker: `{ type: 'preload' }`,
  `{ type: 'generate', id, epoch, text, voice }`, `{ type: 'reset', epoch }`
  (drops queued + stale jobs); worker → main:
  `{ type: 'status', status: 'loading' | 'ready' }`, `{ type: 'error', error }`
  (model load failed), `{ type: 'audio', id, epoch, sampleRate, pcm }` (PCM
  buffer transferred, not copied), `{ type: 'genError', id, epoch, error }` (one
  chunk failed).
- **Engine** (`kokoroTts.ts`, singleton `kokoroTts`): `speak(text, { voice, owner })`
  splits text via `splitIntoChunks()` and posts generate jobs; received PCM is
  played in order through a single `AudioContext` in `drain()` (wrapped in
  try/finally so a bad chunk can never wedge the queue). `stop(owner)` only acts
  if `owner` still holds the engine (per-consumer isolation), `terminate()` kills
  the worker (aborting an in-flight download), and `subscribe()` streams
  `{ loading, ready, error, activeOwner }`.
- **Toolbar flow** (`TerminalContainer`): the speaker button toggles
  `startLocalTts`/`stopLocalTts`. Start reads the buffer tail and streams new
  lines on a 1.2s poll (mirroring the Google path). Each terminal holds a stable
  `owner` symbol; the status subscription resets the button if the engine is lost
  to another consumer or the model errors — so it never sticks "on". The spinner
  reflects `loading`. Wired into both the inline and fullscreen toolbars.
- **Settings preview** uses its own `owner`, so closing the panel stops only the
  preview (never a terminal's playback). `handleLocalToggle` calls
  `kokoroTts.preload()` when the feature is enabled (starts the one-time ~90 MB
  download early) and `terminate()` when it is disabled (aborts any in-flight
  download and frees the worker).

### API surface
- `POST /api/tts/synthesize` — body `{ apiKey, text, voiceEn?, voiceZh?, speakingRate?, lang? }` → `audio/mpeg` (`Cache-Control: no-store`); errors → 500 `{ success: false, error }` (key redacted). Zod bounds: `apiKey` 10–200 chars, `text` 1–12000 chars, `voiceEn`/`voiceZh` ≤100 chars, `speakingRate` 0.25–4.0, `lang` one of `en`/`zh`/`auto`; violations → 400. The 12000-char `text` cap sits above ttsManager's own `MAX_CHARS_PER_REQUEST = 4500` chunker, so a long hold-to-speak buffer is chunked server-side but a single oversize request is still rejected at the boundary.
- `POST /api/tts/status` — body `{ apiKey }` (Zod: 1–200 chars) → `{ success: true, data: { ok, error? } }` (probes Google's `voices` REST list with the key)

### Rate limiting
- 5 req/sec/client at the HTTP endpoint (`isRateLimited('tts-synthesize', 5)`); over limit → 429.
- Max 3 concurrent synthesis calls server-wide (`MAX_CONCURRENT = 3` in ttsManager; over limit throws "TTS busy — too many concurrent requests").

## Dependencies & Connections
- `server/apiRouter.ts` ([API Endpoints](../server/api-endpoints.md)), `server/logger.ts`
- `src/stores/settingsStore.ts` (persisted via `persistSetting`) — see
  [Settings System](../frontend/settings-system.md)
- `src/hooks/useTerminal.ts` (text extraction from xterm `buffer.active`) — see
  [Terminal UI](../frontend/terminal-ui.md)
- Voice picker `Select` is a shared [UI primitive](../frontend/ui-primitives.md)
- Independent of [Sound & Alarm System](sound-alarm-system.md) — TTS plays over
  existing sound effects

## Change risks
- **Never** reintroduce ambient credentials (gcloud ADC / service-account env
  vars). Shared identities across users of the same dashboard instance leak
  billing and quota, and a compromised dashboard would leak one user's
  credentials to another.
- Voice name typos return HTTP 400 from the TTS API — surfaced in `ttsStatus`
  and in console errors from `ttsEngine`.
- If the provided key is revoked or lacks the Text-to-Speech API scope,
  `/api/tts/status` returns `{ ok: false, error: "403: ..." }`.
- `splitByLanguage` treats punctuation as "sticky"; exotic unicode ranges
  beyond the CJK blocks in `CJK_RE` will fall into the EN voice.
- `readRecentText` strips control characters; styled ANSI colour output is
  already stripped by xterm on render.
- The Settings speaking-rate slider is capped at `0.5–2.0` (step `0.05`) while
  the server accepts `0.25–4.0`; widening one without the other diverges UI from
  capability.
- **Local voice needs Hugging Face reachable on first run.** The model weights
  download from `huggingface.co` — the server CSP `connect-src` must list the HF
  hosts (see `server/index.ts`); tightening CSP or blocking HF breaks the
  first-run download. The ONNX runtime is local, so only weights hit the network.
- **The CSP has two hard requirements for local voice**, both in
  `server/index.ts`. Removing either kills the feature outright, and neither is
  caught by any test, linter, or typecheck — only by running it:
  1. `script-src` must keep **`'wasm-unsafe-eval'`**, or Chromium refuses to
     compile the ONNX runtime (*"Compiling or instantiating WebAssembly module
     violates … 'unsafe-eval' is not an allowed source"*). It permits WASM
     compilation only, not `eval()` of JS strings — do not "simplify" it to
     `'unsafe-eval'`, and do not drop it as dead weight.
  2. `script-src` does **not** list jsDelivr, so any dynamic `import()` from a
     CDN fails — which is exactly why `wasmPaths` must stay overridden. The two
     defects compound: the override alone still dies on WASM compilation, and
     `'wasm-unsafe-eval'` alone still dies fetching the glue.
- **jsDelivr is still required** by `unicode-font-resolver` (troika-three-text)
  in the 3D scene, so `connect-src`/`font-src` must keep it even though local
  voice no longer touches it.
- **Kokoro is English-only in v1.** Non-English (incl. zh) terminal output is
  read with the English voice; use the Google provider for zh.
- **`kokoroTts` is a shared singleton**, so only one consumer plays at a time —
  a new `speak()` from another terminal/preview takes over. Callers must pass a
  stable `owner` and honor the `activeOwner` broadcast, or their UI desyncs.
- The local model + ORT WASM (~110 MB resident) stay in memory once loaded until
  `terminate()`; only the WASM (single-threaded fallback) runs without
  cross-origin isolation.
- The ONNX binary ships as a **~21 MB build asset** (`assets/ort-wasm-*.wasm`),
  so `npm run build` output grows accordingly — expected, not a regression.

## Cross-feature impact
- **[Terminal UI](../frontend/terminal-ui.md)** — adds a toolbar mic button
  (gated on `ttsEnabled`) + a Space keydown/keyup handler, and a speaker button
  (gated on `localTtsEnabled`) that click-toggles local playback; both inline and
  fullscreen toolbars.
- **[Settings System](../frontend/settings-system.md)** — seven persisted keys
  (`googleTtsApiKey`, `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`, `ttsSpeakingRate`,
  `ttsLocalEnabled`, `ttsLocalVoice`); the Google pickers offer 12 EN voices
  (`TTS_EN_VOICES`: 8 Chirp 3 HD + 2 Studio + 2 Neural2) and 6 zh voices
  (`TTS_ZH_VOICES`: 4 Chirp 3 HD + 2 Wavenet), the local picker 8 Kokoro EN
  voices (`TTS_LOCAL_VOICES`).
- **[API Endpoints](../server/api-endpoints.md)** — the local provider adds no
  endpoint but requires the HF hosts in the server CSP `connect-src` (`server/index.ts`).
- **[Sound & Alarm System](sound-alarm-system.md)** — independent; TTS plays
  over existing sound effects.
