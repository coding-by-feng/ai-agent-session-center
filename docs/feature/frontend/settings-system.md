# Settings System

## Function
Comprehensive user preferences management with a 7-tab settings panel, theme system (10 themes), per-CLI sound profiles (3 CLIs), API-key storage, voice (TTS) configuration, select-to-translate options, rebindable shortcuts, and persistent client-side storage.

## Purpose
Lets users customize every aspect of the dashboard: appearance, sounds/voice, hooks, API keys, translation/explain, keyboard shortcuts, and advanced import/export/reset.

## Source Files
| File | Role |
|------|------|
| `src/components/settings/SettingsPanel.tsx` | Modal with 7 tabs (`appearance`, `sound`, `hooks`, `apikeys`, `translation`, `shortcuts`, `advanced`); export/import JSON; embeds `AdvancedSettings` sub-tab (Terminal scrollback buffer + Import/Export + Reset) and the `TerminalBufferControl` sub-component. Also exports `SettingsButton` (header gear). |
| `src/components/settings/ThemeSettings.tsx` | Theme swatch grid (10 themes), 3D character-model picker (6 models with inline SVG icons), font size (10–20px), scanline toggle, animation intensity (0–200%) and speed (30–200%) |
| `src/styles/themes/windows-xp.css` | Windows XP (Luna) palette **plus** theme-scoped chrome no other theme carries: XP form fields, 12px bevelled scrollbars, `#316ac5` selection, and the app-wide Tahoma swap (see "Windows XP theme" below) |
| `src/components/settings/SoundSettings.tsx` | Master sound toggle/volume; **Voice (TTS)** block (per-user Google TTS API key field + show/hide, enable toggle, speaking-rate 0.5–2.0, EN/中文 voice pickers, Preview voice, Test API key); per-CLI sound profiles (Claude/Codex tabs, enable/volume + per-action sound dropdowns with preview); ambient/white-noise presets + room sounds; Notifications (toasts) |
| `src/components/settings/HookSettings.tsx` | Hook density (high/medium/low) + Install/Re-install/Uninstall, aggregate + per-CLI status (with legacy-notify warning), auto-send queue toggle, default terminal theme |
| `src/components/settings/ApiKeySettings.tsx` | API-key fields for Anthropic / OpenAI, each with show/hide + Save. Provider type for these fields is `'anthropic' \| 'openai'` (Google TTS key is configured on the Sound tab, not here) |
| `src/components/settings/TranslationSettings.tsx` | Select-to-translate/explain settings: enable toggle, native/learning language pickers, conversation-context (inherit) toggle, attach-file-path mode (ask/always/never), trigger mode (auto/alt/off) |
| `src/components/settings/ShortcutSettings.tsx` | Embedded rebindable keyboard shortcuts (reuses `ShortcutRow`, grouped by `SECTION_ORDER`, Escape cancels, conflict detection, Reset One / Reset All) |
| `src/stores/settingsStore.ts` | Zustand store: all preference state + setters, DOM side effects (theme/font/scanline/animation), Dexie persistence via `persistSetting`, `loadFromDb`, export-friendly `saveToDb`, `resetDefaults`, `flashAutosave` |
| `src/hooks/useSettingsInit.ts` | Loads persisted settings from Dexie once on startup, applies side effects, syncs master volume to the sound engine, unlocks Web Audio on first interaction |
| `src/types/settings.ts` | Canonical settings types shared by server + client: `BrowserSettings`, `SoundSettings`, `CliSoundConfig`, `AmbientSettings` + `AmbientPreset`, `LabelAlarmSettings`, plus server-side `ServerConfig`, tool/auto-idle/animation config types |

## Implementation

### Theme & appearance (`ThemeSettings`, store side effects)
- 10 themes (`THEMES` array): `command-center`, `cyberpunk`, `warm`, `dracula`, `solarized`, `nord`, `monokai`, `light`, `blonde`, `windows-xp` (**default**). Each theme carries a 3-color swatch for the picker.
- The default is **light**, which makes first-paint colour load-bearing: `base.css` `:root` is the dark `command-center` palette and `applyTheme` only runs after Dexie resolves, so three places outside the theme system must agree with `defaultSettings.themeName` or every launch flashes dark — `index.html`'s `<body data-theme>` + `theme-color` meta, and the three `BrowserWindow` `backgroundColor`s in `electron/main.ts` (painted before any web content, and unable to read a CSS variable). `App.tsx`'s pre-mount "Connecting…"/"Loading…" screens read `var(--bg-primary)`/`var(--text-secondary)` instead of hardcoded navy, so they follow whichever theme is active.
- Theme application: `applyTheme` sets `data-theme` on `document.body` (removed entirely for `command-center`); CSS custom properties live in `src/styles/themes/*.css`.
- Adding a theme means touching **five** places, not one: the `ThemeName` union + `THEMES` array (`settingsStore.ts`), a CSS file imported from **both** `src/styles/global.css` and `src/main.tsx`, a `Scene3DTheme` entry in `sceneThemes.ts` (`SCENE_THEMES` is `Record<ThemeName, …>`, so TypeScript catches a miss here), and — for light themes — the scanline-softening group in `light-overrides.css`. An xterm palette in `components/terminal/themes.ts` is optional (the terminal's `auto` mode derives one from the CSS variables).
- A theme that omits a variable silently inherits the dark-navy `:root` default from `base.css` rather than failing, so a new theme must define the full palette set. All 10 currently do.

#### Windows XP theme (`windows-xp`)
The only theme that changes more than colors, so it is also the only one with rules beyond a variable block:
- **Palette** — Luna: `#ece9d8` ButtonFace surfaces, `#0a5fd6` accent, `#316ac5` selection, near-black text. Accent greens/reds are darkened from the real Luna values to stay legible on tan.
- **Font** — sets `--font-mono` to a Tahoma stack, then applies it via `body[data-theme="windows-xp"] *:not(.xterm, .xterm *) { font-family: var(--font-mono) !important }`. The `!important` is load-bearing: ~27 CSS-module rules hardcode `'JetBrains Mono'`, and `SceneOverlay`/`RobotListSidebar`/`LiveView` set `'Share Tech Mono'` as **inline** JSX styles, which nothing else can outrank. Module classes are hashed, so they can't be targeted individually from a stylesheet.
- **Escape hatch** — because the rule forces the *variable* rather than a literal font, any subtree that needs a different family redefines `--font-mono` on itself and the rule resolves to that. `pre`/`code`/`kbd`/`samp` do this (monospace), as does `TexViewer`'s `.paper`/`.katex` (serif). The `:not()` excludes the xterm subtree outright so xterm.js keeps the exact stack it measures glyphs with — a mismatch between measured and rendered font misaligns terminal columns.
- **Chrome** — XP form fields (`#7f9db9` sunken border, square corners), 12px bevelled scrollbars (`body[data-theme] ::-webkit-scrollbar` at (0,1,2) outranks the modules' own 3–8px rules), and an XP-blue `select` chevron replacing the dark-theme one baked into `base.css`.
- All of it is scoped under `body[data-theme="windows-xp"]`, so no other theme can be affected.
- 6 robot models (`ROBOT_MODEL_TYPES`): `robot` (default), `mech`, `drone`, `spider`, `orb`, `tank` — each rendered with an inline SVG `ModelIcon`.
- Font size 10–20px → `applyFontSize` sets `document.documentElement.style.fontSize`.
- Scanline → `applyScanline` toggles the `no-scanlines` class on `document.body`.
- Animation intensity (0–200%) → `--anim-intensity` (value/100); animation speed (30–200%) → `--anim-speed` (value/100).

### Sound & voice (`SoundSettings`)
- Per-CLI default profiles in `CLI_SOUND_PROFILES` for **2 CLIs**: `claude`, `codex` — each `{ enabled, volume, actions }` with **20 action→sound mappings** (sessionStart, sessionEnd, promptSubmit, taskComplete, toolRead/Write/Edit/Bash/Grep/Glob/WebFetch/Task/Other, approvalNeeded, inputNeeded, alert, kill, archive, subagentStart, subagentStop).
- 15 synthesized sounds + `none` (no-op), surfaced via `soundEngine.getSoundNames()`.
- Ambient: `DEFAULT_AMBIENT_SETTINGS` + 6 presets (`off`, `rain`, `lofi`, `serverRoom`, `deepSpace`, `coffeeShop`), plus room-activity sounds with separate volume.
- Notifications toggles: `toastEnabled`.
- Detailed sound/alarm behavior lives in the sound system — see [Sound & Alarm System](../multimedia/sound-alarm-system.md).
- **Voice (TTS)** is configured on this tab (not a separate tab): the per-user `googleTtsApiKey` field, enable toggle, speaking rate, EN/中文 voice pickers, Preview (`ttsEngine.speak`) and Test API key (`checkTTSStatus`). See [TTS Voice Output](../multimedia/tts-voice-output.md).

### Persisted settings keys (store + Dexie)
All keys persist through `persistSetting(key, value)` → `db.settings.put({ key, value, updatedAt })` and reload via `loadFromDb`.
- **TTS (5 keys):** `googleTtsApiKey` (required per-user key, client-side only; set via `setApiKey('googleTts', …)`), `ttsEnabled` (default `false`), `ttsVoiceEn` (default `en-US-Chirp3-HD-Aoede`), `ttsVoiceZh` (default `cmn-CN-Chirp3-HD-Aoede`), `ttsSpeakingRate` (0.5–2.0, default `1.0`). Setters: `setTtsEnabled`, `setTtsVoiceEn`, `setTtsVoiceZh`, `setTtsSpeakingRate`. No ambient GCP credentials — every user configures their own key.
- **Translation / Explain (6 keys):** `translationEnabled` (default `true`), `translationNativeLanguage` (default `简体中文`), `translationLearningLanguage` (default `English`), `translationTrigger` (`'auto' \| 'alt' \| 'off'`, default `'auto'`), `translationInheritContext` (default `true`), `explainAttachFilePath` (`'ask' \| 'always' \| 'never'`, default `'ask'`). Setters: `setTranslationEnabled`, `setTranslationNativeLanguage`, `setTranslationLearningLanguage`, `setTranslationTrigger`, `setTranslationInheritContext`, `setExplainAttachFilePath`. `inheritContext` forks the origin session for all AI-popup modes when resumable; `explainAttachFilePath` controls whether the open file's path is attached to "Explain" prompts.
- **API keys:** `anthropicApiKey`, `openaiApiKey`, `googleTtsApiKey` — set via `setApiKey(provider, key)` where provider is `'anthropic' \| 'openai' \| 'googleTts'`. Stored in the Dexie `settings` table (browser-only; never persisted server-side).
- **UI / misc:** `themeName`, `fontSize`, `scanlineEnabled`, `animationIntensity`, `animationSpeed`, `characterModel`, `hookDensity`, `scene3dEnabled`, `toastEnabled`, `autoSendQueue`, `defaultTerminalTheme`, `terminalReplayBufferBytes`, `terminalScrollbackLines`, plus JSON-stringified `soundSettings`, `ambientSettings`, `labelAlarms`, `soundActions`, `movementActions`.
- **`terminalReplayBufferBytes`** (default `1 * 1024 * 1024` = 1 MB) — terminal scrollback replay buffer size. Set via `setTerminalReplayBufferBytes(bytes)`, which clamps with `clampReplayBufferBytes()` (`src/types/terminal.ts`, range 0.25–32 MB) before persisting. It is NOT consumed in the browser: `useSettingsInit` pushes it to both backends (see Startup below). The control lives in the ADVANCED tab's `TerminalBufferControl` — a free MB number input (source of truth, committed on blur/Enter) plus `1·2·5·10·20` MB preset buttons.
- **`terminalScrollbackLines`** (default `5_000`) — how many lines a **live** xterm keeps in its own buffer. Distinct from the replay buffer: that one is server/main-side bytes replayed to *rebuild* a terminal, this is renderer memory for a terminal that is already open (~`cols × 12` bytes per written line). Set via `setTerminalScrollbackLines(lines)`, clamped by `clampScrollbackLines()` (`src/types/terminal.ts`, range 1 000–200 000). Consumed by `useTerminal` via a ref, so it applies to newly opened terminals without disturbing live ones. Shares `TerminalBufferControl` with the replay buffer, with `5 000 · 20 000 · 50 000 · 100 000` presets.

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
- **Pushes `terminalReplayBufferBytes` to both backends** whenever it changes (and once on mount / after `loadFromDb`): `window.electronAPI?.setPtyReplayBuffer(bytes)` (Electron PTY host) AND `POST /api/config/terminal-buffer` (server WS/SSH terminals). Both are best-effort (each backend clamps + defaults), so a failed push is harmless. Electron mode pushes to both channels because it runs both an IPC PTY host and the embedded server.

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — settingsStore is a Zustand store
- [Client Persistence](./client-persistence.md) — settings persisted to the Dexie `settings` table
- [Sound/Alarm System](../multimedia/sound-alarm-system.md) — sound engine volume + per-CLI/ambient config driven from settings
- [Server API](../server/api-endpoints.md) — `GET /api/hooks/status`, `POST /api/hooks/install|uninstall`, `POST /api/tts/synthesize|status` (TTS preview/test), `POST /api/config/terminal-buffer` (pushes `terminalReplayBufferBytes`)
- [Keyboard Shortcuts](./keyboard-shortcuts.md) — Shortcuts tab embeds `ShortcutRow` and the shortcut store

### Depended On By
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — reads `themeName`, `characterModel`, `fontSize`, animation values
- [Terminal UI](./terminal-ui.md) — reads `defaultTerminalTheme`, `ttsEnabled`/`ttsVoice*`/`ttsSpeakingRate`/`googleTtsApiKey`
- [Terminal/SSH](../server/terminal-ssh.md) & [PTY Host](../electron/pty-host.md) — receive `terminalReplayBufferBytes` (via `POST /api/config/terminal-buffer` / `pty:set-replay-buffer`) to size each terminal's scrollback replay ring
- [TTS Voice Output](../multimedia/tts-voice-output.md) — reads TTS prefs
- [Floating Terminal Fork](./floating-terminal-fork.md) — translation settings drive fork-translate/explain behavior
- [Queue Scheduler](./queue-scheduler.md) — reads `autoSendQueue`
- [Summary Tab](./summary-tab.md) — reads `anthropicApiKey`/`openaiApiKey` for summarization
- ALL visual components — CSS custom properties from themes

### Shared Resources
- `document.body` attributes (`data-theme`, `no-scanlines` class), `document.documentElement` CSS custom properties (`--anim-intensity`, `--anim-speed`, font size), the Dexie `settings` table, and `useSettingsStore`

## Change Risks
- Changing theme CSS variable names breaks ALL themed components
- Adding a setting without wiring `persistSetting` causes lost preferences
- settingsStore side effects (DOM manipulation) must be idempotent (re-applied on every `loadFromDb`/`resetDefaults`)
- Import must tolerate partial/unknown keys without corrupting state
- The Google TTS key lives on the Sound tab via `setApiKey('googleTts', …)`; keep it out of the API Keys tab to avoid implying a shared/server key
- `terminalReplayBufferBytes` must reach BOTH backends (`useSettingsInit` pushes to Electron IPC AND the server). Dropping either push silently diverges Electron-mode (IPC PTYs) from browser-mode (WS/SSH terminals). It only affects terminals created after the change (rings are pre-allocated), so testing requires opening a new terminal — an existing one keeps its size.
