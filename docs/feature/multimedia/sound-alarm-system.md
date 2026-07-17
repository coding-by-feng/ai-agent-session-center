# Sound, Ambient & Alarm System

## Function
Three-layer audio system: event-driven sound effects (15 synthesized sounds + `none` no-op), procedural ambient presets (5 active presets + `off`), and session alarm management (approval repeating, input one-shot).

## Purpose
Audio feedback so users can monitor sessions without watching the screen. Approval alarms alert when Claude needs permission.

## Source Files
| File | Role |
|------|------|
| `src/lib/soundEngine.ts` | SoundEngine singleton, 15 Web Audio API synthesized sounds + `none`, 20 actions, playTone()/playSequence(), action overrides |
| `src/lib/ambientEngine.ts` | AmbientEngine singleton, 5 procedural presets (rain, lofi, serverRoom, deepSpace, coffeeShop) + `off` |
| `src/lib/alarmEngine.ts` | Alarm management: approval alarm (repeating), input notification (one-shot), per-CLI profile routing, mute/alert per session, event-to-sound routing |
| `src/lib/cliDetect.ts` | detectCli(): explicit `session.cliSource`, startup/SSH command, model keywords, and event fallback to CLI type (claude/gemini/codex) |
| `src/hooks/useSound.ts` | React hook returning {play(action), preview(soundName), enabled, volume}; auto-unlocks AudioContext, syncs volume |

## Implementation

### Sound Synthesis

All sounds are synthesized from Web Audio API (oscillators, gain nodes, filters, noise buffers). Zero audio files are shipped.

AudioContext is created lazily (`getCtx()`) and resumed if suspended; `unlock()` must be called after a user gesture (`SoundEngine.play()` returns `false` until `unlocked`). Default master volume is `0.5`.

**15 synthesized sounds + `none`** (no-op). `playTone(freq, dur, type, vol)` and `playSequence(freqs, spacing, dur, type)` are the synthesis primitives:

| Sound | Synthesis |
|-------|-----------|
| chirp | 1200Hz sine, 80ms |
| ping | 660Hz sine, 200ms |
| chime | 523 -> 659 -> 784Hz sequence (80ms spacing) |
| ding | 800Hz triangle, 250ms |
| blip | 880Hz square, 50ms (vol 0.5) |
| swoosh | 300 -> 1200Hz ramp, 300ms |
| click | 1200Hz square, 30ms (vol 0.2) |
| beep | 440Hz square, 150ms (vol 0.4) |
| warble | 600Hz sine + 12Hz LFO, 300ms |
| buzz | 200Hz sawtooth, 120ms (vol 0.4) |
| cascade | 784 -> 659 -> 523 -> 392 descending |
| fanfare | 523 -> 659 -> 784 -> 1047 -> 1319 ascending |
| alarm | 880 -> 660 -> 880 -> 660 square sequence, 150ms spacing |
| thud | 80 -> 30Hz ramp, 350ms |
| urgentAlarm | 3 bursts (0.4s apart): 1000 -> 800 -> 1000Hz square + 200Hz sawtooth undertone |
| none | no-op |

Each action resolves to a sound via `DEFAULT_ACTION_SOUNDS` merged with per-action overrides (`setActionSound()` / `loadOverrides()`); `getActionSound()` returns the resolved name.

### Sound Actions

20 sound actions organized in 3 categories:

- **Session:** sessionStart, sessionEnd, promptSubmit, taskComplete
- **Tool:** toolRead, toolWrite, toolEdit, toolBash, toolGrep, toolGlob, toolWebFetch, toolTask, toolOther
- **System:** approvalNeeded, inputNeeded, alert, kill, archive, subagentStart, subagentStop

Per-tone gain in `playTone`: `vol * masterVolume * 0.3` (default `vol` = 1). Default master volume `0.5`.

### Per-CLI Sound Profiles

3 per-CLI sound profiles (defined in `settingsStore` as `CLI_SOUND_PROFILES`, exposed via `soundSettings.perCli`) with independent action-to-sound mappings and per-CLI enable flag:

| CLI | Default Volume |
|-----|--------|
| claude | 0.7 |
| gemini | 0.7 |
| codex | 0.5 |

When a CLI is detected and its profile is enabled, `playForCli` resolves the sound from `cliConfig.actions[action] ?? 'none'` and plays it via `soundEngine.preview()`, which bypasses both the `unlocked` gate and the `DEFAULT_ACTION_SOUNDS`/override resolution. Only the fallback path (no CLI match or profile disabled) calls `soundEngine.play(action)`.

### CLI Detection

`detectCli()` (returns `CliName = 'claude' | 'gemini' | 'codex'` or `null`) uses a four-phase strategy:

1. **Explicit `session.cliSource`** from hook payloads or terminal creation (Codex hooks set `cli_source: "codex"`).
2. **Startup/SSH command text** (`startupCommand`, `sshCommand`, `sshConfig.command`), so `codex ...` is recognized even when the model name is ambiguous.
3. **Model string keywords**: claude/opus/sonnet/haiku -> Claude, gemini/gemma -> Gemini, gpt/codex/o1/o3/o4 -> Codex.
4. **Event type fallback**: BeforeAgent/AfterAgent/BeforeTool/AfterTool -> Gemini, agent-turn-complete or `Codex*` -> Codex, SessionStart/PreToolUse/PostToolUse/UserPromptSubmit -> Claude.

Order matters -- explicit CLI source and launch command must come before model
and event fallbacks to avoid mislabeling Codex sessions.

### Tool Sound Mapping

`TOOL_SOUND_MAP` routes tool names to sound actions:

Read -> toolRead, Write -> toolWrite, Edit -> toolEdit, Bash -> toolBash, Grep -> toolGrep, Glob -> toolGlob, WebFetch -> toolWebFetch, Task -> toolTask, all others -> toolOther

### Ambient Presets

5 procedural presets built from Web Audio nodes, plus `off`. The `ambientEngine` singleton has its own AudioContext (default volume `0.3`); `start(preset, volume?)` stops any current preset before building the new one, and `stop()` clears all intervals/timeouts, stops sources, and disconnects gains.

Ambient is off by default (`DEFAULT_AMBIENT_SETTINGS` = `enabled: false`, `preset: 'off'`, `volume: 0.3`, `roomSounds: false`, `roomVolume: 0.2`). `enabled` is a real gate: `SoundSettings.handleAmbientPresetChange` only calls `ambientEngine.start()` when `ambientSettings.enabled` is true, and `handleAmbientToggle` starts/stops on it.

| Preset | Synthesis |
|--------|-----------|
| rain | Bandpass noise + random droplets |
| lofi | 60Hz sine + 0.3Hz LFO + lowpass (400Hz) noise bed |
| serverRoom | Bandpass (500Hz) noise + 120Hz triangle fan hum + 0.1Hz LFO + 8kHz sine whine |
| deepSpace | 40Hz drone + 0.05Hz LFO + 80Hz harmonic + 3s convolver reverb |
| coffeeShop | Filtered noise + random dings |
| off | No audio |

### Alarm System

**Approval alarm (repeating):**
- Session enters approval status -> `playForCli(session, 'approvalNeeded')` immediately
- `setInterval` repeating: normal interval 10s, alerted interval 5s
- Clears on status change or mute -- mute wins even for alerted sessions (`checkAlarms` never consults `alertedSessions` for the mute gate)
- Multiple concurrent alarms supported via `Map<sessionId, intervalId>`

**Input notification (one-shot):**
- Fires once per session
- `inputFired` map prevents repeat
- Cleared when session leaves input status

**Per-session mute/alert:**
- `mutedSessions` Set, `alertedSessions` Set
- Alert overrides mute for event sounds only (`handleEventSounds`); for the approval alarm and input notification (`checkAlarms`), mute wins over alert
- Alerted sessions play at 2.5x volume (capped at 1.0)
- Alerted sessions use faster alarm interval (5s)

**Public API:**
- `checkAlarms(session, getSessions)` -- triggers/clears the approval + input alarms for one session based on its current status; `getSessions` is a live accessor the repeating timer uses to re-read that session each tick
- `muteSession(sessionId)` -- add session to muted set
- `unmuteSession(sessionId)` -- remove session from muted set
- `isMuted(sessionId)` -- check if session is muted
- `alertSession(sessionId)` -- add session to alerted set (overrides mute, 2.5x volume, 5s interval)
- `unalertSession(sessionId)` -- remove session from alerted set
- `isAlerted(sessionId)` -- check if session is alerted
- `clearAlarm(sessionId)` -- clear active alarm interval for a session
- `clearAllAlarms()` -- clear all active alarm intervals

### useSound Hook

React hook returning `{play, preview, enabled, volume}`. Additional features:
- Per-category muting: `muteApproval` and `muteInput` settings (default `false`) suppress approval/input sounds via `useSound.play()`
- Auto-unlocks AudioContext on first user interaction (click/keydown/touchstart), guarded by `soundEngine.isUnlocked()`
- Syncs `soundEngine.setVolume()` on volume setting changes
- Re-exports `ACTION_LABELS`, `ACTION_CATEGORIES`, and the `SoundAction` / `SoundName` types

### Event Sound Routing

`handleEventSounds(session)`: maps last event to sound action, routes through CLI profile, respects mute/alert state. Handled event types: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (routed via TOOL_SOUND_MAP), `Stop`, `SessionEnd`, `SubagentStart`, `SubagentStop`.

## Dependencies & Connections

### Depends On
- [State Management](../frontend/state-management.md) -- settingsStore provides `soundSettings` (enabled, volume, per-CLI `perCli` profiles, `muteApproval`/`muteInput`) and `ambientSettings` (enabled, preset, volume, roomSounds, roomVolume)
- [WebSocket Client](../frontend/websocket-client.md) -- `useWebSocket` calls `handleEventSounds(session)` and `checkAlarms(session, getSessions)` on every session update
- [Server Session Management](../server/session-management.md) -- session status (`approval` / `input`) drives alarm triggers

### Depended On By
- [WebSocket Client](../frontend/websocket-client.md) -- integrates sound + alarm checks on every session update
- [Settings System](../frontend/settings-system.md) -- SoundSettings tab controls sound profiles, per-CLI mappings, and ambient preset/volume (drives `ambientEngine.start/stop/setVolume`)
- [Session Detail Panel](../frontend/session-detail-panel.md) -- SessionControlBar toggles per-session `muteSession`/`unmuteSession` and `alertSession`/`unalertSession`

### Shared Resources
- Web Audio AudioContext (singleton per engine)
- settingsStore sound settings
- mutedSessions/alertedSessions Sets

## Change Risks
- AudioContext must be created after user interaction (browser autoplay policy). Removing lazy init breaks audio on all browsers.
- Changing alarm intervals affects user experience significantly.
- Alert volume boost (2.5x) can exceed 1.0 without the cap -- the cap is essential.
- Multiple concurrent approval alarms can be overwhelming -- each session has an independent timer.
- CLI detection order matters -- explicit cliSource and launch command must come before model and event fallbacks. `detectCli()` returns only `claude`/`gemini`/`codex`; `CliName` and `settingsStore.perCli` keys must stay in sync.
- Removing or reordering sounds in the TOOL_SOUND_MAP silently changes audio behavior with no visual indicator.
