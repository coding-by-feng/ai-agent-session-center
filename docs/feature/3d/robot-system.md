# Robot Characters & Navigation AI

## Function
Animated 3D robot characters representing sessions, with navigation AI (desk seeking, casual wandering, pathfinding), 8 animation states, 6 model variants, and ref-based rendering.

## Purpose
Each session needs a visual avatar that communicates status through animation (working=running, idle=breathing, approval=flashing) and position (at desk=working, wandering=idle).

## Source Files
| File | Role |
|------|------|
| `src/components/3d/SessionRobot.tsx` | Per-session robot: navigation AI, desk seeking, dialogue, CLI badge, position persistence |
| `src/components/3d/Robot3DModel.tsx` | Mesh + animation: 8 state animations, tool-specific working variants, charging effect, label frame effects |
| `src/components/3d/RobotDialogue.tsx` | Floating speech bubbles (ref-based, no React state) |
| `src/components/3d/RobotLabel.tsx` | WebGL floating name plates (drei Billboard + Text, no HTML) |
| `src/components/3d/robotPositionStore.ts` | Non-reactive position registry (plain Map) |
| `src/lib/robot3DGeometry.ts` | 16-color neon palette, 10 body + 4 edge geometries, 2 base + 32 per-color materials |
| `src/lib/robot3DModels.ts` | 6 model variants (robot, mech, drone, spider, orb, tank) with per-part overrides |
| `src/lib/robotStateMap.ts` | Session status to robot state mapping (8 states) |
| `src/lib/cliDetect.ts` | `detectCli()` used by SessionRobot for CLI badge rendering |
| `src/lib/robotPositionPersist.ts` | sessionStorage persistence every 2s |

## Implementation

### Core Architecture: Ref-Based Animation

ALL per-robot state lives in refs, not React state:
- `navRef` (NavState) for movement/navigation
- `seatedRef` for seated state at desk
- `dialogueRef` for speech bubble content

No `useState` is used in the render loop. This is critical for performance -- React state updates in `useFrame` cause full component re-renders at 60fps.

### Memoization Strategy

`SessionRobot` is wrapped in `React.memo` with a 22-field custom equality check covering session fields (sessionId, status, accentColor, colorIndex, model, currentPrompt, pendingTool, label, characterModel, title, projectName, toolLog.length, events.length) and prop fields (sceneBound, onSelect, workstations, wallRects, rooms, doors, roomIndex, globalCharacterModel, fontSize). This prevents re-renders when unrelated session data changes (e.g., another session's status update).

### Frame Throttling

Navigation AI updates every 3rd frame per robot:
- Random `navFrameOffset` (0-2) staggers collision checks across robots
- Delta is multiplied by 3 to maintain consistent movement speed despite reduced update frequency
- Position store writes also throttled to every 3rd frame

### Navigation Modes
| Mode | Value | Behavior |
|------|-------|----------|
| `NAV_WALK` | 0 | Casual wandering within room bounds or corridor |
| `NAV_GOTO` | 1 | Moving toward a specific target (desk, room position) via waypoints |
| `NAV_SIT` | 2 | Seated at a desk (Y offset -0.12, rotation locked to desk facing direction) |
| `NAV_IDLE` | 3 | Stationary, no movement updates |

Mode transitions are driven by robot state: thinking/working triggers desk seeking (`NAV_GOTO` then `NAV_SIT`), idle/waiting triggers coffee lounge seeking (`NAV_GOTO` then `NAV_SIT`), alert/input freezes in place (`NAV_IDLE` if standing, stays `NAV_SIT` if seated), offline/connecting triggers stationary (`NAV_IDLE`).

### Robot States (8 Total)
| State | Animation | Visual |
|-------|-----------|--------|
| `idle` | Subtle breathing oscillation | Normal colors |
| `thinking` | Typing motion at desk | Cyan accents |
| `working` | Running animation | Orange accents |
| `waiting` | Standing pose | Green accents |
| `alert` | Flashing body | Yellow/red pulsing |
| `input` | Arm oscillation | Purple accents |
| `offline` | Dimmed, no animation | Desaturated colors |
| `connecting` | Boot-up scale animation | Flickering |

### Model Variants (6 Total)
All variants hover (`hovers: true`) and use the same skeletal structure with per-part geometry/position overrides.

| Variant | Description | baseY |
|---------|-------------|-------|
| `robot` | Standard humanoid (default) | 0.2 |
| `mech` | Bulkier torso, wider stance, angular head | 0.2 |
| `drone` | Smaller hovering unit with antenna-like arms | 0.3 |
| `spider` | Low body with forward-mounted head (legs hidden) | 0.05 |
| `orb` | Spherical torso with stubby arms | 0.2 |
| `tank` | Wide body with one thick arm, treads for legs | 0.15 |

### Shared Resources for Rendering
- 16-color neon palette (`PALETTE`) shared across all robots
- 10 shared body geometries in `robotGeo` (head, visor, antenna, aTip, torso, core, joint, arm, leg, foot)
- 4 shared edge geometries in `robotEdgeGeo` (head, torso, arm, leg)
- 2 shared base materials: `metalMat` (body), `darkMat` (joints)
- 16 pre-built neon material pool (`neonMats`) + 16 edge material pool (`edgeMats`)
- 3 static visor override materials: `ALERT_VISOR_MAT` (#ffdd00), `INPUT_VISOR_MAT` (#aa66ff), `OFFLINE_VISOR_MAT` (#333344)
- Per-robot cloned body materials (bodyMat, bodyEdgeMat) to avoid cross-contamination during animation

### Dialogue System

Ref-based (`dialogueRef`) -- zero React state. `RobotDialogue` reads from parent ref in useFrame.

**Status-based dialogues** (highest priority):
- `prompting` -> truncated prompt text (60 chars max, cyan border)
- `approval` -> "AWAITING APPROVAL" (yellow, persistent)
- `input` -> "NEEDS INPUT" (purple, persistent)
- `waiting` -> "Task complete!" (green, auto-fade after 5s)
- `ended` -> "OFFLINE" (red, auto-fade)
- `idle` (from non-idle/non-connecting) -> "ONLINE" (green, auto-fade)

**Tool-based dialogues** (when status unchanged):
- Read/Grep/Glob -> "Reading <filename>..."
- Bash -> "$ <command>" (40 char max)
- Edit/Write -> "Editing <filename>..."
- Task -> "Spawning agent..."
- WebFetch/WebSearch -> "Fetching..."

**Prompt-changed** while already `prompting` -> updated prompt text.

Throttled to minimum 500ms between tool-related updates to prevent bubble spam. Non-persistent dialogues auto-fade after 5 seconds.

### RobotLabel (WebGL)
- drei `Billboard` + `Text` for pure WebGL rendering (no HTML portals)
- 9-field equality memoization
- Displays: status dot + project name + optional label badge
- Alert banner with pulsing opacity for approval/input states

### Position Persistence
- Writes to `sessionStorage` (key: `cyberdrome-robot-positions`) every 2 seconds via `robotPositionPersist.ts`
- Persists: `posX`, `posZ`, `rotY`, `mode` (NAV_WALK=0, NAV_GOTO=1, NAV_SIT=2, NAV_IDLE=3), `deskIdx`
- On restore: `NAV_GOTO` is reset to `NAV_WALK` to prevent stale target seeking; `NAV_SIT` robots reclaim their workstation on mount

### robotPositionStore
- Plain object with `set`/`get`/`delete`/`has` methods wrapping an internal `Map` (NOT a Zustand store) for sharing positions between `SubagentConnections` and camera fly-to
- Must remain non-reactive to avoid triggering Canvas re-renders

### Imperative Settings Access
`Robot3DModel` reads `useSettingsStore.getState()` imperatively inside `useFrame` to access `animationSpeed` and `animationIntensity` settings. This avoids subscribing to the store reactively (which would cause cross-reconciler issues inside Canvas).

### Special Behaviors
- CLI badge: detects CLI type from model string + event types via `detectCli()`, renders badge on the robot chest: C (Claude, cyan), G (Gemini, blue), X (Codex, green), O (OpenClaw, orange), ? (unknown, purple)
- CLI accent color: when no explicit `accentColor` is set, the robot's neon color is overridden by the CLI badge color
- Tool-specific working animations (WS7.C): read (head scanning), write (rapid arm typing), bash (arm extended), task (both arms raised), web (brighter antenna), default (standard typing)
- Alert urgency escalation (WS7.B): after 15s visor pulses faster, after 30s visor intensity + body shake increase

## Dependencies & Connections

### Depends On
- [Cyberdrome Scene](./cyberdrome-scene.md) -- renders SessionRobot per session, provides room/workstation/wall data as props
- [State Management](../frontend/state-management.md) -- session data, characterModel from settingsStore (via props from DOM layer)
- [Server Session Management](../server/session-management.md) -- session status drives robot state transitions

### Depended On By
- [Cyberdrome Scene](./cyberdrome-scene.md) -- robot positions used for camera fly-to targeting
- [Particles & Effects](./particles-effects.md) -- SubagentConnections reads from robotPositionStore for beam endpoints

### Shared Resources
- `robotPositionStore` (plain Map, read/write)
- Shared geometries and materials from `robot3DGeometry.ts` (read-only after initialization)
- `sessionStorage` for position persistence

## Change Risks
- Using `useState` in `Robot3DModel` causes performance cascade -- ALL animation must be ref-based.
- Changing shared geometries/materials in `robot3DGeometry.ts` affects ALL robots simultaneously.
- Breaking frame throttling (removing every-3rd-frame logic) causes 3x performance cost.
- `robotPositionStore` MUST NOT be converted to a Zustand store -- doing so causes Canvas re-renders via cross-reconciler subscription.
- Changing navigation mode logic affects desk seeking behavior and can cause robots to get stuck.
- `RobotLabel` using HTML portals instead of WebGL `Text` causes cross-reconciler cascades (React Error #185).
- Custom equality check in `React.memo` must be updated when new props are added to `SessionRobot`, or stale rendering occurs.
