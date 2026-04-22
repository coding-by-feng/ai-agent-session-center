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
- `server/ttsManager.ts` — GCP TTS REST client, concurrency cap, bilingual splitter
- `server/apiRouter.ts` — `POST /api/tts/synthesize`, `POST /api/tts/status`
- `src/lib/ttsEngine.ts` — browser-side fetch + queued MP3 playback
- `src/hooks/useTerminal.ts` — `readRecentText({ lines?, sinceAbsLine? })` exposes buffer text
- `src/components/terminal/TerminalContainer.tsx` — spacebar handler, state, polling loop
- `src/components/terminal/TerminalToolbar.tsx` — mic button (pointer hold)
- `src/components/settings/SoundSettings.tsx` — API-key input, toggle, voice pickers, speaking rate, preview
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
- never logged — both `ttsManager.ts` and `apiRouter.ts` redact the key in any
  error payload via `msg.split(apiKey).join('***')`

This design ensures two users on the same machine (e.g. a shared workstation
with one dashboard instance) each use their own GCP billing and quota, and a
key stored by user A is never readable by the server for user B's request.

If the key field is blank:
- the Enable-voice toggle in Settings is disabled
- `TerminalContainer` computes `ttsEnabled = userToggle && key.length > 0`, so
  the mic button is hidden and spacebar does nothing
- `ttsEngine.speak()` rejects with "Google TTS API key not configured"

### Bilingual synthesis
`splitByLanguage(text)` walks char-by-char, classifying CJK vs ASCII/punctuation.
Whitespace and punctuation stick to the current run. Each segment is synthesized
with its voice (`en-US-Chirp3-HD-*` or `cmn-CN-Chirp3-HD-*`) and the resulting
MP3 buffers are concatenated. MP3 frames are self-synchronising so concatenation
plays seamlessly.

### Hold-to-speak flow
1. Settings: paste API key, flip `ttsEnabled = true`.
2. User focuses a session terminal and holds **Space** (or clicks+holds mic).
3. `TerminalContainer` captures the current buffer tail (~20 lines) via
   `readRecentText()` and calls `ttsEngine.speak(text, { apiKey, ... })`.
4. A 1.2s-interval polling loop tracks `buffer.baseY + rows` — any new lines
   since the last snapshot are appended to the TTS queue.
5. `keyup` / `pointerup` / `blur` / settings toggle off / key removed →
   `ttsEngine.stop()` clears the queue and kills the in-flight `<audio>`.

### API surface
- `POST /api/tts/synthesize` — body `{ apiKey, text, voiceEn?, voiceZh?, speakingRate?, lang? }` → `audio/mpeg`
- `POST /api/tts/status` — body `{ apiKey }` → `{ ok, error? }` (probes Google's `voices.list` with the key)

### Rate limiting
- 5 req/sec/client at the HTTP endpoint (`isRateLimited('tts-synthesize', 5)`).
- Max 3 concurrent synthesis calls server-wide (`MAX_CONCURRENT` in ttsManager).

## Dependencies
- `server/apiRouter.ts`, `server/logger.ts`
- `src/stores/settingsStore.ts` (persisted via `persistSetting`)
- `src/hooks/useTerminal.ts` (text extraction from xterm `buffer.active`)

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

## Cross-feature impact
- **Terminal UI** — adds one toolbar button and one global keydown handler
  (scoped to focus inside the terminal root).
- **Settings System** — five new persisted keys (`googleTtsApiKey`,
  `ttsEnabled`, `ttsVoiceEn`, `ttsVoiceZh`, `ttsSpeakingRate`).
- **Sound/Alarm System** — independent; TTS plays over existing sound effects.
