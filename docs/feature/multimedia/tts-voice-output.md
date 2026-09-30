# TTS Voice Output (Hold-to-Speak)

## Function
Read terminal output aloud via **Google Cloud TTS (hold-to-speak)** — hold
**Space** (or the mic button) while focused on a terminal. Bilingual EN + zh-CN
via Google Cloud Text-to-Speech; releasing the key stops playback. Requires a
per-user API key.

> **Removed (Aug 2026): both other entry points.** This feature used to have
> three independent surfaces; two are gone and this doc now covers only the one
> that remains.
>
> - **The point-and-click line speaker** put a floating 🔊 icon beside whichever
>   terminal line the mouse hovered, speaking just that line. Removed at the
>   user's request — the hover icon intruded on normal reading of terminal
>   output. Gone with it: `useLineSpeaker.ts`, `terminalHoverPosition.ts`,
>   `terminalLineText.ts` (all three plus their tests), `useTerminal`'s
>   `getHoveredLine`/`getLineText`, `.lineSpeakBtn`, and `tooltips.termSpeakLine`.
> - **The local Kokoro voice (click-to-speak)** — an on-device, offline
>   **English** voice (Kokoro-82M running in a Web Worker, no API key, no
>   server round-trip) behind a 🔊 speaker button in the terminal toolbar. It
>   was the last consumer of the Kokoro stack, removed along with it:
>   `src/lib/kokoroTts.ts`, `src/lib/kokoroWorker.ts` and both test files,
>   the `ttsLocalEnabled`/`ttsLocalVoice` settings, the "Local Voice" section
>   of `SoundSettings`, the speaker button + spinner in `TerminalToolbar`, the
>   `startLocalTts`/`stopLocalTts`/`toggleLocalTts` handlers and Kokoro effect
>   block in `TerminalContainer`, `tooltips.termSpeakLocal`, the
>   `ort-wasm-binary` alias in `vite.config.ts`/`vitest.config.ts`, and the
>   Hugging Face hosts (`huggingface.co`, `*.hf.co`, `cas-bridge.xethub.hf.co`)
>   from the server CSP's `connect-src` — see [API
>   Endpoints](../server/api-endpoints.md). `kokoro-js` and
>   `@huggingface/transformers` were uninstalled (32 packages, ~400MB off
>   `node_modules`; `onnxruntime-node` went with them as a transitive dep).
>
> **The 🎤 hold-to-speak mic (Google Cloud TTS) is the one surface left and is
> unaffected by either removal.**

## Purpose
Reduce screen fatigue. When eyes are tired after a long work session, the user
can listen to what the assistant is doing in a specific terminal without
reading.

## Source files
- `server/ttsManager.ts` — GCP TTS REST client, concurrency cap, bilingual splitter, long-text chunker, key probe
- `server/apiRouter.ts` — `POST /api/tts/synthesize`, `POST /api/tts/status`, `redactTtsError` helper, Zod schemas
- `src/lib/ttsEngine.ts` — browser-side fetch + queued MP3 playback, `checkTTSStatus` probe
- `test/ttsManager.test.ts` — language-splitter + API-key-guard unit tests
- `src/hooks/useTerminal.ts` — `readRecentText({ lines?, sinceAbsLine? }) → { text, absBottom }` exposes buffer text for the toolbar's polling loop
- `src/components/terminal/TerminalContainer.tsx` — Google spacebar/hold-to-speak, with a 1.2s polling loop
- `src/components/terminal/TerminalToolbar.tsx` — mic button (`ttsEnabled`, pointer hold)
- `src/components/settings/SoundSettings.tsx` — **Cloud Voice (Google · English + 中文)**: API key field (Show/Hide), enable toggle, speaking-rate slider, EN/中文 voice pickers, **Preview voice** + **Test API key** buttons
- `src/stores/settingsStore.ts` — `googleTtsApiKey`, `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`, `ttsSpeakingRate`
- `src/lib/tooltips.ts` — `termSpeak` (mic) copy

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
(`CJK_RE = /[一-鿿㐀-䶿＀-￯　-〿]/` — CJK
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
- Independent of [Sound & Alarm System](sound-alarm-system.md) — TTS plays
  over existing sound effects

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
- **jsDelivr is still required** in the server CSP's `connect-src`/`font-src`
  by `unicode-font-resolver` (troika-three-text) in the 3D scene — unrelated to
  this feature, but don't remove it thinking TTS was the only consumer.

## Cross-feature impact
- **[Terminal UI](../frontend/terminal-ui.md)** — adds a toolbar mic button
  (gated on `ttsEnabled`) + a Space keydown/keyup handler; both inline and
  fullscreen toolbars.
- **[Settings System](../frontend/settings-system.md)** — five persisted keys
  (`googleTtsApiKey`, `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`,
  `ttsSpeakingRate`); the Google pickers offer 12 EN voices (`TTS_EN_VOICES`: 8
  Chirp 3 HD + 2 Studio + 2 Neural2) and 6 zh voices (`TTS_ZH_VOICES`: 4 Chirp
  3 HD + 2 Wavenet).
- **[API Endpoints](../server/api-endpoints.md)** — the two `/api/tts/*`
  endpoints; the server CSP no longer needs any TTS-specific allowance (the
  Hugging Face hosts it once carried for the local Kokoro voice were removed
  with that feature).
- **[Sound & Alarm System](sound-alarm-system.md)** — independent; TTS plays
  over existing sound effects.
