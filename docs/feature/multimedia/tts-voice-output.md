# TTS Voice Output (Hold-to-Speak)

## Function
Read the latest terminal output aloud while the user holds **Space** (or a mic
button in the terminal toolbar). Bilingual EN + zh-CN via Google Cloud
Text-to-Speech. Releasing the key stops playback immediately.

## Purpose
Reduce screen fatigue. When eyes are tired after a long work session, the user
can listen to what the assistant is doing in a specific terminal without
reading.

## Source files
- `server/ttsManager.ts` — GCP TTS REST client, concurrency cap, bilingual splitter, long-text chunker, key probe
- `server/apiRouter.ts` — `POST /api/tts/synthesize`, `POST /api/tts/status`, `redactTtsError` helper, Zod schemas
- `src/lib/ttsEngine.ts` — browser-side fetch + queued MP3 playback, `checkTTSStatus` probe
- `src/hooks/useTerminal.ts` — `readRecentText({ lines?, sinceAbsLine? }) → { text, absBottom }` exposes buffer text
- `src/components/terminal/TerminalContainer.tsx` — spacebar handler, hold state, 1.2s polling loop
- `src/components/terminal/TerminalToolbar.tsx` — mic button (pointer hold), gated on `ttsEnabled` prop
- `src/components/settings/SoundSettings.tsx` — API-key input, toggle, voice pickers, speaking-rate slider, preview
- `src/stores/settingsStore.ts` — `googleTtsApiKey`, `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`, `ttsSpeakingRate`
- `test/ttsManager.test.ts` — language-splitter + API-key-guard unit tests

## Implementation
### Auth — per-user API key (no shared credentials)
There is **no ambient identity**. No gcloud / ADC. No service-account file. No
`GOOGLE_APPLICATION_CREDENTIALS` env var. Every user of the dashboard supplies
their own Google Cloud API key (restricted to the Text-to-Speech API in their
own GCP project) via **Settings → Sound → Voice (Text-to-Speech)**. The key is:

- stored locally in the browser (IndexedDB, alongside `anthropicApiKey` /
  `openaiApiKey` / `geminiApiKey`)
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
(`CJK_RE = /[一-鿿㐀-䶿＀-￯　-〿]/`). Whitespace
and punctuation stick to the current run. `synthesize()` then runs each segment
through `chunkSegment(text, MAX_CHARS_PER_REQUEST)` to keep every request under
`MAX_CHARS_PER_REQUEST = 4500` chars (Google's hard limit is 5000 bytes),
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
- `POST /api/tts/synthesize` — body `{ apiKey, text, voiceEn?, voiceZh?, speakingRate?, lang? }` → `audio/mpeg` (`Cache-Control: no-store`); errors → 500 `{ success: false, error }` (key redacted)
- `POST /api/tts/status` — body `{ apiKey }` → `{ success: true, data: { ok, error? } }` (probes Google's `voices` REST list with the key)

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

## Cross-feature impact
- **[Terminal UI](../frontend/terminal-ui.md)** — adds one toolbar mic button
  (gated on the `ttsEnabled` prop) and a Space keydown/keyup handler scoped to
  focus inside the terminal root.
- **[Settings System](../frontend/settings-system.md)** — five persisted keys
  (`googleTtsApiKey`, `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`,
  `ttsSpeakingRate`); the EN/zh voice pickers offer 8 EN and 4 zh Chirp 3 HD
  voices.
- **[Sound & Alarm System](sound-alarm-system.md)** — independent; TTS plays
  over existing sound effects.
