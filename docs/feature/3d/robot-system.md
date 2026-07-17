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
| `src/components/3d/robotPositionStore.ts` | Two non-reactive registries: `robotPositionStore` (world position, plain Map) + `navInfoMap` (full nav state for persistence) |
| `src/lib/robot3DGeometry.ts` | 16-color neon palette, 10 body + 4 edge geometries, 2 base materials + 16 neon + 16 edge per-color material pools |
| `src/lib/robot3DModels.ts` | 6 model variants (robot, mech, drone, spider, orb, tank) with per-part overrides |
| `src/lib/robotStateMap.ts` | Session status -> robot state mapping (8 states) + per-state behavior hints (`getRobotStateBehavior`) |
| `src/lib/cliDetect.ts` | `detectCli()` -> `'claude' \| 'gemini' \| 'codex' \| null`; used by SessionRobot for CLI badge + accent color |
| `src/lib/robotPositionPersist.ts` | sessionStorage save/load/clear helpers (the 2s save interval itself lives in CyberdromeScene) |
| `src/components/layout/HeaderAgentStrip.tsx` | Compact top-strip session badges that reuse `detectCli()` for consistent Claude/Gemini/Codex (and Aider) labels. Room frames carry a collapse chevron (`roomStore.toggleCollapse`, persisted `room.collapsed`) that folds a room to a session-count pill — the same toggle and shared state as the [Session Detail Panel](../frontend/session-detail-panel.md) strip |

## Implementation

### Core Architecture: Ref-Based Animation

ALL per-robot state lives in refs, not React state:
- `navRef` (NavState) for movement/navigation
- `seatedRef` for seated state at desk
- `dialogueRef` for speech bubble content

No `useState` is used in the render loop. This is critical for performance -- React state updates in `useFrame` cause full component re-renders at 60fps.

### Memoization Strategy

`SessionRobot` is wrapped in `React.memo` with a 21-field custom equality check covering session fields (sessionId, status, accentColor, colorIndex, model, currentPrompt, pendingTool, characterModel, title, projectName, toolLog.length, events.length) and prop fields (sceneBound, onSelect, workstations, wallRects, rooms, doors, roomIndex, globalCharacterModel, fontSize). This prevents re-renders when unrelated session data changes (e.g., another session's status update). (The `label` field is no longer part of the comparator.)

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

Mode transitions are driven by robot state: thinking/working triggers desk seeking (`NAV_GOTO` then `NAV_SIT`), idle/waiting triggers coffee-workstation (zone `-2`) seeking (`NAV_GOTO` then `NAV_SIT`), alert/input freezes in place (`NAV_IDLE` if standing, stays `NAV_SIT` if seated), offline/connecting triggers stationary (`NAV_IDLE`). Desk selection is zone-aware: a robot with a `roomIndex` seeks unoccupied desks in its room zone, an unassigned robot prefers corridor desks (zone `-1`), and when all candidate desks are full it stands behind the nearest occupied desk (overflow). Per-state behavior hints come from `getRobotStateBehavior()` in `robotStateMap.ts` (`seekDesk`, `wander`, `urgentFlash`, `visorColorOverride`, `speedMultiplier`, `casualTarget: 'coffee' | null`); `speedMultiplier` scales walk speed (working 1.2x, waiting 0.6x, alert/input/offline/connecting 0).

> Only `seekDesk` (`SessionRobot.tsx:404`) and `speedMultiplier` (`SessionRobot.tsx:366`) are actually consumed — `wander`, `urgentFlash`, `visorColorOverride` and `casualTarget` are declared on `RobotStateBehavior` but read by nothing. The behaviours they name are hardcoded elsewhere: coffee seeking is an `idle`/`waiting` check plus a `ws.zone === -2` filter in `SessionRobot`, the visor override is the material switch in `Robot3DModel`, and alert flashing lives in `animateAlert`. `wander` is `false` for all 8 states.

### Robot States (8 Total)
`sessionStatusToRobotState()` (in `robotStateMap.ts`) maps each `SessionStatus` to one `Robot3DState`:

| Robot State | Source SessionStatus | Animation | Visual |
|-------------|----------------------|-----------|--------|
| `idle` | `idle` | Subtle breathing oscillation | Normal colors |
| `thinking` | `prompting` | Chin-scratch / head-tilt at desk (seated) or head-bob (standing) | Session neon color (no state override) |
| `working` | `working` | Tool-specific working motion + charging body effect | Session neon color (no state override) |
| `waiting` | `waiting` | Hopping standing pose | Session neon color (no state override) |
| `alert` | `approval` | Flashing visor + body shake | Yellow visor (#ffdd00) |
| `input` | `input` | Raised-arm oscillation | Purple visor (#aa66ff) |
| `offline` | `ended` | Slumped, glow decays to 0 | Desaturated visor (#333344) |
| `connecting` | `connecting` | 1.5s boot-up scale-in animation | Scale ramps from 0 |

### Model Variants (6 Total)
All variants hover (`hovers: true`) and share the same skeletal structure with per-part geometry/position overrides. Legs are hidden on every variant (`legL`/`legR` `visible: false`) — robots float; leg refs still exist for animation but render nothing. Descriptions below are the `description` strings from `robot3DModels.ts`, with clarifying notes in parentheses.

| Variant | Description | baseY |
|---------|-------------|-------|
| `robot` | Standard humanoid robot (default) | 0.2 |
| `mech` | Bulkier torso, wider stance, angular head | 0.2 |
| `drone` | Smaller hovering unit with antenna array | 0.3 |
| `spider` | Low body with 4 stubby legs (forward-mounted head) | 0.05 |
| `orb` | Spherical body with stubby arms and short legs | 0.2 |
| `tank` | Wide body with one thick arm, treads for legs | 0.15 |

Public API: `ROBOT_MODEL_TYPES` (ordered list), `getModelDef()`, `getModelLabel()`, `getModelDescription()`.

### Shared Resources for Rendering
- 16-color neon palette (`PALETTE`) shared across all robots
- 10 shared body geometries in `robotGeo` (head, visor, antenna, aTip, torso, core, joint, arm, leg, foot)
- 4 shared edge geometries in `robotEdgeGeo` (head, torso, arm, leg)
- 2 shared base materials: `metalMat` (body, #2a2a3e), `darkMat` (joints/limbs, #1c1c2c)
- Pre-built per-palette pools: 16 neon materials (`neonMats`) + 16 edge materials (`edgeMats`); a robot whose color is not in the palette falls back to `createNeonMat()`/`createEdgeMat()` (disposed on unmount)
- 3 static visor override materials: `ALERT_VISOR_MAT` (#ffdd00), `INPUT_VISOR_MAT` (#aa66ff), `OFFLINE_VISOR_MAT` (#333344)
- Per-robot cloned body materials (`bodyMat`, `bodyEdgeMat`) to avoid cross-contamination during animation
- Per-robot `EdgesGeometry` instances are built per part and disposed on unmount (#50, #88); edge geometry is skipped for invisible parts (legs)

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

> `<filename>` comes from `extractFilename()`, whose path regex is Unicode-aware (`/…/u`), so non-English filenames (CJK, Cyrillic, …) display correctly instead of collapsing to a parent directory name.
- Task -> "Spawning agent..."
- WebFetch/WebSearch -> "Fetching..."

**Prompt-changed** while already `prompting` -> updated prompt text.

Throttled to minimum 500ms between tool-related updates to prevent bubble spam. Non-persistent dialogues auto-fade after 5 seconds.

### RobotLabel (WebGL)
- drei `Billboard` + `Text` for pure WebGL rendering (no HTML portals)
- 8-field equality memoization (sessionId, status, title, projectName, robotState, isSelected, isHovered, fontSize)
- `isSelected` / `isHovered` are currently **inert** — `RobotLabelInner` never reads them, `SessionRobot` hardcodes `isSelected = false` (`SessionRobot.tsx:115`), and `isHovered` is read from a ref that can't trigger a re-render. The label has no selection/hover state today; the two props survive only in the memo comparator.
- Displays a status dot + a single title line (`session.title || session.projectName || 'Unnamed'`, truncated at 28 chars). There is no separate label badge.
- Alert banner with pulsing opacity above the panel: "APPROVAL NEEDED" (alert) / "INPUT NEEDED" (input)
- All dimensions scale with the Font Size setting (`scale = fontSize / BASE_FONT`, `BASE_FONT = 13`)

### Position Persistence
- `robotPositionPersist.ts` exposes `saveRobotPositions()`, `loadRobotPositions()`, and `clearPersistedPosition()` against `sessionStorage` key `cyberdrome-robot-positions`. The 2-second save interval itself runs in `CyberdromeScene.tsx`, which reads `getAllNavInfo()` and writes the snapshot.
- Persisted shape (`PersistedRobotState`): `posX`, `posZ`, `rotY`, `mode` (NAV_WALK=0, NAV_GOTO=1, NAV_SIT=2, NAV_IDLE=3), `deskIdx` (workstation index or -1)
- On restore (in `SessionRobot`): `NAV_GOTO` is reset to `NAV_WALK` to prevent stale target seeking; `NAV_SIT` robots reclaim their workstation on first mount

### robotPositionStore
Two registries in `robotPositionStore.ts`, both plain `Map`s (NOT Zustand) so they never trigger Canvas re-renders:
- `robotPositionStore` — `set`/`get`/`delete`/`has` over `{x, y, z}` world positions; written every 3rd frame by `SessionRobot` (y offset +1.0 for beam endpoints) and read by `SubagentConnections` / camera fly-to
- `navInfoMap` — `updateNavInfo`/`getNavInfo`/`getAllNavInfo`/`removeNavInfo` over full `StoredNavInfo` (`x, y, z, rotY, mode, deskIdx`); drained by CyberdromeScene's 2s persistence loop

### Imperative Settings Access
`Robot3DModel` reads `useSettingsStore.getState()` imperatively inside `useFrame` to access `animationSpeed` and `animationIntensity` settings. This avoids subscribing to the store reactively (which would cause cross-reconciler issues inside Canvas).

### Special Behaviors
- CLI badge: detects CLI type via `detectCli()`, preferring explicit `session.cliSource`, then startup/SSH command text, then model string, then event-type fallback. `detectCli()` returns only `'claude' | 'gemini' | 'codex' | null`. The chest badge (`CLI_BADGES` in SessionRobot) renders: C (Claude, #00f0ff), G (Gemini, #4285f4), X (Codex, #10a37f), or ? (unknown/null, #aa66ff). HeaderAgentStrip reuses the same helper for its mini-strip labels (and additionally surfaces AIDER via command/`backendType` heuristics) so labels and 3D badges stay aligned.
- CLI accent color: when no explicit `accentColor` is set, the robot's neon color is overridden by the CLI badge color (`cliNeonColor`)
- Tool-specific working animations (WS7.C, via `classifyTool`): read — head scanning (Read/Grep/Glob/NotebookEdit), write — rapid arm typing (Write/Edit), bash — one arm extended (Bash), task — both arms raised (Task), web — brighter antenna (WebFetch/WebSearch), default — standard typing (everything else)
- Alert urgency escalation (WS7.B), keyed off `statusStartTime`: pulse speed rises after 15s (8→12); after 30s the visor base intensity rises (1.5→2.5), the pulse range widens (1.0→1.5), and the standing body shake intensifies (`t*12` x0.02 → `t*16` x0.03). Only standing robots shake — the seated branch has no shake.

## Dependencies & Connections

### Depends On
- [Cyberdrome Scene](./cyberdrome-scene.md) -- renders SessionRobot per session, provides room/workstation/wall/door data as props, runs the 2s position-persistence loop
- [State Management](../frontend/state-management.md) -- session data drives robot state; `roomStore` assignment drives navigation (HeaderAgentStrip groups by room)
- [Settings System](../frontend/settings-system.md) -- `animationSpeed`/`animationIntensity` read imperatively in `Robot3DModel`, Font Size scales `RobotLabel`, global + per-session `characterModel` select the variant
- [Server Session Management](../server/session-management.md) -- session status drives robot state transitions

### Depended On By
- [Cyberdrome Scene](./cyberdrome-scene.md) -- robot positions used for camera fly-to targeting
- [Particles & Effects](./particles-effects.md) -- SubagentConnections + StatusParticles read from robotPositionStore / robot state for beam endpoints
- [Sound & Alarm System](../multimedia/sound-alarm-system.md) -- `alarmEngine` reuses `detectCli()` for per-CLI sound profiles

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
