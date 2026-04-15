# Sound, Ambient & Alarm System

## Function
Three-layer audio system: event-driven sound effects (16 synthesized sounds), procedural ambient presets (6 presets), and session alarm management (approval repeating, input one-shot).

## Purpose
Audio feedback so users can monitor sessions without watching the screen. Approval alarms alert when Claude needs permission.

## Source Files
| File | Role |
|------|------|
| `src/lib/soundEngine.ts` | SoundEngine singleton, 16 Web Audio API synthesized sounds, 20 actions, playTone() |
| `src/lib/ambientEngine.ts` | AmbientEngine singleton, 6 procedural presets (rain, lofi, serverRoom, deepSpace, coffeeShop, off) |
| `src/lib/alarmEngine.ts` | Alarm management: approval alarm (repeating), input notification (one-shot), per-CLI profile routing, mute/alert per session |
| `src/lib/cliDetect.ts` | detectCli(): model string keywords to CLI type (claude/gemini/codex/openclaw), event type fallback |
| `src/hooks/useSound.ts` | React hook returning {play(action), preview(soundName), enabled, volume} |

## Implementation

### Sound Synthesis

All sounds are synthesized from Web Audio API (oscillators, gain nodes, filters, noise buffers). Zero audio files are shipped.

AudioContext is created lazily -- only initialized after user interaction to comply with browser autoplay policy.

**16 synthesized sounds:**

| Sound | Synthesis |
|-------|-----------|
| chirp | 1200Hz sine, 80ms |
| ping | 660Hz sine, 200ms |
| chime | 523 -> 659 -> 784Hz sequence |
| ding | 800Hz triangle, 250ms |
| blip | 880Hz square, 50ms |
| swoosh | 300 -> 1200Hz ramp, 250ms |
| click | 1200Hz square, 30ms |
| beep | 440Hz square, 150ms |
| warble | 600Hz sine + 12Hz LFO, 300ms |
| buzz | 200Hz sawtooth, 120ms |
| cascade | 784 -> 659 -> 523 -> 392 descending |
| fanfare | 523 -> 659 -> 784 -> 1047 -> 1319 ascending |
| alarm | 880 -> 660 -> 880 -> 660 square sequence, 150ms spacing |
| thud | 80 -> 30Hz ramp, 350ms |
| urgentAlarm | 3 bursts: 1000 -> 800 -> 1000Hz + 200Hz undertone |
| none | no-op |

### Sound Actions

20 sound actions organized in 3 categories:

- **Session:** sessionStart, sessionEnd, promptSubmit, taskComplete
- **Tool:** toolRead, toolWrite, toolEdit, toolBash, toolGrep, toolGlob, toolWebFetch, toolTask, toolOther
- **System:** approvalNeeded, inputNeeded, alert, kill, archive, subagentStart, subagentStop

Base gain: `0.3 * masterVolume`

### Per-CLI Sound Profiles

4 per-CLI sound profiles with independent action-to-sound mappings:

| CLI | Volume |
|-----|--------|
| claude | 0.7 |
| gemini | 0.7 |
| codex | 0.5 |
| openclaw | 0.7 |

### CLI Detection

`detectCli()` uses a two-phase strategy:

1. **Model string keywords** (checked first): claude/opus/sonnet/haiku -> Claude, gemini/gemma -> Gemini, gpt/codex/o1/o3/o4 -> Codex, openclaw/claw -> OpenClaw
2. **Event type fallback**: if model string yields no match, event type is used

Order matters -- model string check must come before event type fallback.

### Tool Sound Mapping

`TOOL_SOUND_MAP` routes tool names to sound actions:

Read -> toolRead, Write -> toolWrite, Edit -> toolEdit, Bash -> toolBash, Grep -> toolGrep, Glob -> toolGlob, WebFetch -> toolWebFetch, Task -> toolTask, all others -> toolOther

### Ambient Presets

6 procedural presets built from Web Audio nodes:

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
- Clears on status change or mute (unless alerted)
- Multiple concurrent alarms supported via `Map<sessionId, intervalId>`

**Input notification (one-shot):**
- Fires once per session
- `inputFired` map prevents repeat
- Cleared when session leaves input status

**Per-session mute/alert:**
- `mutedSessions` Set, `alertedSessions` Set
- Alert overrides mute
- Alerted sessions play at 2.5x volume (capped at 1.0)
- Alerted sessions use faster alarm interval (5s)

### useSound Hook

React hook returning `{play, preview, enabled, volume}`. Additional features:
- Per-category muting: `muteApproval` and `muteInput` settings suppress approval/input sounds via `useSound.play()`
- Auto-unlocks AudioContext on first user interaction (click/keydown/touchstart)
- Syncs `soundEngine.setVolume()` on volume setting changes

### Event Sound Routing

`handleEventSounds(session)`: maps last event to sound action, routes through CLI profile, respects mute/alert state. Handled event types: `SessionStart`, `UserPromptSubmit`, `PreToolUse` (routed via TOOL_SOUND_MAP), `Stop`, `SessionEnd`, `SubagentStart`, `SubagentStop`.

## Dependencies & Connections

### Depends On
- [State Management](../frontend/state-management.md) -- settingsStore provides sound profiles, volume, enabled, per-CLI configs, ambient settings
- [WebSocket Client](../frontend/websocket-client.md) -- useWebSocket triggers handleEventSounds() on session_update
- [Server Session Management](../server/session-management.md) -- session status drives alarm triggers

### Depended On By
- [WebSocket Client](../frontend/websocket-client.md) -- integrates sound on every session update
- [Settings System](../frontend/settings-system.md) -- SoundSettings tab controls sound profiles

### Shared Resources
- Web Audio AudioContext (singleton per engine)
- settingsStore sound settings
- mutedSessions/alertedSessions Sets

## Change Risks
- AudioContext must be created after user interaction (browser autoplay policy). Removing lazy init breaks audio on all browsers.
- Changing alarm intervals affects user experience significantly.
- Alert volume boost (2.5x) can exceed 1.0 without the cap -- the cap is essential.
- Multiple concurrent approval alarms can be overwhelming -- each session has an independent timer.
- CLI detection order matters -- model string check must come before event type fallback.
- Removing or reordering sounds in the TOOL_SOUND_MAP silently changes audio behavior with no visual indicator.
