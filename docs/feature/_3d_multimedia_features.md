# 3D Scene + Multimedia Features

---

## 15. 3D Cyberdrome Scene

The Cyberdrome is a fully interactive 3D office environment rendered with React Three Fiber (R3F) and Three.js. Each active session is represented by an animated 3D robot character that navigates the scene, sits at desks, and reacts to session state changes in real time.

### 15.1 Architecture

**Zero Zustand inside Canvas**

The core architectural decision is that all Zustand store subscriptions live in the DOM layer (`CyberdromeScene` component), never inside the `<Canvas>`. This prevents cross-reconciler state cascades that cause React Error #185 (illegal store update during render).

All data flows into the Canvas via props:
- Sessions are extracted from `sessionStore` as a plain array before the Canvas.
- Room configs, workstations, wall collision rects, and casual areas are computed in the DOM layer with `useMemo`.
- Room assignments per session are precomputed as a `Map<string, number | undefined>` to eliminate `useRoomStore` subscriptions inside Canvas.
- Subagent connection data is computed as a plain `ConnectionData[]` array.
- Scene theme colors and fog density are resolved outside Canvas and passed as props.

**CustomEvent pattern for click handling**

When a user clicks a robot inside R3F, the click handler dispatches a `CustomEvent('robot-select')` with a `setTimeout(0)` delay. This ensures the store update (`selectSession`) fires after R3F's pointer event cycle completes, fully decoupling the React reconciler used by R3F from the Zustand store. The DOM-side `useEffect` listener in `CyberdromeScene` catches the event and calls `selectSession` + `flyTo`.

**Ref-based animation (no useState in render loop)**

All per-robot animation state is stored in refs:
- `nav` ref (NavState) holds all movement state — position, rotation, speed, waypoints, mode, desk index.
- `seatedRef` tracks seated state for animation, updated in `useFrame`, never triggers re-render.
- `dialogueRef` holds the current dialogue message, updated in `useEffect`, read in `useFrame`.
- Direct `groupRef.current.position.set()` calls in `useFrame` move the robot group without React prop updates.

**Memoized SessionRobot**

`SessionRobot` is wrapped in `React.memo` with a custom equality check comparing 16 specific session fields. This prevents re-renders when unrelated session data changes, which would cascade Html portal updates for every robot.

**Position persistence**

Robot world positions and nav state are saved to `sessionStorage` every 2 seconds via `saveRobotPositions`. On page reload, `loadRobotPositions` restores each robot's position, rotation, navigation mode, and desk index. `NAV_GOTO` mode is reset to `NAV_WALK` on restore since it's a transient state.

### 15.2 Canvas Setup

The Three.js canvas is configured with:

| Setting | Value |
|---------|-------|
| Camera position | `[18, 16, 18]` (isometric-style view) |
| Camera FOV | 50 degrees |
| Near clip | 0.1 |
| Far clip | 150 |
| Shadow type | `PCFSoftShadowMap` |
| Tone mapping | `ACESFilmicToneMapping` |
| Tone mapping exposure | 1.2 |
| Antialiasing | Enabled |
| Fog | `FogExp2` (density varies by theme, default 0.008) |

**OrbitControls** are configured with:
- Damping factor: 0.06 (smooth momentum)
- Max polar angle: `PI / 2.1` (cannot orbit below floor)
- Min distance: 6 (close zoom)
- Max distance: 80 (wide overview)
- Initial target: `[0, 1, 0]`

**`SceneThemeSync`** is an internal Canvas component that uses `useThree` to directly update `scene.fog` color/density and `gl.clearColor` when the theme changes — no re-render, pure imperative update.

### 15.3 Map Controls Overlay

A DOM overlay positioned `bottom: 20, left: 20` provides three navigation buttons:

| Button | Action | Implementation |
|--------|--------|----------------|
| + (zoom in) | Zoom factor 0.65 | Scales camera offset from target by 0.65 |
| - (zoom out) | Zoom factor 1.5 | Scales camera offset from target by 1.5 |
| Top-down view | Bird's-eye | Flies to `[t.x + 0.01, t.y + 30, t.z + 0.01]` targeting current look-at |
| Reset view | Default position | Flies to `[18, 16, 18]` targeting `[0, 1, 0]` |

Buttons use inline style hover effects: `background: rgba(0,240,255,0.15)` on hover, `backdrop-filter: blur(8px)`, monospace font, 34×34px size.

### 15.4 Dynamic Room System

Rooms are created and destroyed dynamically based on `roomStore.rooms`. The layout engine in `src/lib/cyberdromeScene.ts` computes geometry from room indices.

**Layout constants:**

| Constant | Value | Description |
|----------|-------|-------------|
| `ROOM_SIZE` | 12 | Internal room dimension (12×12 units) |
| `ROOM_GAP` | 5 | Corridor width between rooms |
| `ROOM_CELL` | 17 | Grid cell size (ROOM_SIZE + ROOM_GAP) |
| `ROOM_HALF` | 6 | Half of room size |
| `ROOM_COLS` | 4 | Maximum rooms per row before wrapping |
| `WALL_H` | 2.8 | Wall height |
| `WALL_T` | 0.12 | Wall thickness |
| `DOOR_GAP` | 4 | Doorway width (centered on each wall) |

**Room grid positioning:**

Rooms are placed in a grid where column is `roomIndex % 4` and row is `floor(roomIndex / 4)`. Columns are centered around X=0. Center of room at index `i`:
```
col = i % 4
row = floor(i / 4)
x = (col - 1.5) * 17
z = row * 17
```

**`RoomConfig` interface** (computed per room):
- `index: number` — grid index
- `roomId: string` — store room ID
- `name: string` — display name
- `center: [number, number, number]` — world center
- `bounds: RoomBound` — min/max X/Z extents
- `stripColor: 0 | 1` — alternates cyan/magenta strips per even/odd index

### 15.5 Room Walls

Each room has 4 walls rendered in `RoomWalls`. North and south walls (along Z edges) each have a 4-unit door gap in the center, splitting into two segments per wall. East and west walls are solid. Each wall has a glowing strip at the top edge.

**Wall geometry:**
- Wall segment: `BoxGeometry(length, WALL_H, WALL_T)` — metallic, semi-transparent
- Top strip: `BoxGeometry(len, 0.04, WALL_T + 0.06)` — emissive (2.0 intensity), alternates theme `stripPrimary` or `stripSecondary`
- Wall material: `roughness: 0.2`, `metalness: 0.7`, `transparent: true`, opacity from theme
- Doors only on north and south walls; east and west walls are solid

**Collision rects** for wall physics are built by `buildDynamicWallRects`: each wall segment produces a `WallRect` with 0.25-unit half-thickness on the thin axis.

### 15.6 Room Desks Layout (8 desks per room)

Each room has exactly 8 desks placed at fixed positions relative to the room center `[cx, cz]`:

| Position | Facing | Notes |
|----------|--------|-------|
| `[cx-3.5, cz-4.5]` | South (rot=0) | North wall, left of door |
| `[cx+3.5, cz-4.5]` | South (rot=0) | North wall, right of door |
| `[cx+3.5, cz+4.5]` | North (rot=PI) | South wall, offset from door |
| `[cx-5, cz-1.5]` | East (rot=PI/2) | West wall |
| `[cx-5, cz+1.5]` | East (rot=PI/2) | West wall |
| `[cx+5, cz-1.5]` | West (rot=-PI/2) | East wall |
| `[cx+5, cz+1.5]` | West (rot=-PI/2) | East wall |
| `[cx+5, cz-3.5]` | West (rot=-PI/2) | East wall, additional |

Each desk consists of:
- **Tabletop**: `BoxGeometry(1.5, 0.05, 0.65)` at Y=0.7
- **Two side legs**: `BoxGeometry(0.04, 0.66, 0.58)` at X ± 0.72
- **Monitor frame**: `BoxGeometry(0.48, 0.32, 0.025)` at Y=0.92
- **Monitor screen**: `BoxGeometry(0.44, 0.28, 0.005)` with emissive color from `PALETTE`
- **Keyboard**: `BoxGeometry(0.32, 0.012, 0.1)` at Y=0.72
- **Chair seat**: `BoxGeometry(0.36, 0.03, 0.36)` at Y=0.4
- **Chair back**: `BoxGeometry(0.34, 0.28, 0.03)` at Y=0.57
- **Chair stem**: `CylinderGeometry(0.025, 0.025, 0.36, 6)`
- **Chair base**: `CylinderGeometry(0.16, 0.16, 0.025, 6)`

The chair is positioned 0.65 units toward the robot's facing direction from the desk center. Monitor screen color cycles through `PALETTE` using `(deskOffset + di) * 3 + 1`.

### 15.7 Corridor Workstations

For robots not assigned to any room (`zone === -1`), a dedicated "common area" with 10 workstations is placed south of all rooms. The layout is a 2-row × 5-column grid:

- **No rooms**: Centered at origin, rows at Z=-3 and Z=+3, spacing X=3.5
- **With rooms**: Placed at `southmostRoomCenter.z + ROOM_HALF + ROOM_GAP + 5`, horizontally centered across the room span. Spacing X=4, Z=4 between rows.

Row 0 faces south (rot=0), row 1 faces north (rot=PI). These workstations share the same desk geometry as room desks.

### 15.8 Casual Areas: Coffee Lounge and Gym

Two casual areas are built north of the room grid (most negative Z side), separated by a 3-unit gap. Each area is 14×14 units (`CASUAL_AREA_SIZE = 14`).

**Placement:**
- If rooms exist: `baseZ = min room edge - ROOM_GAP - 7 - 2` (7 = CASUAL_HALF)
- Area centers: `coffeeX = centerX - 10` (CASUAL_HALF + gap/2), `gymX = centerX + 10`

**Coffee Lounge** (`zone === -2`):
- 14×14 floor pad at Y=0.004 with `theme.coffeeFloor` material
- AreaBorderGlow (14-unit) in `theme.coffeeAccent` color
- 6 coffee tables in a 2×3 grid (rows at Z±2.5, cols at X-3/0/+3 relative to area center)
- Each table: round cylinder top (`CylinderGeometry(0.5, 0.5, 0.04, 12)` at Y=0.5), stem, base
- Two stools per table at X±0.6
- Counter bar along north edge: `BoxGeometry(8, 1.1, 0.5)` at Y=0.55, with accent top strip
- Coffee machine: box body + screen panel + nozzle cylinder + cup platform
- Coffee pot: tapered cylinder + torus handle
- 3 coffee cups on tables
- Warm point light: `color: theme.coffeeAccent`, intensity 6, distance 14

**Gym Area** (`zone === -3`) — 10 equipment types:

| Equipment | Position (relative) | Details |
|-----------|---------------------|---------|
| Bench press | `[-5, -5]` | Bench box + legs + barbell cylinder + weight discs (torusGeometry) |
| Treadmill | `[0, -5]` | Angled running platform + handlebar uprights + console |
| Rowing machine | `[+5, -5]` | Horizontal rail + sliding seat + foot pads + handle |
| Stationary bike | `[-5, 0]` | Frame box + seat + handlebar post + wheel cylinder |
| Pull-up bar | `[0, 0]` | Two uprights (height 2.4) + crossbar cylinder + diagonal braces |
| Leg press | `[+5, 0]` | Angled platform + seat + back rest + guide rails |
| Punching bag | `[-5, +5]` | Ceiling mount + vertical support + cylindrical bag |
| Cable machine | `[0, +5]` | Frame + top crossbar + pulley wheel + vertical cable + weight stack |
| Kettlebell rack | `[+5, +5]` | Shelf frame + 3 kettlebells (sphere + torus handle) |
| Dumbbell rack | `[-2.5, +2.5]` | Rack frame + 2 shelf levels + 5 dumbbells (sphereGeometry) |
| Medicine ball | `[+2.5, +2.5]` | `SphereGeometry(0.13, 8, 8)` in accent color |

Cool point light: `color: theme.gymAccent`, intensity 8, distance 18.

**Casual workstation zones**: Coffee lounge stations use `zone === -2`, gym stations use `zone === -3`. Both are part of the `workstations` array. Idle robots seek coffee (zone -2), waiting robots seek gym (zone -3).

### 15.9 Floor and Environment

**DynamicFloor:**
- Main floor: `PlaneGeometry(floorSize, floorSize)` at Y=0, `roughness: 0.7, metalness: 0.3`
- Per-room floor panels: `PlaneGeometry(12, 12)` at Y=0.003, slightly brighter `theme.roomFloor`
- Room border glow: 4 thin planes (0.06-unit wide) forming a square outline at Y=0.015, emissive intensity 1.5, opacity 0.35
- Grid overlay 1: `GridHelper(floorSize, floorSize/1)` at Y=0.005, theme `grid1` color, opacity 0.04
- Grid overlay 2: `GridHelper(floorSize, floorSize/5)` at Y=0.008, theme `grid2` color, opacity 0.03
- Floor size: `max(30, sceneBounds * 2 + 10)`

**Circuit traces**: 14 random L-shaped polylines on the floor at Y=0.011. Each has 4-7 axis-aligned segments of random length 1-4 units. Colors cycle through `[theme.particle1, theme.particle2, theme.trace3]`. Opacity 0.08-0.16. Built with raw `THREE.BufferGeometry` + `lineBasicMaterial`.

**Data particles** (animated):
- 140 cyan particles (`theme.particle1`) rising at speed 0.2-0.8 units/sec
- 80 magenta particles (`theme.particle2`) at the same speed
- Size: 0.04, opacity: 0.4, additive blending
- When a particle reaches Y=10, it resets to Y=0 at a random X/Z position
- `Float32Array` buffers updated every frame via `points.geometry.attributes.position.needsUpdate = true`

**Stars**: 400 random points at Y=8-43, X/Z ±50, size 0.05, opacity 0.4, `theme.stars` color.

### 15.10 Room Lighting

Each room has dedicated interior lighting:

**Visual sconces**: 9 emissive boxes per room (3 along north wall, 2 on each side wall, 2 along south wall):
- Bracket: `BoxGeometry(0.8, 0.12, 0.05)` + mount `BoxGeometry(0.1, 0.08, 0.22)` in dark metallic
- Light tube: `BoxGeometry(1.2, 0.25, 0.12)` emissive in `theme.sconceColor`, intensity 2.5

**Point lights** (2 per room, GPU-friendly):
- Primary: `color: theme.roomLight1`, intensity 10, distance 16, decay 1.5, at ceiling level
- Secondary: `color: theme.roomLight2`, intensity 4, distance 12, decay 2, at mid-height

**Global lighting** (scene-wide):
- Ambient: `theme.ambientColor`, intensity varies by theme (4-10)
- Directional (shadows): `position: [8, 20, 6]`, shadow map 2048×2048, bias -0.0004
- Fill directional: `position: [-6, 15, -8]`
- 3 point lights at corners: `[-10, 8, -10]`, `[10, 7, 10]`, `[0, 10, 0]`
- Hemisphere: sky color, ground color, intensity from theme

### 15.11 Robot Navigation AI

Each robot has 4 navigation modes (stored in `NavState.mode`):

| Constant | Value | Description |
|----------|-------|-------------|
| `NAV_WALK` | 0 | Wandering to random target |
| `NAV_GOTO` | 1 | Navigating to a specific desk via waypoints |
| `NAV_SIT` | 2 | Seated at a desk, not moving |
| `NAV_IDLE` | 3 | Frozen in place (alert/input/offline/connecting) |

**Navigation state (`NavState`):**
- `mode` — current nav mode
- `target` — current waypoint target (Vector3)
- `deskIdx` — occupied workstation index (-1 if none)
- `speed` — base speed: 3.0 + random(0, 1.5) units/sec
- `walkHz` — walk bounce frequency: 12 + random(0, 4) Hz
- `phase` — random phase offset for animation desync
- `decisionTimer` — countdown to desk-seek attempt
- `posX, posY, posZ` — current world position
- `rotY` — current Y rotation
- `waypoints` — ordered array of intermediate points
- `waypointIdx` — current waypoint index

**Status-to-navigation mapping:**

| Status | Robot State | Navigation behavior |
|--------|-------------|---------------------|
| idle | idle | Seek coffee workstation (zone -2); wander if full |
| prompting | thinking | Seek desk in assigned room or corridor; sit when arrived |
| working | working | Seek desk; speed multiplier 1.5 |
| waiting | waiting | Seek gym workstation (zone -3); wander if full |
| approval | alert | Freeze (NAV_IDLE or stay seated) |
| input | input | Freeze (NAV_IDLE or stay seated) |
| ended | offline | Freeze |
| connecting | connecting | Freeze |

**Desk seeking logic:**

When entering a desk-seeking state (`thinking` or `working`):
1. Determine zone: room assignment → current position zone → fallback
2. Find empty workstations in that zone
3. Claim one randomly, set `ws.occupantId = sessionId`, go `NAV_GOTO`
4. If all desks full: find nearest occupied desk, stand 0.5 units behind it (overflow)
5. During `NAV_WALK`, robot periodically checks for empty desks (every 3-8 seconds via `decisionTimer`)

**Wall collision** (`collidesAnyWall`):
- Checks 0.25-unit robot radius against all `WallRect` entries
- On X-axis collision only: slide along Z, pick new wander target
- On Z-axis collision only: slide along X, pick new wander target
- On full collision: pick new wander target
- Position clamped to `[-sceneBound, sceneBound]` on both axes

**Walk bounce:** `posY = abs(sin(time * walkHz + phase)) * 0.03` — small up-down bounce while moving.

**Facing:** `rotY` lerps toward `atan2(dx, dz)` at rate `min(1, 10 * dt)` per frame.

**Seated position:** When `NAV_SIT` is reached, robot snaps to `ws.seatPos` with `posY = -0.12` (slightly sunken) and faces `ws.faceRot`.

### 15.12 Cross-Room Pathfinding

When a robot needs to navigate between zones (room → corridor → room), it uses a door-waypoint system.

**Door waypoints:** Built by `buildDoorWaypoints`. Each room gets 2 waypoints per wall (north and south):
- `outside`: 1 unit past the wall exterior (in the corridor)
- `inside`: 1 unit past the wall interior (inside the room)

**`computePathWaypoints(fromX, fromZ, target, fromZone, targetZone, doors)`:**
1. Same zone → direct path (single waypoint = target)
2. Both in corridor/casual (`< 0`) → direct path
3. Exiting a room: pick the door closest to the target. Add `inside` → `outside` waypoints.
4. Entering a room: pick the door closest to the robot's current position. Add `outside` → `inside` waypoints.
5. Append final target.

**Nearest-door selection:** Euclidean distance from the door's `outside` point to the robot's current position (for entering) or to the target (for exiting).

**`setNavTarget` helper:** Calls `computePathWaypoints`, sets `nav.waypoints`, initializes `nav.waypointIdx = 0`, sets `nav.target` to the first waypoint.

### 15.13 Robot 3D Model

**Geometry** (shared across all instances, defined in `src/lib/robot3DGeometry.ts`):

| Part | Geometry | Dimensions |
|------|----------|------------|
| Head | `BoxGeometry` | 0.28 × 0.24 × 0.26 |
| Visor | `BoxGeometry` | 0.24 × 0.065 × 0.02 |
| Antenna | `CylinderGeometry` | r=0.007, h=0.14, 4-sided |
| Antenna tip | `SphereGeometry` | r=0.02, 6 segments |
| Torso | `BoxGeometry` | 0.32 × 0.38 × 0.2 |
| Core | `SphereGeometry` | r=0.032, 8 segments |
| Joint | `SphereGeometry` | r=0.035, 8 segments |
| Arm | `BoxGeometry` | 0.08 × 0.26 × 0.08 |
| Leg | `BoxGeometry` | 0.09 × 0.28 × 0.09 |
| Foot | `BoxGeometry` | 0.1 × 0.045 × 0.12 |

Each body part also has an `EdgesGeometry` wireframe overlay (lineSegments) with a neon color material at opacity 0.3.

**Materials:**
- `metalMat`: `MeshStandardMaterial`, color `#2a2a3e`, roughness 0.3, metalness 0.85 (shared)
- `darkMat`: color `#1c1c2c`, roughness 0.4, metalness 0.7 (shared)
- `neonMats[i]`: per-palette emissive material, intensity 2.0 (pool of 16, shared)
- `edgeMats[i]`: `LineBasicMaterial`, color = palette color, opacity 0.3 (pool of 16, shared)
- `bodyMat`: cloned from `metalMat` per robot (animations mutate emissive each frame)
- `bodyEdgeMat`: cloned from `edgeMat` per robot

**PALETTE** — 16 cyberpunk neon colors:
`#00f0ff`, `#ff00aa`, `#a855f7`, `#00ff88`, `#ff4444`, `#ffaa00`, `#00aaff`, `#ff66ff`, `#44ff44`, `#ff8800`, `#8855ff`, `#00ffcc`, `#ff0066`, `#ccff00`, `#ff5577`, `#33ddff`

**Model variants** (6 types, defined in `src/lib/robot3DModels.ts`):

| Type | Description | Distinctive geometry |
|------|-------------|---------------------|
| `robot` | Standard humanoid | Default geometry |
| `mech` | Bulkier, wider stance | Head 0.34×0.2×0.3, Torso 0.42×0.44×0.26, wider arms/legs |
| `drone` | Hovering unit | Spherical head (r=0.14), flat arms (0.22×0.04×0.06), no legs, baseY=0.3 |
| `spider` | Low-slung 4-legged | Spherical head (r=0.12), wide flat torso, all 4 limbs stubby at corners, baseY=-0.15 |
| `orb` | Spherical body | Spherical head (r=0.10), spherical torso (r=0.22, 12-seg), short arms and legs |
| `tank` | Wide, one-armed | Compact head, wide torso (0.44×0.3×0.26), no left arm, thick right arm, tread-shaped legs, baseY=-0.05 |

**Per-robot model selection:** `session.characterModel` overrides the global `settingsStore.characterModel` (default `'robot'`).

**CLI source badge:** A Billboard `<Text>` on the robot's chest (position slightly below core) showing a single letter with emissive color:
- Claude: `'C'`, color `#00f0ff`
- Gemini: `'G'`, color `#4285f4`
- Codex: `'X'`, color `#10a37f`
- OpenClaw: `'O'`, color `#ff6b2b`
- Unknown: `'?'`, color `#aa66ff`

Badge has `outlineWidth: 0.01`, `emissiveIntensity: 0.8`.

**CLI color override:** When a session has no explicit `accentColor`, the robot's neon color is set to the CLI badge color rather than the PALETTE color at `session.colorIndex`.

### 15.14 Robot Animations

Animations run in `useFrame` by reading `useSettingsStore.getState()` imperatively (no subscription). `animSpeed = animationSpeed / 100`, `ai = animationIntensity / 100`.

**Always active:**
- Antenna tip: scales between 0.8 and 1.2 at 6 Hz with `ai` factor. Web tools: intensity 3-4.5.
- Core: scales between 0.78 and 1.02 at 3 Hz.

**State-specific animations:**

| State | Key behaviors |
|-------|---------------|
| `idle` | Body bobs at 1.5 Hz (0.02 * ai), arms sway at 0.8 Hz, body tilts at 0.5 Hz |
| `thinking` (standing) | Body bobs at 1.2 Hz, head tilts at 0.6 Hz, right arm raised (-0.6 + oscillation) |
| `thinking` (seated) | Head tilts 0.12 + oscillation, right arm raised to chin-scratch pose (-1.1), legs bent (1.2) |
| `working` | See tool-specific animations below; body bobs at 0.7 Hz; CHARGING EFFECT active |
| `waiting` | Body bounces (abs sin) at 2 Hz (0.06 * ai), head turns at 0.8 Hz |
| `alert` | Visor flashes (urgency-scaled); arms raised and shaking at 8 Hz; 30s+ adds lateral shake |
| `input` | Visor pulses at 4 Hz; right arm fully raised (-1.5); slow body sway |
| `offline` | Visor/core dim over time; head drooped, arms slack |
| `connecting` | 1.5-second boot animation: scale 0→scaleProp, Y sinks from 0.5→0 |

**Tool-specific working animations (WS7.C):**

| Tool category | Tools | Animation |
|---------------|-------|-----------|
| `read` | Read, Grep, Glob, NotebookEdit | Head scans left-right at 2.5 Hz (±0.35 rad); arms at -0.4 |
| `write` | Write, Edit | Rapid arm typing at 14 Hz (±0.07 rad); head stable |
| `bash` | Bash | Right arm extended forward (-0.9); left arm at -0.3 |
| `task` | Task | Both arms raised (-0.8) with slow oscillation; head looks around |
| `web` | WebFetch, WebSearch | Antenna brightness boost (3-4.5 emissive intensity); default arm motion |
| `default` | All others | Standard rapid arm oscillation at 10 Hz (±0.05 rad) |

**Charging body effect** (active during any `working` state):
- Edge wireframe: opacity surges between 0.8-1.0 at two combined frequencies (12 Hz + 23 Hz)
- Core glow: emissive intensity 2.0-3.8 at 8 Hz + 19 Hz
- Visor: emissive intensity 2.0-3.2 at 10 Hz + 17 Hz
- Antenna tip: emissive intensity 2.5-4.0 at 15 Hz; scale flicker at 20 Hz
- Body mesh: subtle emissive boost in neon color, intensity 0.05-0.25 at 14 Hz

**Alert urgency escalation (WS7.B):** After 15 seconds in `alert` state, visor pulse speed increases from 8 Hz to 12 Hz. After 30 seconds, base intensity rises from 1.5 to 2.5, pulse range from 1.0 to 1.5, and lateral shake is added.

**Label completion frame effects (6 types):**

Activate when a labeled session transitions to `ended`. Override the normal body animation with:

| Effect | Visual character |
|--------|-----------------|
| `fire` | Orange/red body emissive with rapid flicker (9 Hz + 17 Hz layered), orange wireframe, fiery core |
| `electric` | Spike pattern (sin^4 at 20 Hz), white wireframe arc flicker (25 Hz threshold), intense multi-freq core |
| `chains` | Slow golden aura (2.5 Hz), gold wireframe (3 Hz), golden visor glow |
| `liquid` | Flowing wave intensity (3 Hz body, 5 Hz edges, 3.5 Hz core), hue-shifted by wave value |
| `plasma` | Violent magenta oscillations at 12/15/14 Hz body/core/visor; extreme intensities (4.0-6.5 core) |
| `none` | No frame effect |

Frame effect animations run after state animations, taking priority over body charge reset.

**Visor material overrides** (static pre-created materials):
- `alert` state: `ALERT_VISOR_MAT` — neon yellow `#ffdd00`, emissiveIntensity 2
- `input` state: `INPUT_VISOR_MAT` — purple `#aa66ff`, emissiveIntensity 2
- `offline` state: `OFFLINE_VISOR_MAT` — dark `#333344`, emissiveIntensity 2

### 15.15 Robot Dialogue

`RobotDialogue` shows a floating speech bubble above each robot. The component uses zero React state — all dialogue data flows through a ref (`dialogueRef`) updated in `useEffect` and read in `useFrame`.

**Panel geometry:**
- Billboard positioned at Y=2.8 above robot root
- Background: `PlaneGeometry(2.2, 0.22)` — dark `#0a0616`, opacity 0.92
- Border: `PlaneGeometry(2.26, 0.26)` — colored by dialogue type, opacity 0.6
- Text: `<Text>` via troika-three-text, fontSize 0.09, max-width 2.0, white with black outline

**Fade behavior:** Non-persistent dialogues start fading after 5 seconds. Fade speed: 4 units/second toward target opacity. Values below 0.01 clamp to 0.

**`TextUpdater`** inner component reads `fillOpacity`, `outlineOpacity`, and `text` from the troika mesh via parent traversal in `useFrame`, without any React state updates.

**Dialogue content and trigger rules:**

| Trigger | Text | Border color | Persistent |
|---------|------|--------------|------------|
| `prompting` status (status change) | First 60 chars of prompt + `...` | `#00e5ff` | No (5s) |
| `approval` status | `AWAITING APPROVAL` | `#ffdd00` | Yes |
| `input` status | `NEEDS INPUT` | `#aa66ff` | Yes |
| `waiting` status (from working) | `Task complete!` | `#00ff88` | No |
| `ended` status | `OFFLINE` | `#ff4444` | No |
| `idle` (from non-idle/non-connecting) | `ONLINE` | `#00ff88` | No |
| Read/Grep/Glob tool | `Reading <filename>...` | `rgba(0,229,255,0.6)` | No |
| Bash tool | `$ <cmd truncated to 40 chars>` | `#ff9100` | No |
| Edit/Write tool | `Editing <filename>...` | `#00aaff` | No |
| Task tool | `Spawning agent...` | `#aa66ff` | No |
| WebFetch/WebSearch tool | `Fetching...` | `#00e5ff` | No |

Tool dialogues are throttled: minimum 500ms between updates unless a status change occurred. Status-based dialogues always take priority over tool dialogues.

### 15.16 Robot Labels

`RobotLabel` renders a floating name tag above each robot using drei `<Billboard>` + `<Text>` (pure WebGL, not HTML portals). This avoids the cross-reconciler cascades that `<Html>` would cause.

**Layout** (all dimensions scale with `fontSize / 13`):

| Element | Base size | Position |
|---------|-----------|----------|
| Background panel | 1.8 × 0.14 | Y=0, Z=-0.01 |
| Border | 1.84 × 0.17 | Y=0, Z=-0.015, opacity 0.15 |
| Status dot | r=0.025 | X=-0.82, circle with 16 segments |
| Project name text | 0.065 fontSize | X=0.02, max-width 1.5 |
| Alert banner | 1.6 × 0.16 | Y=0.18 above label |
| Alert text | 0.07 fontSize | In alert banner |
| Billboard Y position | 2.1 (adjusts with scale) | |

**Status dot colors:**
- idle: `#00ff88`, prompting: `#00e5ff`, working: `#ff9100`, waiting: `#00e5ff`, approval: `#ffdd00`, input: `#aa66ff`, ended: `#ff4444`, connecting: `#888888`

**Title**: `session.title || session.projectName || 'Unnamed'`, truncated to 28 characters.

**Label badge**: When `session.label` is set, appends ` [LABEL]` to the title text.

**Alert banner**: Shows pulsing colored banner above the main label for `approval` (yellow) and `input` (purple) states. Opacity pulses via `useFrame` at 0.8+0.2*sin(time/500).

**Memoization**: 9-field equality check covering sessionId, status, title, projectName, label, robotState, isSelected, isHovered, fontSize.

### 15.17 Status Particles

`StatusParticles` fires brief particle bursts on status transitions. Uses zero React state — always mounted with `bufferGeo.setDrawRange(0, 0)` to hide when inactive.

**Pre-allocated geometry**: One `BufferGeometry` with `Float32Array(MAX_PARTICLES * 3)` (MAX=25). Buffer is never recreated, only updated.

**Per-instance material**: `PointsMaterial` with `AdditiveBlending`, `depthWrite: false`.

**Burst configurations:**

| Transition | Color | Count | Pattern | Speed | Gravity | Lifetime |
|------------|-------|-------|---------|-------|---------|----------|
| idle/waiting → working/thinking | `#ffdd00` | 20 | up | 2.5 | -1.5 | 1.5s |
| working/thinking → waiting | `#00ff88` | 20 | confetti | 1.2 | 2.0 | 1.5s |
| → alert | `#ffdd00` | 25 | ring | 2.0 | 0 | 1.2s |
| → input | `#aa66ff` | 20 | ring | 1.5 | 0 | 1.2s |
| → offline | `#666688` | 20 | down | 0.8 | 0.5 | 2.0s |

**Patterns:**
- `up`: velocity mainly upward, small random spread
- `down`: velocity mainly downward, smaller spread
- `ring`: particles spread radially in XZ plane at Y=0.15, even angular distribution
- `confetti`: random XZ spread with upward bias

**Fade**: `opacity = 1 - progress^2`. Size: `burstSize * (1 - progress * 0.5)`. Velocity decays at 0.99x per frame tick. Gravity applies to Y velocity each tick.

### 15.18 Subagent Connection Beams

`SubagentConnections` renders animated dashed laser-lines between parent sessions and their subagent children. Receives precomputed `ConnectionData[]` from the DOM layer (zero Zustand subscriptions).

**Detection**: Sessions where `teamRole === 'member'` and `teamId` exists. The parent ID is extracted from `teamId` by stripping the `team-` prefix. Both parent and child must be non-`ended`.

**Line rendering**: Raw `THREE.Line` with `LineDashedMaterial`:
- `dashSize: 0.3`, `gapSize: 0.2`
- Opacity: 0.3
- Color: parent session's `accentColor` or PALETTE color

**Animation**: In `useFrame`, the line's endpoint buffer is updated to track both robots' current positions from `robotPositionStore`. The `dashOffset` decrements at `delta * 2` per frame to create a flowing "data flowing from parent to child" visual. `computeLineDistances()` is called each frame (required for dashed lines to render correctly).

**Cleanup**: Geometry and material are disposed on unmount.

### 15.19 Camera Controller

`CameraController` is a Canvas-side component that smoothly animates OrbitControls to fly-to targets. It reads `cameraStore` imperatively in `useFrame` (no subscription) to avoid cascades.

**Constants:**
- `LERP_FACTOR = 0.04` — smooth camera movement (4% of remaining distance per frame)
- `ARRIVAL_THRESHOLD = 0.1` — considers animation complete when both position and look-at are within 0.1 units

**Fly-to behavior:**
1. Detects a new request by comparing `pendingTarget.requestId` to `lastRequestId`.
2. Sets `targetPos` and `targetLookAt` from the request.
3. Each frame: `camera.position.lerp(targetPos, 0.04)` and `controls.target.lerp(targetLookAt, 0.04)`.
4. When arrived: snaps to exact position, calls `completeAnimation()` via `queueMicrotask` (deferred out of R3F render cycle).

**Robot click → fly-to:** When a robot is selected, `CyberdromeScene` reads the robot's world position from `robotPositionStore` and calls `flyTo([pos.x + 6, pos.y + 8, pos.z + 10], [pos.x, pos.y + 1, pos.z])`. Offset constants: `FLY_OFFSET_X=6, FLY_OFFSET_Y=8, FLY_OFFSET_Z=10`.

**Room zoom:** `computeRoomCameraTarget(roomIndex)` places camera at 45-degree angle, 14 units out, 10 units high from room center.

**`cameraStore`:**
- `DEFAULT_CAMERA_POSITION: [18, 16, 18]`
- `DEFAULT_CAMERA_TARGET: [0, 1, 0]`
- `flyTo(position, lookAt)` sets `pendingTarget` with `requestId: Date.now()`
- `completeAnimation()` clears pending target and sets `isAnimating: false`

### 15.20 Room Labels

`RoomLabels` renders 3D text labels on the floor at each room's south door, using drei `<Text>` (SDF-based rendering at any zoom level).

**Room labels:**
- Room name: `fontSize: 0.8`, color alternates cyan (`#00f0ff`) or magenta (`#ff00aa`) based on `stripColor`, `letterSpacing: 0.15`, 2cm outline
- Unit count: `fontSize: 0.4`, dimmer variant of the strip color, at Z + 0.9 from room name
- Position: on floor (Y=0.02), rotated flat (`[-PI/2, 0, 0]`), at `cx, cz + ROOM_HALF + 1.5`

**Casual area labels:**
- Coffee Lounge: color `#ff9944`, at south edge of lounge area
- Gym Area: color `#44ff88`, at south edge of gym area
- Same fontSize/letterSpacing/outline as room labels

### 15.21 Robot List Sidebar

`RobotListSidebar` is a DOM overlay panel (top-right of scene) listing all active robots.

- Width: 280px, max-height: `calc(100vh - 100px)`, scrollable
- Backdrop blur, panel background, neon border with glow box-shadow
- Hidden when no active sessions
- Header: "Agents (N)" in monospace uppercase

**Entry sorting:** working → prompting/thinking → approval/input → waiting → idle → connecting

**Each entry shows:**
- Status dot (10×10px circle with glow box-shadow)
- Session title or project name (truncated, ellipsis)
- Status text (uppercase, status color)
- Close button (✕) — calls `removeSession` + `DELETE /api/sessions/:id`

**Selection:** Clicking an entry dispatches `CustomEvent('robot-select')` — same path as in-scene robot clicks, triggers session selection + camera fly-to.

**Selected state:** Border and background tint match the status color.

### 15.22 Scene Themes (9 themes)

Each theme provides a `Scene3DTheme` with 35+ color/density properties covering every visual element. Themes are applied via `getScene3DTheme(themeName)` which maps `ThemeName` to the palette:

| Theme | Background | Primary strip | Secondary strip | Character |
|-------|-----------|---------------|-----------------|-----------|
| `command-center` | `#0e0c1a` (dark navy) | `#00f0ff` (cyan) | `#ff00aa` (magenta) | Classic cyberpunk |
| `cyberpunk` | `#0d0221` (deep purple) | `#ff00ff` (magenta) | `#00ffff` (cyan) | High contrast neon |
| `warm` | `#f5ede0` (cream) | `#d97706` (amber) | `#b87333` (copper) | Daylight office |
| `dracula` | `#282a36` | `#bd93f9` (purple) | `#50fa7b` (green) | Dracula scheme |
| `solarized` | `#002b36` (dark teal) | `#2aa198` (teal) | `#cb4b16` (orange) | Solarized dark |
| `nord` | `#2e3440` (slate) | `#88c0d0` (sky) | `#d08770` (peach) | Nordic calm |
| `monokai` | `#272822` (dark) | `#66d9ef` (cyan) | `#f92672` (pink) | Monokai |
| `light` | `#e8eaef` (light gray) | `#3b82f6` (blue) | `#0ea5e9` (sky) | Light mode |
| `blonde` | `#f0e8d8` (warm white) | `#ca8a04` (gold) | `#a16207` (dark gold) | Warm blonde |

Theme properties include: `background`, `fogDensity`, `floor`, `roomFloor`, `borderGlow`, `grid1/2`, `wall`, `wallOpacity`, `stripPrimary/Secondary`, `desk`, `monitorFrame`, `chair`, `particle1/2`, `trace3`, `stars`, ambient/directional/fill/point/hemisphere lighting, `sconceColor`, `roomLight1/2`, `coffeeFloor/Accent/Furniture`, `gymFloor/Accent/Equipment`.

---

## 22. Sound System (`src/lib/soundEngine.ts`, `src/lib/ambientEngine.ts`, `src/lib/alarmEngine.ts`)

### 22.1 Architecture

The sound system has two layers:

1. **`SoundEngine`** (singleton `soundEngine`) — event-driven sound effects using Web Audio API synthesis
2. **`AmbientEngine`** (singleton `ambientEngine`) — continuous procedurally generated ambient presets

Both engines use lazy `AudioContext` creation, only initialized after user interaction. Zero audio files — all sounds are synthesized from Web Audio API primitives (oscillators, gain nodes, filters, noise buffers).

### 22.2 Sound Library (16 sounds)

All sounds are synthesized from Web Audio API primitives — no audio files:

| Name | Synthesis | Character |
|------|-----------|-----------|
| `chirp` | 1200 Hz sine, 80ms | Short high blip |
| `ping` | 660 Hz sine, 200ms | Medium tone |
| `chime` | Sequence [523, 659, 784] Hz, 80ms spacing | Major triad ascending |
| `ding` | 800 Hz triangle, 250ms | Bell-like |
| `blip` | 880 Hz square at 0.5 vol, 50ms | Short digital beep |
| `swoosh` | Sine 300→1200 Hz ramp over 250ms | Rising sweep |
| `click` | 1200 Hz square at 0.2 vol, 30ms | Crisp tap |
| `beep` | 440 Hz square at 0.4 vol, 150ms | Classic beep |
| `warble` | 600 Hz sine + 12 Hz LFO (±50 Hz), 300ms | Trembling tone |
| `buzz` | 200 Hz sawtooth at 0.4 vol, 120ms | Buzzy low tone |
| `cascade` | Sequence [784, 659, 523, 392], 100ms spacing | Descending arpeggio |
| `fanfare` | Sequence [523, 659, 784, 1047, 1319], 80ms spacing | Ascending fanfare |
| `alarm` | Square sequence [880, 660, 880, 660], 150ms each | Alert pattern |
| `thud` | Sine 80→30 Hz exponential ramp, 350ms | Bass impact |
| `urgentAlarm` | 3 bursts: square 1000↔800↔1000 Hz + sawtooth 200 Hz undertone | Triple urgent alarm |
| `none` | No-op | Silence |

### 22.3 Sound Actions (20 actions)

Actions are organized in 3 categories:

**Session Events** (4): `sessionStart`, `sessionEnd`, `promptSubmit`, `taskComplete`

**Tool Calls** (9): `toolRead`, `toolWrite`, `toolEdit`, `toolBash`, `toolGrep`, `toolGlob`, `toolWebFetch`, `toolTask`, `toolOther`

**System** (7): `approvalNeeded`, `inputNeeded`, `alert`, `kill`, `archive`, `subagentStart`, `subagentStop`

**Sound engine parameters:**

| Parameter | Value |
|-----------|-------|
| Base gain | `0.3 × masterVolume` |
| Tone durations | 0.03s – 0.35s |
| Frequency range | 30 Hz – 1200 Hz |

**Default action → sound mapping:**

| Action | Default sound |
|--------|--------------|
| sessionStart | chime |
| sessionEnd | cascade |
| promptSubmit | ping |
| taskComplete | fanfare |
| toolRead | click |
| toolWrite | blip |
| toolEdit | blip |
| toolBash | buzz |
| toolGrep | click |
| toolGlob | click |
| toolWebFetch | swoosh |
| toolTask | ding |
| toolOther | click |
| approvalNeeded | alarm |
| inputNeeded | chime |
| alert | alarm |
| kill | thud |
| archive | ding |
| subagentStart | chirp |
| subagentStop | ping |

### 22.4 Per-CLI Sound Profiles

Each CLI has an independent sound profile with its own volume and per-action sound mappings:

| CLI | Volume | Character |
|-----|--------|-----------|
| Claude | 0.7 | Standard with fanfare on task complete |
| Gemini | 0.7 | Heavier on swoosh, dings |
| Codex | 0.5 | Quieter, minimal sounds (blips and clicks) |
| OpenClaw | 0.7 | Dramatic — urgentAlarm for approvals, fanfares |

`AlarmEngine.playForCli()` detects the CLI via `detectCli()`, looks up the per-CLI volume and action mapping, temporarily overrides the sound engine volume for the play, then restores it.

### 22.5 CLI Detection

`detectCli(session)` determines CLI from:
1. `session.model` string: contains `claude`/`opus`/`sonnet`/`haiku` → Claude; `gemini`/`gemma` → Gemini; `gpt`/`codex`/`o1`/`o3`/`o4` → Codex; `openclaw`/`claw` → OpenClaw
2. Event type fallback: `BeforeAgent`/`AfterAgent`/`BeforeTool`/`AfterTool` → Gemini; `agent-turn-complete` → Codex; `SessionStart`/`PreToolUse`/`PostToolUse`/`UserPromptSubmit` → Claude

### 22.6 Ambient Presets (6 presets)

All ambient sounds are synthesized from oscillators and filtered noise:

| Preset | Synthesis technique |
|--------|---------------------|
| `off` | Silent (no audio) |
| `rain` | Bandpass-filtered noise (3000 Hz) + highshelf cutoff + random droplet oscillators every 80-200ms |
| `lofi` | 60 Hz sine with 0.3 Hz LFO (±5 Hz) + lowpass-filtered noise (400 Hz cutoff) |
| `serverRoom` | Bandpass noise (500 Hz) + 120 Hz triangle fan hum (0.1 Hz LFO ±3 Hz) + 8000 Hz whine |
| `deepSpace` | 40 Hz sine with 0.05 Hz LFO (±8 Hz) + convolver reverb (3s exponential impulse) + 80 Hz harmonic |
| `coffeeShop` | Lowpass+highpass filtered noise (200-1200 Hz) + random triangle dings every 2-6s |

---

## 23. Movement Effects

> **Note:** The legacy CSS-based movement effects (`data-effect` attributes) have been superseded by the 3D robot animation system (section 15.14). Movement actions now map to 3D robot state behaviors instead of CSS animations.

### 23.1 Action-to-Movement Mapping

Movement actions are configurable in `settingsStore.movementActions`. Each action maps to a named effect that triggers the corresponding 3D robot state animation:

| Action | Default movement | 3D behavior |
|--------|-----------------|-------------|
| sessionStart | slide | Robot spawns with boot-up scale animation (connecting state) |
| sessionEnd | spin | Robot fades to offline, visor/core dims |
| promptSubmit | wave | Robot enters thinking state, seeks desk |
| taskComplete | bounce | Robot enters waiting state, celebration hop |
| toolRead | pulse | Head scanning animation |
| toolWrite | pulse | Rapid arm typing animation |
| toolBash | run | Right arm extended forward |
| toolWebFetch | walk | Antenna brightness boost |
| toolTask | jump | Both arms raised |
| approvalNeeded | twitch | Visor flash, lateral shake |
| inputNeeded | wobble | Purple visor, arm oscillation |
| kill | flip | Session terminated |
| archive | fade | Session archived |
| subagentStart | jump | Status particles burst |

### 23.2 Label Completion Frame Effects (6 types)

When a labeled session transitions to `ended`, special visual frame effects override the normal robot animation:

| Effect | Visual character |
|--------|-----------------|
| `fire` | Orange/red body emissive with rapid flicker (9 Hz + 17 Hz layered), orange wireframe, fiery core |
| `electric` | Spike pattern (sin^4 at 20 Hz), white wireframe arc flicker (25 Hz threshold), intense multi-freq core |
| `chains` | Slow golden aura (2.5 Hz), gold wireframe (3 Hz), golden visor glow |
| `liquid` | Flowing wave intensity (3 Hz body, 5 Hz edges, 3.5 Hz core), hue-shifted by wave value |
| `plasma` | Violent magenta oscillations at 12/15/14 Hz body/core/visor; extreme intensities (4.0-6.5 core) |
| `none` | No frame effect |

Default label alarm configurations:
- `ONEOFF`: sound `alarm`, movement `shake`, frame effect `none`
- `HEAVY`: sound `urgentAlarm`, movement `flash`, frame effect `electric`
- `IMPORTANT`: sound `fanfare`, movement `bounce`, frame effect `liquid`

---

## 24. Alarm System

### 24.1 Approval Alarm (repeating)

When a session enters `approval` status:
1. `soundEngine.play('approvalNeeded')` fires immediately
2. A `setInterval` is created for that session, firing every **10 seconds**
3. Each interval tick: re-checks if session is still in `approval` and not muted
4. If status changes or session is muted, the interval is cleared and removed from `approvalTimers` map

Multiple sessions can have simultaneous approval alarms. Each has an independent timer stored in `approvalTimers: Map<string, intervalId>`.

### 24.2 Input Notification (one-shot)

When a session enters `input` status:
1. Checks `inputFired` map — if this session hasn't fired yet, plays `soundEngine.play('inputNeeded')`
2. Sets `inputFired.set('input-' + sessionId, true)` to prevent repeat
3. When session leaves `input` status, clears the fired flag so it can fire again next time

### 24.3 Mute Per Session

Sessions can be individually muted:
- `muteSession(sessionId)` — adds to `mutedSessions` set
- `unmuteSession(sessionId)` — removes from set
- All alarm checks and sound plays respect `mutedSessions.has(sessionId)`

### 24.4 Label Completion Alerts

When a labeled session transitions to `ended`, `handleLabelAlerts(session, labelSettings)` is called:
- Looks up `labelSettings[session.label.toUpperCase()]`
- If a `sound` is configured, plays it via `soundEngine.preview(sound)`
- Respects mute state

Default label alarm configurations:
- `ONEOFF`: sound `alarm`, movement `shake`, frame effect `none`
- `HEAVY`: sound `urgentAlarm`, movement `flash`, frame effect `electric`
- `IMPORTANT`: sound `fanfare`, movement `bounce`, frame effect `liquid`

### 24.5 Event-Based Sounds

`handleEventSounds(session)` processes the last event in `session.events` and maps it to a sound action:

| Event type | Action |
|------------|--------|
| `SessionStart` | sessionStart |
| `UserPromptSubmit` | promptSubmit |
| `PreToolUse` | toolRead/Write/Edit/Bash/Grep/Glob/WebFetch/Task/Other (by tool_name) |
| `Stop` | taskComplete |
| `SessionEnd` | sessionEnd |
| `SubagentStart` | subagentStart |
| `SubagentStop` | subagentStop |

Tool name → action mapping:
- Read → toolRead, Write → toolWrite, Edit → toolEdit, Bash → toolBash, Grep → toolGrep, Glob → toolGlob, WebFetch → toolWebFetch, Task → toolTask, all others → toolOther

---

## 25. Settings

### 25.1 Settings Store

`settingsStore` (Zustand) manages all user preferences with automatic `IndexedDB` persistence via `db.settings.put()`. Each setter calls `persistSetting(key, value)` which writes to the database and triggers a 2-second "autosave" flash indicator.

### 25.2 Complete Settings Reference

**Appearance:**

| Setting | Default | Type | Effect |
|---------|---------|------|--------|
| `themeName` | `'command-center'` | ThemeName | Sets `data-theme` on `document.body`; changes 3D scene colors |
| `fontSize` | `13` | number (px) | Sets `document.documentElement.style.fontSize` |
| `scanlineEnabled` | `true` | boolean | Toggles `no-scanlines` class on body |
| `animationIntensity` | `100` | number (0-200) | Sets `--anim-intensity` CSS variable (intensity/100) |
| `animationSpeed` | `100` | number (0-200) | Sets `--anim-speed` CSS variable (speed/100) |
| `characterModel` | `'robot'` | RobotModelType | Global default robot model for all sessions |

**Sound:**

| Setting | Default | Type |
|---------|---------|------|
| `soundSettings.enabled` | `true` | boolean |
| `soundSettings.volume` | `0.5` | 0-1 |
| `soundSettings.muteApproval` | `false` | boolean |
| `soundSettings.muteInput` | `false` | boolean |
| `soundSettings.perCli.claude` | Full profile at 0.7 | CliSoundConfig |
| `soundSettings.perCli.gemini` | Full profile at 0.7 | CliSoundConfig |
| `soundSettings.perCli.codex` | Full profile at 0.5 | CliSoundConfig |
| `soundSettings.perCli.openclaw` | Full profile at 0.7 | CliSoundConfig |

**Ambient:**

| Setting | Default | Type |
|---------|---------|------|
| `ambientSettings.enabled` | `false` | boolean |
| `ambientSettings.volume` | `0.3` | 0-1 |
| `ambientSettings.preset` | `'off'` | AmbientPreset |
| `ambientSettings.roomSounds` | `false` | boolean |
| `ambientSettings.roomVolume` | `0.2` | 0-1 |

**UI/UX:**

| Setting | Default | Type |
|---------|---------|------|
| `hookDensity` | `'medium'` | 'high'/'medium'/'low'/'off' |
| `activityFeedVisible` | `true` | boolean |
| `toastEnabled` | `true` | boolean |
| `autoSendQueue` | `false` | boolean |
| `defaultTerminalTheme` | `'auto'` | string |
| `compactMode` | `false` | boolean |
| `showArchived` | `false` | boolean |
| `groupBy` | `'none'` | BrowserSettings['groupBy'] |
| `sortBy` | `'activity'` | BrowserSettings['sortBy'] |

**Label settings** (per label): `{ sound, movement, frame }` — all configurable.

**API Keys** (persisted): `anthropicApiKey`, `openaiApiKey`, `geminiApiKey`

### 25.3 Theme System (9 themes)

| Name | Label | Preview colors |
|------|-------|---------------|
| command-center | Command Center | navy, cyan, orange |
| cyberpunk | Cyberpunk | deep purple, magenta, cyan |
| warm | Warm | cream, amber, copper |
| dracula | Dracula | dark, purple, green |
| solarized | Solarized | dark teal, teal, orange |
| nord | Nord | slate, sky blue, peach |
| monokai | Monokai | dark, cyan, pink |
| light | Light | light gray, blue, sky |
| blonde | Blonde | warm white, gold, dark gold |

### 25.4 Label Frame Effects

| Effect key | Display name |
|-----------|-------------|
| `none` | None |
| `fire` | Burning Fire |
| `electric` | Electric Surge |
| `chains` | Golden Aura |
| `liquid` | Liquid Energy |
| `plasma` | Plasma Overload |

### 25.5 Settings Panel UI

The settings panel (React, via `settingsStore` actions) has 6 tabs:
1. **Appearance** — theme picker (9 themes), font size, scanlines, animation speed/intensity, character model (6 robot variants)
2. **Sound** — master volume, enable/disable, per-action sound dropdowns, per-CLI profiles (claude/gemini/codex/openclaw)
3. **Ambient** — preset picker (5 presets), volume, room sounds toggle
4. **Labels** — per-label sound/movement/frame configuration
5. **Hooks** — hook density selector, install/uninstall buttons
6. **API Keys** — Anthropic, OpenAI, Gemini key inputs

**Import/Export**: Settings can be exported as JSON and imported to restore a configuration.

**Reset Defaults**: `resetDefaults()` restores all settings to defaults and persists them all.

---

## 26. Terminal Manager (Frontend) (`src/hooks/useTerminal.ts`, `src/components/terminal/`)

### 26.1 xterm.js Integration

The terminal is implemented via the `useTerminal` hook, which manages xterm.js lifecycle:

| Parameter | Value |
|-----------|-------|
| Font family | JetBrains Mono (fallbacks: Cascadia Code, Fira Code, Menlo) |
| Font size | Responsive: 11px (≤480w), 12px (≤640w), 14px (default) |
| Scrollback | 10,000 lines |
| Cursor | Bar, non-blinking |
| Resize debounce | 50ms (ResizeObserver) |
| Output buffer max | 500 pending items per terminal |
| First output refresh | 100ms delay |
| Setup retries | 60 at 50ms intervals (~3s timeout) |

**Addons loaded:** FitAddon, Unicode11Addon, WebLinksAddon.

**Hook returns:** `containerRef`, `attach()`, `detach()`, `isAttached`, `activeTerminalId`, `toggleFullscreen()`, `isFullscreen`, `sendEscape()`, `refitTerminal()`, `setTheme()`, `handleTerminalOutput()`, `handleTerminalReady()`, `handleTerminalClosed()`, `reparent()`, `scrollToBottom()`.

### 26.2 Terminal Themes (8 named + auto)

| Theme | Character |
|-------|-----------|
| `auto` | Matches the dashboard theme (default) |
| `dark` | Standard dark terminal |
| `light` | White background |
| `cyberpunk` | Magenta/cyan on deep purple |
| `dracula` | Dracula color scheme |
| `solarized` | Solarized dark |
| `nord` | Nord color scheme |
| `monokai` | Monokai colors |
| `warm` | Amber on cream |

Theme is applied on terminal creation and when the setting changes. `auto` resolves the theme from the current `themeName` in settings via `settingsStore.defaultTerminalTheme`.

### 26.3 Attach/Detach Lifecycle

**`attach(terminalId)`:**
1. Creates xterm Terminal instance with responsive font sizing
2. Loads addons (FitAddon, Unicode11Addon, WebLinksAddon)
3. Retries container mount up to 60 times (50ms interval) waiting for DOM ready
4. Opens terminal in container, fits to container dimensions
5. Flushes pending output buffer (up to 500 queued items)
6. Subscribes to terminal via WebSocket (`terminal_subscribe`)
7. Registers resize observer (50ms debounce) and data handler (`terminal_input`)
8. Forces canvas repaint via double-resize workaround

**`detach()`:**
1. Disconnects ResizeObserver
2. Disposes xterm Terminal instance
3. Clears active terminal reference

**Pending output buffering:** When a terminal is not attached (user viewing another tab), incoming `terminal_output` messages are queued in `pendingOutputRef` (max 500 items per terminal). On attach, the buffer is flushed immediately.

### 26.4 Canvas Repaint Workaround

xterm.js uses canvas rendering. A known issue causes the canvas to appear blank when first opened or resized. The `forceCanvasRepaint()` workaround:
1. Shrinks terminal by 1 column via `term.resize(cols-1, rows)`
2. Waits one animation frame
3. Re-fits via `fitAddon.fit()`
4. Sends updated dimensions to server via `terminal_resize`

### 26.5 Fullscreen Mode

The terminal tab has a fullscreen toggle:
- Reparents xterm container to a fullscreen wrapper
- Calls `fitAddon.fit()` after transition
- Escape key or toggle button exits fullscreen
- Resize observer handles dimension changes during transition

### 26.6 WebSocket Terminal Relay

Terminal I/O is relayed through the WebSocket connection:

| Message | Direction | Description |
|---------|-----------|-------------|
| `terminal_subscribe` | Client → Server | Register for output relay |
| `terminal_input` | Client → Server | User keystrokes |
| `terminal_output` | Server → Client | PTY output (base64-encoded) |
| `terminal_resize` | Client → Server | Terminal dimensions `{cols, rows}` (50ms debounced) |
| `terminal_disconnect` | Client → Server | Close PTY |
| `terminal_ready` | Server → Client | PTY spawned and ready |
| `terminal_closed` | Server → Client | PTY exited |

**Server-side:** `sshManager.ts` creates `node-pty` processes. Output is base64-encoded and relayed via WebSocket. Server maintains a 128KB output ring buffer per terminal for replay on reconnect.

**Escape key:** Always forwards `\x1b` to the SSH terminal (not consumed by UI keyboard shortcuts when xterm is focused).

### 26.7 Reconnect Button

Visible when session has `terminalId`, `lastTerminalId`, or `status === 'ended'`:
- If active terminal: sends resume command via WebSocket
- If no terminal: `POST /api/sessions/:id/resume` creates new PTY

---

## 33. Testing

### 33.1 Test Framework

The project uses two testing frameworks:
- **Vitest** for unit and integration tests (TypeScript/browser-compatible)
- **Playwright** for E2E tests (critical user flows)

### 33.2 Test Suite Size

**407 tests passing across 24 test files** (as of Feb 2025).

### 33.3 Test File Coverage

**Frontend/lib tests (Vitest):**

| File | What it tests |
|------|--------------|
| `src/lib/soundEngine.test.ts` | SoundEngine class — unlock, volume, action overrides, play/preview, dispose; ACTION_LABELS completeness; ACTION_CATEGORIES structure |
| `src/lib/wsClient.test.ts` | WebSocket client — connection, reconnect, message dispatch |
| `src/stores/sessionStore.test.ts` | Session CRUD, status transitions, team tracking |
| `src/stores/settingsStore.test.ts` | Settings read/write, persistence, defaults |
| `src/stores/roomStore.test.ts` | Room CRUD, session assignment/removal |
| `src/stores/uiStore.test.ts` | UI state management |
| `src/stores/queueStore.test.ts` | Prompt queue operations |
| `src/stores/wsStore.test.ts` | WebSocket store state |
| `src/hooks/useAuth.test.ts` | Auth hook behavior |

**Server tests (Vitest with Node environment):**

| File | What it tests |
|------|--------------|
| `test/hookProcessor.test.js` | Hook validation (null, non-object, missing fields, invalid types), processing SessionStart/Stop, latency calculation, alias fields |
| `test/sessionStore.test.js` | Session creation, matching, status transitions, deduplication |
| `test/sessionMatcher.test.js` | 5-priority session matching logic |
| `test/mqReader.test.js` | File-based message queue reading, partial line handling, truncation |
| `test/apiRouter.test.js` | REST API endpoints |
| `test/hookInstaller.test.js` | Hook script installation/uninstall |
| `test/portManager.test.js` | Port conflict resolution |
| `test/teamManager.test.js` | Team/subagent tracking |
| `test/approvalDetector.test.js` | Approval heuristic timeouts |
| `test/autoIdleManager.test.js` | Auto-idle timer logic |
| `test/processMonitor.test.js` | PID liveness checking |
| `test/wsManager.test.js` | WebSocket broadcast, ring buffer |
| `test/config.test.js` | Config loading and defaults |
| `test/constants.test.js` | Constants completeness |
| `test/hookStats.test.js` | Performance stats tracking |
| `test/serverConfig.test.js` | Server config file loading |

### 33.4 Sound Engine Test Details

The `soundEngine.test.ts` file demonstrates the testing pattern for Web Audio API code:

- `AudioContext` is mocked using a factory function (must use `function` keyword, not arrow, so `new AudioContext()` works)
- Mock provides: `createOscillator`, `createGain`, `resume`, `close`, with `vi.fn()` spies
- `vi.useFakeTimers()` controls `setTimeout` calls used by `playSequence`
- Tests verify: unlock/lock cycle, volume clamping (0-1), action override/restore, play returns true/false, sequence fires correct number of oscillators after `vi.runAllTimers()`, preview bypasses unlock check, dispose closes context

### 33.5 Running Tests

```bash
# Run all tests
npm test

# Watch mode
npm run test:watch

# With verbose reporter
npm test -- --reporter=verbose

# Coverage (if configured)
npm test -- --coverage
```

### 33.6 E2E Tests (Playwright)

Playwright E2E tests cover critical user flows:
- Dashboard load and session display
- Session card selection and detail panel
- Terminal session creation and interaction
- Settings persistence across reload
- Theme switching
- Keyboard shortcuts

E2E tests are located in the `test/e2e/` directory and configured in `playwright.config.ts`.
