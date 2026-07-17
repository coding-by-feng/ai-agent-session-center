# 3D Cyberdrome Scene & Layout

## Function
Interactive 3D office environment rendered with React Three Fiber (R3F) where each session is a navigating robot character in a room-based layout.

## Purpose
Visual representation of all active AI sessions. Users can see at a glance which sessions are active, working, or need attention by observing robot animations and positions.

## Source Files
| File | Role |
|------|------|
| `src/components/3d/CyberdromeScene.tsx` | DOM-side orchestrator: all Zustand subscriptions, CustomEvent bridge, precomputed props for Canvas, MapControls overlay |
| `src/components/3d/CyberdromeEnvironment.tsx` | Floor grid, room walls/desks/chairs, coffee lounge, particles, stars, lighting (all theme-driven) |
| `src/components/3d/CameraController.tsx` | Smooth fly-to animation via LERP inside Canvas |
| `src/components/3d/RoomLabels.tsx` | 3D text floating above room centers + coffee-lounge label |
| `src/components/3d/SceneOverlay.tsx` | Bottom-right HUD panel (units online, mute toggle, 3D on/off toggle, room-management panel) |
| `src/components/3d/RobotListSidebar.tsx` | DOM agent list panel (top-left), grouped by room, sorted pinned-then-status, searchable, per-row pin + close |
| `src/lib/cyberdromeScene.ts` (517 lines) | Layout constants, room grid math, workstation placement, collision helpers (currently fed an empty rect list), pathfinding |
| `src/lib/sceneThemes.ts` | 9 theme palettes for 3D scene (36 `Scene3DTheme` properties each) |
| `src/lib/robotPositionPersist.ts` | sessionStorage persistence of robot positions (`saveRobotPositions` / `loadRobotPositions`) |
| `src/lib/sessionSort.ts` | `sortSessions` + `STATUS_ORDER` — shared sidebar ordering (pinned first, then status, then title) |
| `src/lib/pinnedRespawn.ts` | `markUserClosing` — flags a pinned session's death as intentional so it is not auto-respawned |
| `src/stores/cameraStore.ts` | Camera fly-to state (`pendingTarget`, `isAnimating`, `DEFAULT_CAMERA_POSITION/TARGET`) |
| `src/stores/roomStore.ts` | Room management (localStorage persistence under `session-rooms`) |

## Implementation

### Core Architecture: Zero Zustand Inside Canvas

All Zustand store subscriptions live in the DOM-side `CyberdromeScene.tsx`. Data flows into the R3F Canvas exclusively via props. This prevents React Error #185 (cross-reconciler cascade) where the DOM reconciler and R3F reconciler interfere with each other.

### CustomEvent Bridge Pattern

Robot click handling uses a decoupled event pattern:
1. Robot `onSelect(sessionId)` fires inside Canvas
2. Dispatches `CustomEvent('robot-select')` with `setTimeout(0)` to escape the R3F render cycle
3. DOM-side `useEffect` listener receives the event
4. Calls `selectSession()` + `flyTo()` on Zustand stores

The `setTimeout(0)` is critical -- without it, the store update occurs during the R3F render pass, causing cascading renders.

### Canvas Configuration
- Camera position: `[18, 16, 18]`, FOV 50, near 0.1, far 150
- Shadow map: `PCFSoftShadowMap`
- Tone mapping: `ACESFilmicToneMapping`, exposure 1.2, antialiasing enabled
- Fog: `FogExp2` with density varying by theme (default 0.008)
- OrbitControls: damping 0.06, maxPolar `PI/2.1` (prevents going below floor), min distance 6, max 80, target `[0, 1, 0]`

### Camera Controller
- LERP factor: 0.04 for smooth interpolation
- Arrival threshold: 0.1 units
- Idle polling: every 6th frame to reduce overhead
- Animation completion: `completeAnimation()` via `queueMicrotask` (direct store update in `useFrame` causes cascading renders)
- Fly-to offset: `[+6, +8, +10]` from robot position

### Scene Theme Sync
Imperative update of `scene.fog` color/density and `gl.clearColor` on theme change. No React re-render triggered -- uses direct Three.js API calls.

### Room Layout
- Dynamic grid system: rooms placed in rows of up to `ROOM_COLS=4`, wrapping to new rows as rooms are added
- Constants: `ROOM_SIZE=8`, `ROOM_GAP=2`, `ROOM_CELL=10`, `WALL_H=2.0`, `WALL_T=0.08`, `DOOR_GAP=1.5`
- Coffee lounge placed NORTH of all rooms; corridor/common area desks placed SOUTH of all rooms
- Each room has 10 desks (5 rows x 2 facing each other), walls with doorways on north/south sides
- Room zoom: `computeRoomCameraTarget()` places camera at 45-degree angle, 14 units out, 10 units high
- Pathfinding: `computePathWaypoints()` routes robots through door waypoints when moving between rooms
- Walls are **visual only** — `CyberdromeScene` passes an empty `wallRects` array ("Walls removed for performance"), so `collidesAnyWall()` never blocks movement and robots walk through walls. `buildDynamicWallRects()` still exists in `cyberdromeScene.ts` but is currently called from nowhere.

### MapControls
- Bottom-left DOM overlay (`zIndex: 11`), defined inside `CyberdromeScene.tsx`, with zoom in/out, top-down view, and reset view buttons
- Zoom uses `flyTo()` with a distance factor applied to the camera-to-target vector: `0.65` for zoom in, `1.5` for zoom out
- Top-down places camera `+30` units above current target (with a tiny `±0.01` X/Z offset so OrbitControls keeps a valid orientation)
- Reset returns to `[18, 16, 18]` looking at `[0, 1, 0]` — note MapControls hardcodes these literals; the matching `DEFAULT_CAMERA_POSITION` / `DEFAULT_CAMERA_TARGET` constants in `cameraStore.ts` are used only by `SceneOverlay`'s room-panel Overview button

### RobotListSidebar
- Top-left panel (`top:16, left:20`), 280px wide expanded / `auto` when collapsed, backdrop blur, collapsible header ("Agents (N)"). Hidden entirely when there are zero sessions.
- Searchable via the shared `SearchInput` primitive with 150ms debounce (matches title, project name, status). Floating PiP popups (`session.isFloating`) are filtered out, same as the 3D scene; clone/fork sessions (`isFork` only) are listed.
- Sessions grouped by room (rooms sorted by `roomIndex`, only rooms with `roomIndex != null`); unassigned sessions fall into a "Common Area" group. Per-group collapse state lives in a local `collapsedGroups` Set.
- Within each group, ordered by `sortSessions` (`sessionSort.ts`): **pinned first**, then status priority via `STATUS_ORDER` (working 0 > prompting 1 > approval/input 2 > waiting 3 > idle 4 > connecting 5 > ended 6), then title (localeCompare).
- Each row has **two action affordances**: a pin toggle and a close button (titles are read-only — rename UI lives in the detail panel).
  - **Pin** (`onTogglePin` → `sessionStore.togglePin`): pinned sessions float to the top of their group, get a left accent bar, and auto-recreate on restart / if they die.
  - **Close** (`handleClose`): if the session is pinned, prompts a `window.confirm`, and on confirm calls `markUserClosing(session)` (`pinnedRespawn.ts`, so the death isn't treated as a crash) then unpins it; in all cases POSTs `/api/sessions/:id/kill` with body `{ confirm: true }` then calls `removeSession`.
- Rows for `approval`/`input` status pulse (`sidebarApprovalPulse` animation) to flag sessions needing attention.

### RoomLabels
- drei `<Text>` with SDF rendering, flat horizontal rotation (`-PI/2` on X axis, readable from above)
- Room labels: name (uppercase, fontSize 0.7) at Y=2.8; below it a unit count rendered as "N UNIT" / "N UNITS" (fontSize 0.35) at Y=2.8, `cz + 1.0`. Count excludes `ended` sessions.
- Strip color (and label color) alternates cyan (`#00f0ff`) / magenta (`#ff00aa`) by room-index parity (`STRIP_COLORS`), with dimmer hex variants for the unit-count text (`STRIP_COLORS_DIM`)
- Coffee lounge label: "COFFEE LOUNGE" in orange (`#ff9944`), fontSize 0.8

### Scene Themes
9 theme palettes with 36 color/density/lighting properties each (command-center, cyberpunk, warm, dracula, solarized, nord, monokai, light, blonde).

### Session Filtering
Sessions are rendered as robots only when `status !== 'ended'` AND `source === 'ssh'` AND they are NOT floating popups (`!session.isFloating`). This keeps the scene to terminal-launched sessions; Explain/Translate floating popups have their own PiP UI and are excluded here (and likewise from `RobotListSidebar`). Clone/fork sessions set `isFork` without `isFloating` and DO get robots/rows.

`RobotListSidebar` does **not** apply the `source === 'ssh'` filter — it excludes only `ended` and `isFloating` sessions. Non-ssh (hook-only) sessions therefore appear as sidebar rows with no robot, and "Agents (N)" can exceed `SceneOverlay`'s "Units Online" (which counts the ssh-filtered `sessionArray`).

### Robot Position Persistence
`CyberdromeScene` runs a `setInterval` every **2000ms** that reads `getAllNavInfo()` from `robotPositionStore` and calls `saveRobotPositions()` (`robotPositionPersist.ts`), persisting `posX/posZ/rotY/mode/deskIdx` per session to `sessionStorage['cyberdrome-robot-positions']` so robots resume their spots across page reloads. `loadRobotPositions()` reads it back on robot mount.

### Store Dependencies
`CyberdromeScene` reads `sessions`/`selectSession` (sessionStore), `rooms` (roomStore), `themeName`/`characterModel`/`fontSize` (settingsStore), and `flyTo` (cameraStore) in the DOM layer. `RobotListSidebar` additionally reads `selectedSessionId`/`removeSession`/`togglePin` (sessionStore), `rooms` (roomStore), and `detailPanelMinimized`/`restoreDetailPanel` (uiStore). `SceneOverlay` reads `soundSettings`/`scene3dEnabled` (settingsStore), `sessions` (sessionStore, for `RoomPanel`'s per-room active-count badge), plus room CRUD actions (roomStore) and `flyTo` (cameraStore). ALL Canvas-side components (`SceneContent`, `CameraController`, `SceneThemeSync`, `RoomLabels`, etc.) use zero store subscriptions — props only, or imperative `getState()` reads where necessary (`CameraController` polls `cameraStore.getState()` in `useFrame`).

## Dependencies & Connections

### Depends On
- [State Management](../frontend/state-management.md) -- sessionStore (sessions, selectSession, removeSession, togglePin), roomStore (rooms + CRUD), settingsStore (theme, characterModel, fontSize, sound/scene3d toggles), cameraStore (fly-to), uiStore (detailPanelMinimized/restore)
- [Robot System](./robot-system.md) -- SessionRobot rendered per session inside Canvas
- [Particles & Effects](./particles-effects.md) -- StatusParticles rendered per-robot inside SessionRobot (not at scene level), SubagentConnections rendered inside Canvas
- [UI Primitives](../frontend/ui-primitives.md) -- `RobotListSidebar` uses the shared `SearchInput` (debounced) primitive
- [Floating Terminal Fork](../frontend/floating-terminal-fork.md) -- floating popups (`isFloating`) are excluded from both the 3D scene and the sidebar

### Depended On By
- [Views/Routing](../frontend/views-routing.md) -- LiveView renders CyberdromeScene
- [Session Detail Panel](../frontend/session-detail-panel.md) -- robot/sidebar click triggers panel open (and restores it if minimized)
- [Settings System](../frontend/settings-system.md) -- theme changes update scene visuals; `scene3dEnabled` toggle mounts/unmounts the scene

### Shared Resources
- Three.js Canvas (single instance, shared by all 3D components)
- `robotPositionStore` (plain object with `set`/`get`/`delete`/`has` methods wrapping an internal Map, for non-reactive position sharing between robots and camera)
- `sessionStorage['cyberdrome-robot-positions']` for position persistence across page reloads

## Change Risks
- Adding Zustand subscriptions inside Canvas causes React Error #185 (cross-reconciler cascade). All store reads must remain in the DOM layer.
- Changing CustomEvent timing (removing `setTimeout(0)`) causes store update during R3F render pass.
- CameraController `queueMicrotask` is critical -- direct store update in `useFrame` causes cascading renders.
- Changing room layout constants in `cyberdromeScene.ts` affects all robot navigation paths and workstation placement.
- Scene theme changes must update both 3D fog/lighting and CSS theme variables in sync.
- OrbitControls `maxPolar` prevents camera from going below the floor -- relaxing this breaks the visual.
- The floating-exclusion filter (`isFloating`) must stay aligned across `CyberdromeScene`, `RobotListSidebar`, and `HeaderAgentStrip`; dropping it in one place makes floating popups appear as duplicate robots/rows. Do NOT filter on `isFork` — clone/fork sessions carry it and must stay visible.
- Closing a pinned session must `markUserClosing` + unpin before killing, or `pinnedRespawn` will treat the death as a crash and immediately recreate it.
- `Scene3DTheme` has exactly 36 properties — every theme palette must define all of them or the scene renders with `undefined` colors.
