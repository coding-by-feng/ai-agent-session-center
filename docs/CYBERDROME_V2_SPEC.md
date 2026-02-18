# Cyberdrome V2 — Comprehensive Enhancement Specification

## Team Execution Plan

This spec is designed for parallel agent team execution. Each workstream is independent enough to run concurrently, with dependency arrows noted where sequencing matters.

---

## Workstream 1: Group → Room Rename (Foundation — blocks all others)

**Goal:** Eliminate the "group" abstraction entirely. The mental model is **Rooms** — physical spaces in the Cyberdrome where robots work.

### Renames

| From | To |
|------|-----|
| `src/stores/groupStore.ts` | `src/stores/roomStore.ts` |
| `src/stores/groupStore.test.ts` | `src/stores/roomStore.test.ts` |
| `src/styles/modules/SessionGroup.module.css` | `src/styles/modules/Room.module.css` |
| Type `SessionGroup` | Type `Room` |
| Hook `useGroupStore` | Hook `useRoomStore` |
| `STORAGE_KEY = 'session-groups'` | `STORAGE_KEY = 'session-rooms'` |
| ID prefix `group-` | ID prefix `room-` |

### Method Renames

| From | To |
|------|-----|
| `createGroup(name)` | `createRoom(name)` |
| `renameGroup(id, name)` | `renameRoom(id, name)` |
| `deleteGroup(id)` | `deleteRoom(id)` |
| `toggleCollapse(id)` | `toggleCollapse(id)` (keep) |
| `getGroupForSession(sid)` | `getRoomForSession(sid)` |

### CSS Class Renames

| From | To |
|------|-----|
| `.group` | `.room` |
| `.groupGrid` | `.roomGrid` |
| `.groupDragging` | `.roomDragging` |
| `.groupDropLeft` | `.roomDropLeft` |
| `.groupDropRight` | `.roomDropRight` |

### Files to Update (imports + local variable names)

- `src/components/3d/CyberdromeScene.tsx` — `groups` → `rooms`
- `src/components/3d/SceneOverlay.tsx` — all group refs → room refs
- `src/components/3d/SessionRobot.tsx` — `getGroupForSession` → `getRoomForSession`
- `src/components/3d/RoomLabels.tsx` — `groups` → `rooms`
- `src/components/session/SessionControlBar.tsx` — UI text "No group" → "No room", "+ New Group" → "+ New Room"
- `src/lib/cyberdromeScene.ts` — `SessionGroup` → `Room`, param name `groups` → `rooms`, field `groupId` → `roomId` in `RoomConfig`
- `src/components/session/DetailPanel.test.tsx` — check for group refs

### DO NOT rename

- `groupBy` in `settingsStore.ts` / `BrowserSettings` — different concept (sort/filter)

---

## Workstream 2: Room Door Labels (3D Text at Doorway)

**Goal:** Room names displayed as 3D text on the floor in front of each room's south door (the entry door), parallel to the ground plane, readable from the default camera angle.

### Current State

`RoomLabels.tsx` uses `<Html>` (drei) at position `[cx, 2.5, cz]` — floating above room center. This is a DOM overlay that can cover other UI elements.

### Target

Replace `<Html>` labels with `<Text>` from `@react-three/drei` (SDF text rendered in WebGL, not DOM):

- **Position:** `[cx, 0.02, cz + ROOM_HALF + 1.5]` — just outside the south wall door, slightly above floor
- **Rotation:** `[-Math.PI / 2, 0, 0]` — flat on the ground, facing up
- **Font:** `'Orbitron'` or a suitable monospace/sci-fi web font
- **Color:** Room's strip color from the neon palette, with emissive glow
- **Size:** `fontSize={0.8}` — readable at zoom level but not overwhelming
- **Content:** Room name in uppercase + unit count badge

### Why 3D Text Instead of Html

- Never covers DOM overlays (settings, detail panel)
- Properly occluded by 3D geometry
- Scales naturally with camera zoom
- No z-index conflicts

### Sub-count Badge

Below room name, smaller text: `"N UNITS"` in dimmer color.

---

## Workstream 2.5: Desk-Sitting Behavior for Prompting & Working

**Goal:** When a robot is **prompting** or **working**, it must walk to an available desk in its assigned room, sit down, and show its status from the seated position. This is the core "office worker" metaphor — robots aren't wandering aimlessly, they go to their desk to think and work.

### Current State

- `working` already has `seekDesk: true` in `robotStateMap.ts` — robot finds a workstation
- `prompting/thinking` has `seekDesk: false`, `wander: true` — robot wanders randomly

### Target Behavior

| Status | seekDesk | Desk Animation | Visual |
|--------|----------|----------------|--------|
| `idle` | `false` | N/A — wander slowly | Standing, gentle float |
| `prompting` | **`true`** | Walk to desk → sit → "chin scratch" thinking pose | Seated, head tilted, one arm raised |
| `working` | `true` | Walk to desk → sit → rapid arm movement (typing) | Seated, arms moving, body sway |
| `waiting` | `false` | Stand up from desk → wander slowly | Standing, hop bounce |
| `approval` | `false` | Stay at desk if already seated, else freeze in place | Seated or standing, visor flash yellow |
| `input` | `false` | Stay at desk if already seated, else freeze in place | Seated or standing, visor flash purple |
| `ended` | `false` | Slump at desk if seated, else collapse in place | Limp, all emissives dim |
| `connecting` | `false` | N/A — boot animation at spawn point | Scale-up from 0 |

### Key Changes to `robotStateMap.ts`

```typescript
// prompting/thinking — NOW seeks desk
thinking: {
  seekDesk: true,        // was: false
  wander: false,         // was: true
  urgentFlash: false,
  visorColorOverride: null,
  speedMultiplier: 0.7,  // walks to desk at moderate pace
},
```

### Desk Occupancy Rules

- Each room has 6 workstations (3 north wall, 2 west wall, 1 east wall)
- When `prompting` or `working`: robot claims the nearest empty desk in its room
- A robot **keeps its desk** through `prompting → working` transitions (don't stand up and re-seat)
- Desk released only when transitioning to `idle`, `waiting`, `ended`, or room reassignment
- If all desks in a room are full: robot stands behind the nearest occupied desk (overflow position)

### Seated Status Display

While seated, the robot's dialogue bubble (WS3) and glow disc (WS4) remain active:
- Dialogue bubble floats above seated robot's head
- Glow disc stays beneath the desk chair position
- The desk itself can have a small holographic "screen" effect (optional) — a translucent rectangle in front of the seated robot showing the current tool icon

### Animation Transitions

- `idle → prompting`: Robot walks to desk → sits → thinking pose
- `prompting → working`: Smooth transition from thinking to typing (no stand-up)
- `working → waiting`: Robot stands up from desk → releases desk → wanders
- `working → approval`: Robot stays seated, visor turns yellow, arms freeze mid-type
- `approval → working`: Resume typing animation (still seated, same desk)

### Implementation Files

- `src/lib/robotStateMap.ts` — Change `thinking.seekDesk` to `true`, adjust speeds
- `src/components/3d/SessionRobot.tsx` — Update NAV logic: don't release desk on `prompting ↔ working` transitions
- `src/components/3d/Robot3DModel.tsx` — Add seated-thinking pose variant (distinct from seated-working)
- `src/lib/cyberdromeScene.ts` — Desk occupancy tracking already exists via `Workstation.occupantId`

---

## Workstream 3: Robot Dialogue Popup System

**Goal:** Replace the current movement-action visual system with speech-bubble dialogue popups above each robot's head. These show contextual messages based on session status and events. Dialogues appear whether the robot is standing or **seated at a desk** (see WS2.5).

### Design

- Floating panel above robot head at `Y + 2.5` (above the label)
- Use `<Html>` from drei with `distanceFactor` so it scales with distance
- Styled as a cyberpunk speech bubble: dark background, neon border matching robot color, small triangle pointer at bottom
- Auto-dismiss after 4-6 seconds with fade-out
- Only one dialogue visible per robot at a time (latest wins)
- Queue rapid messages, show each briefly

### Dialogue Content by Event

| Session Event / Status | Dialogue Text | Style |
|----------------------|---------------|-------|
| `SessionStart` | `"ONLINE"` | Green border, fade in |
| `UserPromptSubmit` | First 60 chars of prompt + `"..."` | Cyan border |
| `PreToolUse` (Read) | `"Reading {filename}..."` | Dim cyan |
| `PreToolUse` (Bash) | `"$ {command}"` (first 40 chars) | Orange border |
| `PreToolUse` (Edit/Write) | `"Editing {filename}..."` | Blue border |
| `PreToolUse` (Task) | `"Spawning agent..."` | Purple border |
| `PreToolUse` (WebFetch) | `"Fetching {url}..."` | Cyan border |
| `PostToolUse` | (dismiss current bubble) | — |
| Status → `approval` | `"AWAITING APPROVAL"` | Yellow border, persistent, pulse |
| Status → `input` | `"NEEDS INPUT"` | Purple border, persistent, pulse |
| Status → `waiting` | `"Task complete!"` | Green border |
| `SessionEnd` | `"OFFLINE"` | Red border, fade out |

### Implementation

- New component: `src/components/3d/RobotDialogue.tsx`
- Receives dialogue queue from a new `dialogueStore` (or local state per robot)
- The `useWebSocket` hook dispatches dialogue events alongside session updates
- Dialogue state stored per sessionId: `{ text, borderColor, persistent, timestamp }`

---

## Workstream 4: Status-Driven Robot Visual Effects

**Goal:** Each session status is reflected through multiple visual channels on the robot — color, lighting, ground glow, and body animations are already partially there. Enhance with:

### A. Character Accent Color by CLI Source

| CLI Source | Base Accent | Robot Tint |
|------------|-------------|------------|
| Claude Code | `#00f0ff` (cyan) | Cool cyan/blue palette |
| Gemini CLI | `#4285f4` (Google blue) | Blue-white palette |
| Codex CLI | `#10a37f` (OpenAI green) | Green palette |
| OpenClaw | `#ff6b2b` (orange) | Warm orange palette |
| Unknown | `#aa66ff` (purple) | Purple palette |

The robot's neon material, visor, glow disc, and antenna tip should all use the CLI source accent color as the base, with status modifying the intensity/behavior.

### B. Ground Glow Circle Enhancement

Current: `glowDisc` at Y=0.01-0.13, single color.

Enhanced:
- **idle**: Gentle pulse, 60% opacity, accent color
- **prompting/thinking**: Ripple outward animation (expanding ring), accent color — visible under desk while seated
- **working**: Bright steady glow, slight rotation, accent color — visible under desk while seated
- **waiting**: Slow breathing pulse, green tint
- **approval**: Rapid yellow pulse, expanding/contracting, `#ffdd00`
- **input**: Slow purple orbit ring, `#aa66ff`
- **ended**: Fade to dark, shrink to nothing
- **connecting**: Boot-up expanding circle from 0 to full radius

### C. Alert Visual (Replaces Label Completion Alerts)

Instead of the current "Label Alerts" in settings (which use browser notifications), alerts should manifest as:

- **Pulsing glow ring** around the robot (ground level, ring geometry)
- Ring color = status color (yellow for approval, purple for input)
- Ring radius pulses between 1.0 and 1.8 units
- Emission intensity increases over time (urgency escalation)
- After 30s of approval state: ring starts flashing rapidly
- After 60s: ring becomes double-ring with particle trail

### D. Status Sound Effects (Per-CLI Configurable)

Each status transition triggers a sound. The sound set is configurable per CLI source:

```
Claude Code: {
  sessionStart: 'chime',
  approval: 'alarm',
  input: 'warble',
  working: 'click',
  ended: 'cascade',
  ...
}
Gemini CLI: {
  sessionStart: 'ding',
  approval: 'buzz',
  ...
}
```

---

## Workstream 5: Sound Settings Per-CLI Configuration

**Goal:** The SOUND tab in settings should be restructured to configure sounds per AI CLI independently.

### Current State (Broken)

`SoundSettings.tsx` has a hardcoded `SOUND_LIBRARY` that doesn't match `soundEngine.ts` actual sounds. Action names also don't match. The preview button is not wired up.

### Target Architecture

#### Settings Shape

```typescript
interface SoundSettings {
  enabled: boolean;
  volume: number;           // 0-1 master volume
  perCli: {
    [cliSource: string]: {  // 'claude', 'gemini', 'codex', 'openclaw'
      enabled: boolean;
      volume: number;       // 0-1 per-CLI volume multiplier
      actions: {
        [action in SoundAction]?: SoundName;
      };
    };
  };
}
```

#### Default CLI Configs

| CLI | Character | Sound Profile |
|-----|-----------|---------------|
| Claude Code | Precision, technical | Clean digital tones (chime, ping, click) |
| Gemini CLI | Warm, organic | Warmer sounds (ding, chirp, swoosh) |
| Codex CLI | Minimal, efficient | Short blips (blip, beep, click) |
| OpenClaw | Bold, energetic | Stronger sounds (buzz, fanfare, cascade) |

#### UI Layout (SoundSettings.tsx)

```
┌─────────────────────────────────────┐
│ [Master Volume Slider] [Enable All] │
├─────────────────────────────────────┤
│ CLI Tabs: [Claude] [Gemini] [Codex] [OpenClaw] │
├─────────────────────────────────────┤
│ Selected CLI: Claude Code           │
│ [Enable] [Volume: ████░░ 70%]       │
│                                     │
│ Session Events:                     │
│  Session Start    [chime    ▾] [▶]  │
│  Prompt Submit    [ping     ▾] [▶]  │
│  Task Complete    [fanfare  ▾] [▶]  │
│  Session End      [cascade  ▾] [▶]  │
│                                     │
│ Tool Sounds:                        │
│  Read/Grep/Glob   [click    ▾] [▶]  │
│  Write/Edit       [blip     ▾] [▶]  │
│  Bash             [buzz     ▾] [▶]  │
│  Web Fetch        [swoosh   ▾] [▶]  │
│  Task/Agent       [ding     ▾] [▶]  │
│                                     │
│ Alerts:                             │
│  Approval Needed  [alarm    ▾] [▶]  │
│  Input Needed     [chime    ▾] [▶]  │
│  Kill             [thud     ▾] [▶]  │
└─────────────────────────────────────┘
```

Each `[▶]` is a preview button that plays the selected sound.

#### Fix Mismatches

- Import `SoundName`, `SoundAction`, `DEFAULT_ACTION_SOUNDS`, `ACTION_LABELS`, `ACTION_CATEGORIES` directly from `soundEngine.ts` instead of local hardcoded lists
- Wire up preview: `soundEngine.preview(soundName)` method (new — plays sound regardless of enabled state)

---

## Workstream 6: Z-Index & Layering Fixes

**Goal:** Robot labels, room names, and dialogue bubbles must never cover DOM overlays (settings modal, detail panel).

### Strategy

1. **Room labels** → Moved to 3D `<Text>` (Workstream 2) — inherently behind DOM
2. **Robot labels** (`RobotLabel.tsx`) → Already uses `<Html>` with `zIndexRange={[0, 0]}` to prevent DOM overlay conflicts. If not set, add it.
3. **Robot dialogues** (new) → Use `<Html>` with `zIndexRange={[0, 0]}` and `style={{ zIndex: 1 }}`
4. **SceneOverlay** (HUD) → z-index 10 — keep as-is
5. **Detail Panel** → z-index 100 — keep as-is
6. **Settings Modal** → z-index 200+ — verify this is higher than all 3D Html elements

### drei `<Html>` Props

- `zIndexRange={[0, 0]}` — prevents drei from auto-managing z-index
- `style={{ pointerEvents: 'none' }}` — labels don't intercept clicks
- `occlude` prop — can optionally hide labels when behind geometry

---

## Workstream 7: Additional Enhancements (Ideas You May Have Missed)

### A. CLI Source Badge on Robot

Small icon/emblem on the robot's chest or antenna showing which AI CLI it belongs to:
- Claude: `C` in cyan circle
- Gemini: `G` in blue circle
- Codex: `X` in green circle
- OpenClaw: `O` in orange circle

Rendered as a small `<Text>` or `<Sprite>` attached to the robot mesh.

### B. Approval Urgency Escalation

The longer a robot stays in `approval` or `input` state, the more urgent its visual effects become:

| Duration | Visual Effect |
|----------|---------------|
| 0-15s | Yellow/purple glow, normal pulse |
| 15-30s | Faster pulse, brighter glow, ring expands |
| 30-60s | Rapid flash, double ring, subtle shake |
| 60s+ | Ring particles, visor flashing, sound alarm repeats |

### C. Tool-Specific Working Animations

When `working`, the robot's animation subtly changes based on which tool is active:
- `Read/Grep/Glob`: Head scanning left-right (reading)
- `Write/Edit`: Arms typing rapidly
- `Bash`: One arm extended (commanding)
- `WebFetch`: Antenna glowing brightly (receiving data)
- `Task`: Both arms raised (delegating)

This requires tracking `currentTool` on the session object and passing it to `Robot3DModel`.

### D. Team/Subagent Visual Connections

When a robot spawns a subagent (via Task tool), draw a faint laser-line from parent to child robot:
- Line color: parent's accent color at 30% opacity
- Animated dash pattern flowing from parent → child
- Line disappears when subagent session ends

Implementation: `<Line>` from drei, updated per frame.

### E. White Noise & Ambient Sound (Settings Feature)

A dedicated **Ambient** section in the SOUND settings tab for background audio while monitoring the Cyberdrome.

#### White Noise Presets

| Preset | Description |
|--------|-------------|
| Off | Silence (default) |
| Rain | Gentle rain ambience |
| Lo-fi Hum | Soft electronic low-frequency hum |
| Server Room | Data center fan/hum loop |
| Deep Space | Slow droning ambient pad |
| Coffee Shop | Muted chatter + clink sounds |

- Master toggle: on/off
- Volume slider (independent of sound effects volume)
- Loops seamlessly via Web Audio `AudioBufferSourceNode` with `loop: true`
- Generated procedurally via Web Audio oscillators + filters (no audio file downloads needed)

#### Room Activity Sound (toggle within Ambient section)

Layered on top of the white noise:
- **Toggle:** `[x] Room Activity Sounds`
- When enabled, each room emits a subtle electronic activity layer proportional to working robots:
  - 0 robots: silence
  - 1-2 working: soft keyclick undertone
  - 3-5 working: busier hum + occasional blips
  - 6+: full activity buzz
- Volume scales with camera distance to room (spatial audio via Web Audio panner)
- Can be enabled independently of white noise (e.g., room sounds on, white noise off)

#### UI Layout (inside SoundSettings.tsx, below per-CLI config)

```
┌─────────────────────────────────────┐
│ Ambient & White Noise               │
├─────────────────────────────────────┤
│ [x] Enable Ambient Audio            │
│ Volume: ████░░░░ 40%                │
│                                     │
│ Preset: [Server Room ▾]             │
│                                     │
│ [x] Room Activity Sounds            │
│ Room Volume: ██░░░░░░ 25%           │
└─────────────────────────────────────┘
```

#### Settings Shape Addition

```typescript
interface AmbientSettings {
  enabled: boolean;
  volume: number;           // 0-1
  preset: 'off' | 'rain' | 'lofi' | 'serverRoom' | 'deepSpace' | 'coffeeShop';
  roomSounds: boolean;      // room activity layer toggle
  roomVolume: number;       // 0-1
}
```

### F. Status Transition Particle Effects

When a robot changes status, emit a brief particle burst:
- `idle → working`: Small spark shower (upward)
- `working → waiting`: Confetti-like green particles
- `any → approval`: Yellow warning particles (outward ring)
- `any → ended`: Smoke/fade particles (downward)

Implementation: `@react-three/drei` `<Sparkles>` or custom `Points` geometry.

### G. Session Progress Timer

A small circular progress indicator on the robot's glow disc showing how long the current status has been active:
- Ring fills clockwise over time
- Resets on status change
- Useful for gauging how long approval has been pending

---

## Team Structure for Execution

### Agent Assignments

| Agent | Workstreams | Dependencies |
|-------|-------------|--------------|
| **rename-agent** | WS1 (Group→Room rename) | None — runs first |
| **desk-behavior-agent** | WS2.5 (Desk-Sitting for Prompting & Working) | After WS1 |
| **3d-labels-agent** | WS2 (Door Labels) + WS6 (Z-Index) | After WS1 |
| **dialogue-agent** | WS3 (Dialogue Popups) | After WS1 + WS2.5 (needs seated position for bubble placement) |
| **visual-fx-agent** | WS4 (Status Visuals) + WS7.B,C,F,G | After WS1 + WS2.5 (glow disc at desk) |
| **sound-agent** | WS5 (Sound Settings per-CLI) + WS4.D (Status Sounds) + WS7.E (White Noise & Ambient) | After WS1 |
| **polish-agent** | WS7.A,D (CLI Badge, Subagent Lines) | After WS1 |

### Execution Order

```
Phase 1: rename-agent (WS1) — all other agents blocked
Phase 2a: desk-behavior-agent (WS2.5) + 3d-labels-agent (WS2+6) + sound-agent (WS5) — in parallel
Phase 2b: dialogue-agent (WS3) + visual-fx-agent (WS4) + polish-agent (WS7) — after WS2.5 lands
Phase 3: Integration test — build + test + visual verification
```

---

## Verification Checklist

- [ ] `npx tsc --noEmit` — no type errors
- [ ] `npx vite build` — builds cleanly
- [ ] `npx vitest run` — all tests pass
- [ ] No "group" references remaining (except `groupBy` in settings)
- [ ] Room names visible at doorways (3D text on floor), not covering UI
- [ ] Robots walk to desk and sit when prompting or working
- [ ] Robots keep same desk through prompting → working transitions
- [ ] Robots stand up and wander when returning to idle/waiting
- [ ] Dialogue bubbles appear above seated/standing robots on status changes
- [ ] Dialogue bubbles show tool names, prompt snippets, status messages
- [ ] Robot glow/color reflects CLI source (cyan/blue/green/orange)
- [ ] Ground glow circle animates per-status (pulse, ripple, flash)
- [ ] Alert glow ring escalates urgency over 15s/30s/60s thresholds
- [ ] Sound settings show per-CLI tabs (Claude/Gemini/Codex/OpenClaw)
- [ ] Sound preview buttons play the selected sound
- [ ] Status transitions trigger per-CLI configurable sounds
- [ ] White noise presets play and loop seamlessly (rain, lo-fi, server room, etc.)
- [ ] White noise volume independent of sound effects volume
- [ ] Room activity sounds toggle on/off independently of white noise
- [ ] Room activity volume scales with camera distance
- [ ] Labels/dialogues don't cover settings or detail panel
- [ ] Approval urgency escalates visually over time
- [ ] Status transition particle effects fire on state changes
