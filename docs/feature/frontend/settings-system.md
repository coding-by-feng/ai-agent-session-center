# Settings System

## Function
Comprehensive user preferences management with 7-tab settings panel, theme system (9 themes), sound profiles (4 CLIs), and persistent storage.

## Purpose
Lets users customize every aspect of the dashboard: appearance, sounds, hooks, API keys, translation, shortcuts, and advanced options.

## Source Files
| File | Role |
|------|------|
| `src/components/settings/SettingsPanel.tsx` | Modal with 7 tabs (APPEARANCE, SOUND, HOOKS, API KEYS, TRANSLATION, SHORTCUTS, ADVANCED — SettingsPanel.tsx:17-25) |
| `src/components/settings/ThemeSettings.tsx` | Theme picker, character model, font, scanlines, animation |
| `src/components/settings/SoundSettings.tsx` | Per-CLI sound profiles, ambient presets, volume controls, Voice (TTS) toggle + EN/zh-CN voice pickers + rate |
| `src/components/settings/HookSettings.tsx` | Hook density, install/uninstall, auto-send, terminal theme |
| `src/components/settings/ApiKeySettings.tsx` | API key management (Anthropic, OpenAI, Gemini, Google Cloud TTS — `googleTtsApiKey`; `setApiKey` provider type `'anthropic' \| 'openai' \| 'gemini' \| 'googleTts'`) |
| `src/components/settings/TranslationSettings.tsx` | Translation/Explain selection-popup settings (native/learning language, trigger mode, inherit-context toggle), ~141 lines |
| `src/components/settings/ShortcutSettings.tsx` | Rebindable keyboard shortcuts |
| `src/stores/settingsStore.ts` | Complex Zustand store with DOM side effects |
| `src/hooks/useSettingsInit.ts` | Loads persisted settings on startup, applies side effects |

## Implementation
- 9 themes: command-center (default), cyberpunk, warm, dracula, solarized, nord, monokai, light, blonde
- Theme application: data-theme attribute on body (removed for command-center), CSS custom properties in src/styles/themes/*.css
- 6 robot models: robot, mech, drone, spider, orb, tank
- Sound profiles: 4 CLIs (claude/gemini/codex/openclaw), each with enabled/volume/20 action->sound mappings
- 15 synthesized sounds + 'none' (no-op), 6 ambient presets
- Font size: 10-20px, sets document.documentElement.style.fontSize
- Import/export: JSON file download/upload, strips function keys, resetDefaults() restores all
- TTS (voice output): 5 persisted keys — `googleTtsApiKey` (required per-user key, stored client-side only; set via `setApiKey('googleTts', …)` alongside the existing `anthropicApiKey`/`openaiApiKey`/`geminiApiKey`), `ttsEnabled` (bool, default false), `ttsVoiceEn` (default `en-US-Chirp3-HD-Aoede`), `ttsVoiceZh` (default `cmn-CN-Chirp3-HD-Aoede`), `ttsSpeakingRate` (0.5–2.0, default 1.0). Setters: `setTtsEnabled`, `setTtsVoiceEn`, `setTtsVoiceZh`, `setTtsSpeakingRate`. No ambient GCP credentials — every user configures their own key
- Translation: 5 persisted keys driving the selection-popup translate/explain forks — `translationEnabled` (bool, default true), `translationNativeLanguage` (default `简体中文`), `translationLearningLanguage` (default `English`), `translationTrigger` (`'auto' \| 'alt' \| 'off'`, default `'auto'`), `translationInheritContext` (bool, default true). Setters: `setTranslationEnabled`, `setTranslationNativeLanguage`, `setTranslationLearningLanguage`, `setTranslationTrigger`, `setTranslationInheritContext`
- useSettingsInit: runs once on startup, loads from Dexie, applies theme/font side effects, syncs volume, unlocks Web Audio

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — settingsStore is a Zustand store
- [Client Persistence](./client-persistence.md) — settings persisted to Dexie settings table
- [Sound/Alarm System](../multimedia/sound-alarm-system.md) — sound engine volume synced from settings
- [Server API](../server/api-endpoints.md) — POST /api/hooks/install|uninstall for hook management

### Depended On By
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — reads theme, characterModel, fontSize
- [Terminal UI](./terminal-ui.md) — reads defaultTerminalTheme, `ttsEnabled`/`ttsVoice*`/`ttsSpeakingRate`
- [TTS Voice Output](../multimedia/tts-voice-output.md) — reads `ttsEnabled` and voice prefs
- [Floating Terminal Fork](./floating-terminal-fork.md) — translation settings drive fork-translate/explain behavior
- ALL visual components — CSS custom properties from themes

### Shared Resources
- document.body attributes (data-theme, no-scanlines class), CSS custom properties, settingsStore

## Change Risks
- Changing theme CSS variable names breaks ALL themed components
- Adding settings without persistence causes lost preferences
- settingsStore side effects (DOM manipulation) must be idempotent
- Import must validate schema to prevent corrupt state
