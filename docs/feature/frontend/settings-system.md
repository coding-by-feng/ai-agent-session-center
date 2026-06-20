# Settings System

## Function
Comprehensive user preferences management with a 7-tab settings panel, theme system (9 themes), per-CLI sound profiles (3 CLIs), API-key storage, voice (TTS) configuration, select-to-translate options, rebindable shortcuts, and persistent client-side storage.

## Purpose
Lets users customize every aspect of the dashboard: appearance, sounds/voice, hooks, API keys, translation/explain, keyboard shortcuts, and advanced import/export/reset.

## Source Files
| File | Role |
|------|------|
| `src/components/settings/SettingsPanel.tsx` | Modal with 7 tabs (`appearance`, `sound`, `hooks`, `apikeys`, `translation`, `shortcuts`, `advanced`); export/import JSON; embeds `AdvancedSettings` sub-tab (Import/Export + Reset). Also exports `SettingsButton` (header gear). |
| `src/components/settings/ThemeSettings.tsx` | Theme swatch grid (9 themes), 3D character-model picker (6 models with inline SVG icons), font size (10–20px), scanline toggle, animation intensity (0–200%) and speed (30–200%) |
| `src/components/settings/SoundSettings.tsx` | Master sound toggle/volume; **Voice (TTS)** block (per-user Google TTS API key field + show/hide, enable toggle, speaking-rate 0.5–2.0, EN/中文 voice pickers, Preview voice, Test API key); per-CLI sound profiles (Claude/Gemini/Codex tabs, enable/volume + per-action sound dropdowns with preview); ambient/white-noise presets + room sounds; Notifications (toasts) |
| `src/components/settings/HookSettings.tsx` | Hook density (high/medium/low) + Install/Re-install/Uninstall, aggregate + per-CLI status (with legacy-notify warning), auto-send queue toggle, default terminal theme |
| `src/components/settings/ApiKeySettings.tsx` | API-key fields for Anthropic / OpenAI / Google (Gemini), each with show/hide + Save. Provider type for these fields is `'anthropic' \| 'openai' \| 'gemini'` (Google TTS key is configured on the Sound tab, not here) |
| `src/components/settings/TranslationSettings.tsx` | Select-to-translate/explain settings: enable toggle, native/learning language pickers, conversation-context (inherit) toggle, attach-file-path mode (ask/always/never), trigger mode (auto/alt/off) |
| `src/components/settings/ShortcutSettings.tsx` | Embedded rebindable keyboard shortcuts (reuses `ShortcutRow`, grouped by `SECTION_ORDER`, Escape cancels, conflict detection, Reset One / Reset All) |
| `src/stores/settingsStore.ts` | Zustand store: all preference state + setters, DOM side effects (theme/font/scanline/animation), Dexie persistence via `persistSetting`, `loadFromDb`, export-friendly `saveToDb`, `resetDefaults`, `flashAutosave` |
| `src/hooks/useSettingsInit.ts` | Loads persisted settings from Dexie once on startup, applies side effects, syncs master volume to the sound engine, unlocks Web Audio on first interaction |
| `src/types/settings.ts` | Canonical settings types shared by server + client: `BrowserSettings`, `SoundSettings`, `CliSoundConfig`, `AmbientSettings` + `AmbientPreset`, `LabelAlarmSettings`, plus server-side `ServerConfig`, tool/auto-idle/animation config types |

## Implementation

### Theme & appearance (`ThemeSettings`, store side effects)
- 9 themes (`THEMES` array): `command-center` (default), `cyberpunk`, `warm`, `dracula`, `solarized`, `nord`, `monokai`, `light`, `blonde`. Each theme carries a 3-color swatch for the picker.
- Theme application: `applyTheme` sets `data-theme` on `document.body` (removed entirely for `command-center`); CSS custom properties live in `src/styles/themes/*.css`.
- 6 robot models (`ROBOT_MODEL_TYPES`): `robot` (default), `mech`, `drone`, `spider`, `orb`, `tank` — each rendered with an inline SVG `ModelIcon`.
- Font size 10–20px → `applyFontSize` sets `document.documentElement.style.fontSize`.
- Scanline → `applyScanline` toggles the `no-scanlines` class on `document.body`.
- Animation intensity (0–200%) → `--anim-intensity` (value/100); animation speed (30–200%) → `--anim-speed` (value/100).

### Sound & voice (`SoundSettings`)
- Per-CLI default profiles in `CLI_SOUND_PROFILES` for **3 CLIs**: `claude`, `gemini`, `codex` — each `{ enabled, volume, actions }` with **20 action→sound mappings** (sessionStart, sessionEnd, promptSubmit, taskComplete, toolRead/Write/Edit/Bash/Grep/Glob/WebFetch/Task/Other, approvalNeeded, inputNeeded, alert, kill, archive, subagentStart, subagentStop).
- 15 synthesized sounds + `none` (no-op), surfaced via `soundEngine.getSoundNames()`.
- Ambient: `DEFAULT_AMBIENT_SETTINGS` + 6 presets (`off`, `rain`, `lofi`, `serverRoom`, `deepSpace`, `coffeeShop`), plus room-activity sounds with separate volume.
- Notifications toggles: `toastEnabled`.
- Detailed sound/alarm behavior lives in the sound system — see [Sound & Alarm System](../multimedia/sound-alarm-system.md).
- **Voice (TTS)** is configured on this tab (not a separate tab): the per-user `googleTtsApiKey` field, enable toggle, speaking rate, EN/中文 voice pickers, Preview (`ttsEngine.speak`) and Test API key (`checkTTSStatus`). See [TTS Voice Output](../multimedia/tts-voice-output.md).

### Persisted settings keys (store + Dexie)
All keys persist through `persistSetting(key, value)` → `db.settings.put({ key, value, updatedAt })` and reload via `loadFromDb`.
- **TTS (5 keys):** `googleTtsApiKey` (required per-user key, client-side only; set via `setApiKey('googleTts', …)`), `ttsEnabled` (default `false`), `ttsVoiceEn` (default `en-US-Chirp3-HD-Aoede`), `ttsVoiceZh` (default `cmn-CN-Chirp3-HD-Aoede`), `ttsSpeakingRate` (0.5–2.0, default `1.0`). Setters: `setTtsEnabled`, `setTtsVoiceEn`, `setTtsVoiceZh`, `setTtsSpeakingRate`. No ambient GCP credentials — every user configures their own key.
- **Translation / Explain (6 keys):** `translationEnabled` (default `true`), `translationNativeLanguage` (default `简体中文`), `translationLearningLanguage` (default `English`), `translationTrigger` (`'auto' \| 'alt' \| 'off'`, default `'auto'`), `translationInheritContext` (default `true`), `explainAttachFilePath` (`'ask' \| 'always' \| 'never'`, default `'ask'`). Setters: `setTranslationEnabled`, `setTranslationNativeLanguage`, `setTranslationLearningLanguage`, `setTranslationTrigger`, `setTranslationInheritContext`, `setExplainAttachFilePath`. `inheritContext` forks the origin session for all AI-popup modes when resumable (no effect for Gemini origins); `explainAttachFilePath` controls whether the open file's path is attached to "Explain" prompts.
- **API keys:** `anthropicApiKey`, `openaiApiKey`, `geminiApiKey`, `googleTtsApiKey` — set via `setApiKey(provider, key)` where provider is `'anthropic' \| 'openai' \| 'gemini' \| 'googleTts'`. Stored in the Dexie `settings` table (browser-only; never persisted server-side).
- **UI / misc:** `themeName`, `fontSize`, `scanlineEnabled`, `animationIntensity`, `animationSpeed`, `characterModel`, `hookDensity`, `scene3dEnabled`, `toastEnabled`, `autoSendQueue`, `defaultTerminalTheme`, plus JSON-stringified `soundSettings`, `ambientSettings`, `labelAlarms`, `soundActions`, `movementActions`.

### Hook management (`HookSettings`)
- Reads `GET /api/hooks/status` and renders aggregate install state plus per-CLI details (`status.clis`). Density options shown are high/medium/low (the `off` state exists but is not selectable; uninstall sets it).
- Re-install posts `{ density, enabledClis }` to `POST /api/hooks/install`, preserving the server's configured CLI set so enabling Codex in the setup config is not lost from the settings tab. Uninstall posts `POST /api/hooks/uninstall`.
- Codex status is based on lifecycle hook blocks in `~/.codex/config.toml`; old `notify`-style installs are surfaced as a legacy warning (`cliStatus.legacyNotify`).
- Hosts the **auto-send queue** toggle (`autoSendQueue`) — the automation it enables is documented in [Queue Scheduler](./queue-scheduler.md) — and the **default terminal theme** select (auto/dark/light/solarized-dark/solarized-light/dracula/monokai).

### Import / export / reset (`SettingsPanel` → `AdvancedSettings`)
- Export: serializes all data keys (functions + `autosaveVisible` skipped) to `claude-dashboard-settings.json`.
- Import: parses JSON, calls `loadFromDb`, then `persistSetting` for each key.
- `resetDefaults()` restores `defaultSettings`, re-applies side effects, and persists every default.

### Startup (`useSettingsInit`)
- Runs once: reads `db.settings.toArray()`, JSON-parses stringified objects, calls `loadFromDb` (applies theme/font/scanline/animation), and forwards `shortcutBindings` to the shortcut store.
- Syncs `soundSettings.volume` → `soundEngine.setVolume`.
- Unlocks Web Audio on first `click`/`keydown`/`touchstart`.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — settingsStore is a Zustand store
- [Client Persistence](./client-persistence.md) — settings persisted to the Dexie `settings` table
- [Sound/Alarm System](../multimedia/sound-alarm-system.md) — sound engine volume + per-CLI/ambient config driven from settings
- [Server API](../server/api-endpoints.md) — `GET /api/hooks/status`, `POST /api/hooks/install|uninstall`, `POST /api/tts/synthesize|status` (TTS preview/test)
- [Keyboard Shortcuts](./keyboard-shortcuts.md) — Shortcuts tab embeds `ShortcutRow` and the shortcut store

### Depended On By
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — reads `themeName`, `characterModel`, `fontSize`, animation values
- [Terminal UI](./terminal-ui.md) — reads `defaultTerminalTheme`, `ttsEnabled`/`ttsVoice*`/`ttsSpeakingRate`/`googleTtsApiKey`
- [TTS Voice Output](../multimedia/tts-voice-output.md) — reads TTS prefs
- [Floating Terminal Fork](./floating-terminal-fork.md) — translation settings drive fork-translate/explain behavior
- [Queue Scheduler](./queue-scheduler.md) — reads `autoSendQueue`
- [Summary Tab](./summary-tab.md) — reads `anthropicApiKey`/`openaiApiKey`/`geminiApiKey` for summarization
- ALL visual components — CSS custom properties from themes

### Shared Resources
- `document.body` attributes (`data-theme`, `no-scanlines` class), `document.documentElement` CSS custom properties (`--anim-intensity`, `--anim-speed`, font size), the Dexie `settings` table, and `useSettingsStore`

## Change Risks
- Changing theme CSS variable names breaks ALL themed components
- Adding a setting without wiring `persistSetting` causes lost preferences
- settingsStore side effects (DOM manipulation) must be idempotent (re-applied on every `loadFromDb`/`resetDefaults`)
- Import must tolerate partial/unknown keys without corrupting state
- The Google TTS key lives on the Sound tab via `setApiKey('googleTts', …)`; keep it out of the API Keys tab to avoid implying a shared/server key
