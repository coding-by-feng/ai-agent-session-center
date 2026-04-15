# 3D Cyberdrome Scene & Layout

## Function
Interactive 3D office environment rendered with React Three Fiber (R3F) where each session is a navigating robot character in a room-based layout.

## Purpose
Visual representation of all active AI sessions. Users can see at a glance which sessions are active, working, or need attention by observing robot animations and positions.

## Source Files
| File | Role |
|------|------|
| `src/components/3d/CyberdromeScene.tsx` | DOM-side orchestrator: all Zustand subscriptions, CustomEvent bridge, precomputed props for Canvas |
| `src/components/3d/CyberdromeEnvironment.tsx` | Floor grid, walls, desks, lighting, coffee lounge, particles, stars |
| `src/components/3d/CameraController.tsx` | Smooth fly-to animation via LERP inside Canvas |
| `src/components/3d/RoomLabels.tsx` | 3D text floating above room centers + casual area labels |
| `src/components/3d/SceneOverlay.tsx` | HUD overlay (units online, mute toggle, 3D on/off toggle, room management) |
| `src/components/3d/RobotListSidebar.tsx` | DOM agent list panel (top-left), sorted by status priority, searchable |
| `src/lib/cyberdromeScene.ts` (~17KB) | Layout constants, room grid math, workstation placement, collision, pathfinding |
| `src/lib/sceneThemes.ts` | 9 theme palettes for 3D scene (36 properties each) |
| `src/stores/cameraStore.ts` | Camera fly-to state (pendingTarget, isAnimating) |
| `src/stores/roomStore.ts` | Room management (localStorage persistence) |

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

### MapControls
- Bottom-left DOM overlay with zoom in/out, top-down view, and reset view buttons
- Zoom uses `flyTo()` with distance factor (0.65 for in, 1.5 for out)
- Top-down places camera 30 units above current target
- Reset returns to default position `[18, 16, 18]` looking at `[0, 1, 0]`

### RobotListSidebar
- 280px panel width with backdrop blur, collapsible panel header
- Searchable with 150ms debounce (searches title, label, project, status)
- Sessions grouped by room (sorted by roomIndex), unassigned sessions in "Common Area"
- Sorted by status priority: working(0) > prompting(1) > approval/input(2) > waiting(3) > idle(4) > connecting(5) > ended(6)
- Editable session titles, close/kill buttons, collapsible groups per room

### RoomLabels
- drei `<Text>` with SDF rendering, flat horizontal rotation (`-PI/2` on X axis, readable from above)
- Room labels: name (uppercase, fontSize 0.7) + unit count (fontSize 0.35) at Y=2.8
- Strip color alternates cyan (`#00f0ff`) / magenta (`#ff00aa`) based on room index parity
- Coffee lounge label: "COFFEE LOUNGE" in orange (`#ff9944`), fontSize 0.8

### Scene Themes
9 theme palettes with 36 color/density/lighting properties each (command-center, cyberpunk, warm, dracula, solarized, nord, monokai, light, blonde).

### Session Filtering
Only sessions with `status !== 'ended'` AND `source === 'ssh'` are rendered as robots. This ensures only terminal-launched sessions appear in the 3D scene.

### Store Dependencies
`CyberdromeScene` reads from `sessionStore`, `roomStore`, `settingsStore`, and `cameraStore` in the DOM layer. ALL Canvas-side components use zero store access (props only, or imperative `getState()` reads where necessary).

## Dependencies & Connections

### Depends On
- [State Management](../frontend/state-management.md) -- sessionStore (sessions), roomStore (rooms), settingsStore (theme, characterModel, fontSize), cameraStore (fly-to)
- [Robot System](./robot-system.md) -- SessionRobot rendered per session inside Canvas
- [Particles & Effects](./particles-effects.md) -- StatusParticles, SubagentConnections rendered inside Canvas

### Depended On By
- [Views/Routing](../frontend/views-routing.md) -- LiveView renders CyberdromeScene
- [Session Detail Panel](../frontend/session-detail-panel.md) -- robot click triggers panel open
- [Settings System](../frontend/settings-system.md) -- theme changes update scene visuals

### Shared Resources
- Three.js Canvas (single instance, shared by all 3D components)
- `robotPositionStore` (non-reactive Map for position sharing between robots and camera)
- `sessionStorage['cyberdrome-robot-positions']` for position persistence across page reloads

## Change Risks
- Adding Zustand subscriptions inside Canvas causes React Error #185 (cross-reconciler cascade). All store reads must remain in the DOM layer.
- Changing CustomEvent timing (removing `setTimeout(0)`) causes store update during R3F render pass.
- CameraController `queueMicrotask` is critical -- direct store update in `useFrame` causes cascading renders.
- Changing room layout constants in `cyberdromeScene.ts` affects all robot navigation paths and workstation placement.
- Scene theme changes must update both 3D fog/lighting and CSS theme variables in sync.
- OrbitControls `maxPolar` prevents camera from going below the floor -- relaxing this breaks the visual.
