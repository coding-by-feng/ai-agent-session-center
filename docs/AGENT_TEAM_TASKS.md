# Agent Team Tasks — Scene Improvements Round 2

## Task 1: Remove Ended Sessions from the 3D Map

### Problem

When a session's status becomes `ended`, the robot stays on the map in an "offline" state — slumped over with dimming visor and core. The user wants ended sessions to simply disappear from the 3D scene entirely. The robot body glow during working/prompting is sufficient visual feedback; dead robots cluttering the map are unwanted.

### Root Cause

In `src/components/3d/CyberdromeScene.tsx:84-101`, `SceneContent` iterates over ALL sessions from the store including ended ones:
```tsx
const sessionArray = useMemo(() => [...sessions.values()], [sessions]);
// ↑ includes ended sessions → renders offline robots
```

In `src/lib/robotStateMap.ts:31`, `ended` maps to `offline` robot state which renders a slumped, dimming robot with death animation. There's no filtering anywhere.

### Fix Required

1. **Filter out ended sessions** in `CyberdromeScene.tsx` `SceneContent`:
   ```tsx
   const sessionArray = useMemo(
     () => [...sessions.values()].filter(s => s.status !== 'ended'),
     [sessions],
   );
   ```

2. **Clean up workstation occupancy** when a session ends. In `SessionRobot.tsx`, the existing unmount cleanup (line 287-294) already releases the desk on unmount. Since filtering removes ended robots, React will unmount those `SessionRobot` components and the cleanup effect fires automatically. **Verify this works** — if the robot was seated at a desk, the desk should become available after the session ends.

3. **RobotListSidebar** (`src/components/3d/RobotListSidebar.tsx`): Also filter out ended sessions from the sidebar list:
   ```tsx
   const sessionArray = useMemo(() => {
     const arr = [...sessions.values()].filter(s => s.status !== 'ended');
     // ... sort logic
   }, [sessions]);
   ```

4. **SceneOverlay** (`src/components/3d/SceneOverlay.tsx`): The status breakdown at top-left still shows ended counts. This is fine to keep (informational), but if desired, can also be filtered.

5. **robotPositionStore cleanup**: When a session ends, the position should be cleaned up. The existing `useEffect` cleanup on unmount (line 418-422) already handles this since the component will unmount.

### Files to Modify

| File | Change |
|------|--------|
| `src/components/3d/CyberdromeScene.tsx` | Filter `sessionArray` to exclude `ended` sessions |
| `src/components/3d/RobotListSidebar.tsx` | Filter `sessionArray` to exclude `ended` sessions |

### Verification

1. `npx tsc --noEmit` — type check
2. `npx vitest run` — tests pass
3. Visual: when a session ends, its robot disappears from the 3D scene within 1 frame
4. Visual: ended sessions no longer appear in the right sidebar
5. Verify the desk the ended robot occupied becomes available for other robots

---

## Task 2: Door-Aware Pathfinding for Robots

### Problem

Robots currently navigate by walking in a straight line toward their target, bouncing off walls via `collidesAnyWall()`. When a robot inside a room wants to reach a destination outside (or vice versa), it gets stuck against walls because it doesn't know where the door is. It randomly picks a new wander direction when blocked, which is inefficient and unrealistic.

### Current Navigation Logic (`SessionRobot.tsx:296-368`)

```
1. Compute direction to target (dx, dz)
2. Rotate toward target
3. Step forward
4. If wall collision → try X-only, then Z-only, then pick new random target
```

This brute-force approach means robots frequently get stuck against walls, especially when their target is on the other side of a wall.

### Room Door Positions

Each room has exactly one door on the **south wall** (z = maxZ), centered at `(cx, 0, maxZ)` with `DOOR_GAP = 4` width. The door center is `(cx, 0, bounds.maxZ)` for each room.

### Fix Required — Waypoint-Based Door Navigation

Instead of walking in a straight line, robots should plan a path through doors when their target is in a different zone.

#### A. Add door waypoint computation (`src/lib/cyberdromeScene.ts`)

Add a function to compute door waypoints:

```ts
export interface DoorWaypoint {
  roomIndex: number;
  // Outside the door (south side, 1 unit past the wall)
  outside: THREE.Vector3;  // (cx, 0, bounds.maxZ + 1.0)
  // Inside the door (north side, 1 unit inside the wall)
  inside: THREE.Vector3;   // (cx, 0, bounds.maxZ - 1.0)
}

export function buildDoorWaypoints(rooms: RoomConfig[]): DoorWaypoint[] {
  return rooms.map(room => {
    const [cx] = room.center;
    const maxZ = room.bounds.maxZ;
    return {
      roomIndex: room.index,
      outside: new THREE.Vector3(cx, 0, maxZ + 1.0),
      inside: new THREE.Vector3(cx, 0, maxZ - 1.0),
    };
  });
}
```

#### B. Add pathfinding helper (`src/lib/cyberdromeScene.ts`)

```ts
/**
 * Compute a waypoint path from current position to target.
 * Returns an array of waypoints the robot should visit in order.
 * - If same zone or corridor→corridor: direct path (empty waypoints)
 * - If inside room → outside: [door.inside, door.outside, target]
 * - If outside → inside room: [door.outside, door.inside, target]
 * - If room A → room B: [doorA.inside, doorA.outside, doorB.outside, doorB.inside, target]
 */
export function computePathWaypoints(
  fromX: number,
  fromZ: number,
  target: THREE.Vector3,
  fromZone: number,       // getZone() result for current position
  targetZone: number,     // zone the target is in (-1 for corridor, -2 coffee, -3 gym, >=0 room)
  doors: DoorWaypoint[],
): THREE.Vector3[]
```

The logic:
1. If `fromZone === targetZone` → return `[target]` (direct path)
2. If `fromZone >= 0` (inside a room) and `targetZone !== fromZone`:
   - Get door for `fromZone` → add `door.inside`, `door.outside`
   - If `targetZone >= 0` → also add destination room's `door.outside`, `door.inside`
   - Add `target`
3. If `fromZone < 0` (corridor/casual) and `targetZone >= 0`:
   - Get door for `targetZone` → add `door.outside`, `door.inside`, `target`
4. If both `< 0` → return `[target]`

#### C. Update navigation in `SessionRobot.tsx`

Add a waypoint queue to the `NavState`:

```ts
interface NavState {
  // ... existing fields ...
  waypoints: THREE.Vector3[];  // NEW: queue of intermediate waypoints
  waypointIdx: number;         // NEW: current waypoint index
}
```

Navigation update logic change:
- When setting `nav.target` for NAV_GOTO or NAV_WALK to a different zone, call `computePathWaypoints()` and store the result in `nav.waypoints`
- In `useFrame`, instead of walking directly to `nav.target`:
  1. Walk to `nav.waypoints[nav.waypointIdx]`
  2. When within 0.5 of current waypoint, advance to next: `nav.waypointIdx++`
  3. When all waypoints consumed, proceed to the original arrival logic (seat at desk, etc.)

#### D. Pass doors to SessionRobot

In `CyberdromeScene.tsx`, compute doors alongside workstations and pass to `SessionRobot`:
```tsx
const doorWaypoints = useMemo(() => buildDoorWaypoints(roomConfigs), [roomConfigs]);
```

Add `doors: DoorWaypoint[]` to `SessionRobotProps`.

### Files to Modify

| File | Change |
|------|--------|
| `src/lib/cyberdromeScene.ts` | Add `DoorWaypoint` interface, `buildDoorWaypoints()`, `computePathWaypoints()` |
| `src/components/3d/SessionRobot.tsx` | Add `waypoints`/`waypointIdx` to `NavState`, update navigation in `useFrame` to follow waypoints, call `computePathWaypoints()` when setting targets |
| `src/components/3d/CyberdromeScene.tsx` | Compute `doorWaypoints`, pass as prop to `SessionRobot`, update `SceneContent` props |

### Verification

1. `npx tsc --noEmit`
2. `npx vitest run`
3. Visual: robot inside Room 0 gets assigned to Room 2 → walks to Room 0 door → exits → walks to Room 2 door → enters → sits at desk
4. Visual: unassigned robot in corridor transitions to working → walks to a room door → enters → sits at desk
5. Visual: robot leaving a room (idle→coffee) walks to door → exits → walks to coffee area
6. No robots getting permanently stuck against walls

---

## Task 3: Fix React Error #185 (Maximum Update Depth + WebGL Context Lost)

### Problem

When clicking a robot in the 3D scene, the app crashes with:
```
Uncaught Error: Minified React error #185 (Maximum update depth exceeded)
```
Followed by: `THREE.WebGLRenderer: Context Lost.`

React Error #185 means a component is calling `setState` during rendering in an infinite loop. The WebGL context loss is a consequence — the browser kills the GPU context when the main thread is frozen by the infinite loop.

### Root Cause Analysis

The existing code has multiple mitigations (memo on SessionRobot/RobotLabel, startTransition for selection, hardcoded `isSelected=false`, seatedRef) but the error still occurs. The remaining culprit is the **drei `<Html>` portal cascade**:

1. **RobotLabel** uses `<Html>` (drei) which creates a React portal from WebGL into DOM
2. **RobotDialogue** also uses `<Html>` — another portal per robot
3. When the user clicks a robot, `selectSession()` is called. Even though `SessionRobot` doesn't subscribe to `selectedSessionId`, **other components** (like `SceneOverlay`, `RobotListSidebar`, or the `DetailPanel` outside the Canvas) re-render. This can cause the R3F reconciler to flush, triggering `<Html>` portal reconciliation across all robots simultaneously.
4. Each `<Html>` portal update can trigger more state updates (drei's internal resize observer, portal container management), creating a cascade.

Additionally, `RobotDialogue` has `useEffect` with `visible`/`fadingOut` state that may chain-update:
- `text` prop changes → `setVisible(true)` → re-render → `useEffect` fires again if `visible` was already truthy in the deps closure

### Fix Required

#### A. Replace `<Html>` in RobotDialogue with 3D `<Text>` (`src/components/3d/RobotDialogue.tsx`)

The dialogue bubble is the most volatile component (updates on every tool call). Replace its `<Html>` portal with drei `<Text>` (troika SDF text rendered in WebGL), eliminating one portal per robot:

```tsx
// Instead of <Html> portal:
<Billboard position={[0, 2.8, 0]} follow>
  <Text fontSize={0.12} color="#fff" anchorX="center" anchorY="bottom" ...>
    {displayText}
  </Text>
</Billboard>
```

This removes the DOM portal entirely. The visual result is similar — a floating text above the robot — but rendered natively in WebGL with zero DOM reconciliation overhead.

#### B. Stabilize RobotLabel memo (`src/components/3d/RobotLabel.tsx`)

The current memo comparison doesn't check `session.toolLog` length but `RobotLabelInner` reads `session.toolLog?.length` for the "N tool calls" display. Add it:

```tsx
const RobotLabel = memo(RobotLabelInner, (prev, next) =>
  prev.session.sessionId === next.session.sessionId &&
  prev.session.status === next.session.status &&
  prev.session.title === next.session.title &&
  prev.session.projectName === next.session.projectName &&
  prev.session.label === next.session.label &&
  prev.session.currentPrompt === next.session.currentPrompt &&
  prev.session.model === next.session.model &&
  prev.session.startedAt === next.session.startedAt &&
  (prev.session.toolLog?.length ?? 0) === (next.session.toolLog?.length ?? 0) &&
  prev.robotState === next.robotState &&
  prev.isSelected === next.isSelected &&
  prev.isHovered === next.isHovered
);
```

#### C. Throttle dialogue state updates (`src/components/3d/SessionRobot.tsx`)

The `useEffect` that sets `dialogue` fires on every `session.toolLog` reference change. If the store updates toolLog frequently (e.g., rapid tool calls), this causes rapid re-renders. Add a throttle:

```tsx
// Only update dialogue if enough time has passed since the last update
const lastDialogueUpdate = useRef(0);
// In the useEffect:
const now = Date.now();
if (now - lastDialogueUpdate.current < 500) return; // throttle to 2Hz
lastDialogueUpdate.current = now;
```

#### D. Verify `SessionRobot` memo stability

The memo comparison includes `prev.session === next.session`. Since the store creates a new `Map` on every update, and the session object may be a new reference even when nothing changed for this particular robot, this could cause unnecessary re-renders.

Consider making the comparison more granular — compare `session.sessionId`, `session.status`, `session.toolLog`, etc. instead of `session` reference equality.

### Files to Modify

| File | Change |
|------|--------|
| `src/components/3d/RobotDialogue.tsx` | Replace `<Html>` portal with `<Billboard><Text>` (pure WebGL) |
| `src/components/3d/RobotLabel.tsx` | Add `toolLog.length` and `startedAt` to memo comparison |
| `src/components/3d/SessionRobot.tsx` | Throttle dialogue updates, improve memo comparison to avoid session reference equality |

### Verification

1. `npx tsc --noEmit`
2. `npx vitest run`
3. **Critical test**: Click a robot in the 3D scene — no Error #185, no WebGL context loss
4. Click multiple robots rapidly — stable
5. With 10+ robots active, click any robot — no crash
6. Dialogue bubbles still appear above robots for tool calls and status changes
7. Rebuild production: `npx vite build` — open in browser, reproduce the click test

---

## Task 4: Persist Robot Positions Across Page Refreshes

### Problem

When the user refreshes the browser, all robots spawn at random positions near the origin and must re-navigate to their desks/casual areas. The user wants robots to remember their position and status so that after a refresh, the 3D scene looks the same as before — robots that were seated stay seated, robots that were walking continue from where they left off.

### Current State

- `robotPositionStore` (`src/components/3d/robotPositionStore.ts`) is an in-memory `Map<string, {x, y, z}>` — lost on refresh
- `NavState` in `SessionRobot.tsx:126-138` initializes with random positions:
  ```ts
  posX: (Math.random() - 0.5) * 4,
  posY: 0,
  posZ: (Math.random() - 0.5) * 4,
  ```
- Workstation `occupantId` fields are in-memory only — lost on refresh

### Fix Required

#### A. Create a persistent position store (`src/lib/robotPositionPersist.ts`)

```ts
interface PersistedRobotState {
  posX: number;
  posY: number;
  posZ: number;
  rotY: number;
  mode: number;        // NAV_WALK, NAV_GOTO, NAV_SIT, NAV_IDLE
  deskIdx: number;     // which workstation the robot occupies (-1 if none)
  robotState: string;  // 'idle' | 'working' | etc
}

const STORAGE_KEY = 'cyberdrome-robot-positions';

export function saveRobotPositions(data: Map<string, PersistedRobotState>): void {
  // Convert to JSON and write to sessionStorage (survives refresh, not tab close)
  const obj: Record<string, PersistedRobotState> = {};
  data.forEach((v, k) => { obj[k] = v; });
  sessionStorage.setItem(STORAGE_KEY, JSON.stringify(obj));
}

export function loadRobotPositions(): Map<string, PersistedRobotState> {
  const raw = sessionStorage.getItem(STORAGE_KEY);
  if (!raw) return new Map();
  const obj = JSON.parse(raw) as Record<string, PersistedRobotState>;
  return new Map(Object.entries(obj));
}

export function clearRobotPositions(): void {
  sessionStorage.removeItem(STORAGE_KEY);
}
```

#### B. Periodically save positions (`src/components/3d/CyberdromeScene.tsx`)

Add a `useFrame` hook in `SceneContent` that throttles saves to every 2 seconds:

```tsx
const lastSave = useRef(0);
useFrame(() => {
  const now = performance.now();
  if (now - lastSave.current < 2000) return;
  lastSave.current = now;
  // Collect all NavState from SessionRobot refs → saveRobotPositions()
});
```

Alternatively, expose nav state from SessionRobot via a shared non-reactive store (similar to `robotPositionStore`) and have the save logic in `CyberdromeScene`.

#### C. Initialize SessionRobot from persisted state (`src/components/3d/SessionRobot.tsx`)

On mount, check if there's a persisted position for this session:

```tsx
const persisted = loadRobotPositions().get(session.sessionId);
const nav = useRef<NavState>({
  mode: persisted ? persisted.mode : NAV_WALK,
  target: new THREE.Vector3(),
  deskIdx: persisted ? persisted.deskIdx : -1,
  speed: 1.0 + Math.random() * 0.7,
  walkHz: 7 + Math.random() * 2,
  phase: Math.random() * Math.PI * 2,
  decisionTimer: 2 + Math.random() * 4,
  posX: persisted ? persisted.posX : (Math.random() - 0.5) * 4,
  posY: persisted ? persisted.posY : 0,
  posZ: persisted ? persisted.posZ : (Math.random() - 0.5) * 4,
  rotY: persisted ? persisted.rotY : Math.random() * Math.PI * 2,
});
```

If `persisted.deskIdx >= 0`, also restore `workstations[persisted.deskIdx].occupantId = session.sessionId` to reclaim the desk.

#### D. Extend `robotPositionStore` to also store nav state

Add a parallel `navStateStore` (non-reactive Map) that SessionRobot writes to every frame (or throttled). The save logic reads from this store.

### Files to Create/Modify

| File | Change |
|------|--------|
| `src/lib/robotPositionPersist.ts` | **NEW** — sessionStorage persistence for robot positions + nav state |
| `src/components/3d/SessionRobot.tsx` | Initialize `NavState` from persisted data; reclaim workstation desk; write nav state to shared store |
| `src/components/3d/robotPositionStore.ts` | Extend to also store nav mode, deskIdx, rotY |
| `src/components/3d/CyberdromeScene.tsx` | Add periodic save (every 2s) collecting all robot nav states |

### Verification

1. `npx tsc --noEmit`
2. `npx vitest run`
3. Open the 3D scene with multiple active sessions → robots navigate to desks and sit
4. Refresh the page (F5) → robots appear at the same positions, seated robots are still seated
5. Open DevTools → Application → Session Storage → verify `cyberdrome-robot-positions` key exists
6. Close tab and reopen → robots start fresh (sessionStorage only survives refresh, not close)

---

## Task 5: Relocate Casual Areas to North Side + Enhance Content

### Problem

The casual areas (Coffee Lounge & Gym) are currently placed **south** of the room grid (below the common area). The user wants them on the **north side** (behind the rooms, on the opposite side of the map). Additionally:
- Casual areas need visible **name labels** (like rooms have)
- Gym needs **at least 10 exercise devices** (currently only 4)
- Coffee area needs **coffee cups, a coffee pot, and a coffee machine** on the counter

### Current Placement (`src/lib/cyberdromeScene.ts:367-438`)

```
                ↑ North (z decreases)
[Coffee] [Gym]          ← User wants here (north of rooms)

[Room 0] [Room 1] [Room 2] [Room 3]    ← Dynamic rooms
[Room 4] [Room 5] ...

     [Common Area - 10 desks]           ← Corridor workstations

  [Coffee Lounge]     [Gym]             ← Currently here (south)
```

### Fix Required

#### A. Relocate casual areas to north of rooms (`src/lib/cyberdromeScene.ts`)

In `buildCasualAreas()`, change `baseZ` computation:

```ts
// BEFORE: south of common area
// baseZ = southmostCenter[2] + ROOM_HALF + ROOM_GAP + 5 + 8 + CASUAL_HALF + 2;

// AFTER: north of all rooms
const minRow = 0; // rooms start at row 0
const northmostCenter = computeRoomCenter(0); // row 0 is always the northernmost
baseZ = northmostCenter[2] - ROOM_HALF - ROOM_GAP - CASUAL_HALF;
// This places them above (north of) the first row of rooms
```

Also update `computeSceneBounds()` to account for the northward casual areas (add bounds check for negative Z values).

#### B. Add area name labels (`src/components/3d/RoomLabels.tsx` or new component)

Add labels for the casual areas similar to room labels. Either:
- Extend `RoomLabels` to also accept `CasualArea[]` and render labels
- Or create a small `CasualAreaLabels` component

Each casual area gets a ground-level 3D text label:
- Coffee: "COFFEE LOUNGE" in warm amber
- Gym: "FITNESS CENTER" in cool green/blue

Pass `casualAreas` from `CyberdromeScene.tsx` to the label component.

#### C. Expand gym to 10+ exercise devices (`src/components/3d/CyberdromeEnvironment.tsx`)

Current gym has 4 stations (bench press, treadmill, punching bag, weight rack). Expand to at least 10:

1. Bench press (existing)
2. Treadmill (existing)
3. Punching bag (existing)
4. Weight rack (existing)
5. **Rowing machine** — flat angled platform with handle bar
6. **Pull-up bar** — tall frame with horizontal bar at top
7. **Kettlebell station** — spheres on floor mat
8. **Stationary bike** — seat + handlebars + wheel
9. **Cable machine** — tall frame with pulley
10. **Battle ropes** — two cylinders (snaking lines) anchored to a post

Each device needs a station position in `buildCasualAreas()` for robot navigation. Expand the gym area size from 10 to ~16 to fit 10 stations in a grid layout:

```ts
// Expand gym size
const GYM_SIZE = 16;  // was using CASUAL_AREA_SIZE=10

// 10 stations in a 2×5 grid
const gymPositions = [];
for (let row = 0; row < 2; row++) {
  for (let col = 0; col < 5; col++) {
    gymPositions.push({
      x: gymX - 6 + col * 3,
      z: baseZ - 3 + row * 6,
      rot: row === 0 ? 0 : Math.PI,
    });
  }
}
```

#### D. Add coffee accessories to Coffee Lounge (`src/components/3d/CyberdromeEnvironment.tsx`)

Add to the existing `CoffeeLounge` component:

1. **Coffee machine** — on the counter: box with a cylinder spout + small panel
   ```tsx
   <group position={[cx - 2, 1.15, cz - 4.5]}>
     <mesh material={equipMat}><boxGeometry args={[0.4, 0.5, 0.35]} /></mesh>
     <mesh position={[0.1, 0.15, 0.2]} material={accentMat}>
       <cylinderGeometry args={[0.03, 0.03, 0.15, 6]} />
     </mesh>
   </group>
   ```

2. **Coffee pot** — on the counter: cylinder with handle
   ```tsx
   <group position={[cx + 1, 1.15, cz - 4.5]}>
     <mesh material={accentMat}><cylinderGeometry args={[0.08, 0.06, 0.2, 8]} /></mesh>
     <mesh position={[0.1, 0.05, 0]} material={equipMat}>
       <torusGeometry args={[0.06, 0.01, 4, 8, Math.PI]} />
     </mesh>
   </group>
   ```

3. **Coffee cups** — on each table: 2 small cylinders per table
   ```tsx
   <mesh position={[t.x - 0.15, 0.54, t.z + 0.1]} material={accentMat}>
     <cylinderGeometry args={[0.03, 0.025, 0.06, 6]} />
   </mesh>
   <mesh position={[t.x + 0.15, 0.54, t.z - 0.1]} material={accentMat}>
     <cylinderGeometry args={[0.03, 0.025, 0.06, 6]} />
   </mesh>
   ```

#### E. Update scene bounds for northward placement

In `computeSceneBounds()`, add check for negative Z (northward areas):
```ts
// Also check for casual areas north of rooms
if (rooms.length > 0) {
  const northCenter = computeRoomCenter(0);
  maxDist = Math.max(maxDist, Math.abs(northCenter[2] - ROOM_HALF - ROOM_GAP - CASUAL_HALF - 5));
}
```

### Files to Modify

| File | Change |
|------|--------|
| `src/lib/cyberdromeScene.ts` | Relocate `buildCasualAreas()` baseZ to north of rooms; expand gym to 10 stations; increase gym area size; update `computeSceneBounds()` for northward bounds |
| `src/components/3d/CyberdromeEnvironment.tsx` | Add 6 new gym devices to `GymArea`; add coffee machine, pot, cups to `CoffeeLounge`; adjust area floor size for expanded gym |
| `src/components/3d/RoomLabels.tsx` | Add casual area labels (or create `CasualAreaLabels` component in same file); accept `CasualArea[]` prop |
| `src/components/3d/CyberdromeScene.tsx` | Pass `casualAreas` to `RoomLabels` or new label component |

### Verification

1. `npx tsc --noEmit`
2. `npx vitest run`
3. `npx vite build`
4. Visual: casual areas appear **north** of the room grid (above rooms in the scene)
5. Visual: "COFFEE LOUNGE" and "FITNESS CENTER" labels on the ground near each area
6. Visual: gym has 10 distinct exercise devices
7. Visual: coffee counter has a coffee machine, pot, and cups on tables
8. Idle robots still navigate to coffee area; waiting robots still navigate to gym
9. Casual areas adapt colors when switching themes

---

## Task 6: Increase Robot Moving Speed Significantly

### Problem

Robots move too slowly across the map. When navigating between rooms, to casual areas, or to desks, the walking animation feels sluggish. The user wants robots to move **much faster** so transitions feel snappy and the scene feels alive.

### Current Speed Values

**Base speed** (`src/components/3d/SessionRobot.tsx:130`):
```ts
speed: 1.0 + Math.random() * 0.7,  // range: 1.0–1.7 units/sec
```

**Speed multipliers per state** (`src/lib/robotStateMap.ts:58-123`):
| State | `speedMultiplier` | Effective speed |
|-------|-------------------|-----------------|
| idle | 0.6 | 0.6–1.0 |
| thinking | 0.7 | 0.7–1.2 |
| working | 1.0 | 1.0–1.7 |
| waiting | 0.3 | 0.3–0.5 |
| alert | 0 | frozen |
| input | 0 | frozen |
| offline | 0 | frozen |
| connecting | 0 | frozen |

**Movement step** (`SessionRobot.tsx:325`):
```ts
const step = n.speed * behavior.speedMultiplier * dt;
```

**Turn rate** (`SessionRobot.tsx:322`):
```ts
n.rotY += diff * Math.min(1, 5 * dt);  // rotation smoothing factor: 5
```

### Fix Required

#### A. Increase base speed (`src/components/3d/SessionRobot.tsx`)

Triple the base speed range:
```ts
// BEFORE
speed: 1.0 + Math.random() * 0.7,   // 1.0–1.7

// AFTER
speed: 3.0 + Math.random() * 1.5,   // 3.0–4.5
```

#### B. Increase state speed multipliers (`src/lib/robotStateMap.ts`)

Bump multipliers so robots are never crawling:
| State | Before | After |
|-------|--------|-------|
| idle | 0.6 | 1.0 |
| thinking | 0.7 | 1.2 |
| working | 1.0 | 1.5 |
| waiting | 0.3 | 0.8 |
| alert | 0 | 0 (stay frozen) |
| input | 0 | 0 (stay frozen) |
| offline | 0 | 0 (stay frozen) |
| connecting | 0 | 0 (stay frozen) |

#### C. Increase turn rate (`src/components/3d/SessionRobot.tsx`)

Faster movement needs faster turning or robots overshoot corners:
```ts
// BEFORE
n.rotY += diff * Math.min(1, 5 * dt);

// AFTER
n.rotY += diff * Math.min(1, 10 * dt);
```

#### D. Increase walk animation frequency (`src/components/3d/SessionRobot.tsx`)

The walk bounce should match the faster speed so the animation doesn't look floaty:
```ts
// BEFORE
walkHz: 7 + Math.random() * 2,    // 7–9 Hz bounce

// AFTER
walkHz: 12 + Math.random() * 4,   // 12–16 Hz bounce
```

### Files to Modify

| File | Change |
|------|--------|
| `src/components/3d/SessionRobot.tsx` | Increase `speed` (3.0–4.5), `walkHz` (12–16), turn rate (5→10) |
| `src/lib/robotStateMap.ts` | Increase `speedMultiplier` for idle (1.0), thinking (1.2), working (1.5), waiting (0.8) |

### Verification

1. `npx tsc --noEmit`
2. `npx vitest run`
3. Visual: robots move noticeably faster when walking between locations
4. Visual: robots don't overshoot targets or jitter (turn rate matches speed)
5. Visual: walk bounce animation looks natural at the faster speed

---

## Execution Order & Parallelization Strategy

```
┌─────────────────┐  ┌─────────────────┐  ┌─────────────────┐
│  Task 1          │  │  Task 3          │  │  Task 6          │  ← Parallel (independent)
│  Remove ended    │  │  Fix Error #185  │  │  Increase speed  │
│  sessions        │  │  Html → Text     │  │  (robotStateMap) │
└────────┬────────┘  └────────┬────────┘  └────────┬────────┘
         │                     │                     │
         ▼                     ▼                     ▼
┌─────────────────┐  ┌─────────────────┐
│  Task 2          │  │  Task 4          │   ← Sequential (shared SessionRobot.tsx)
│  Door pathfind   │  │  Position persist│
│  (SessionRobot)  │  │  (SessionRobot)  │
└────────┬────────┘  └────────┬────────┘
         │                     │
         ▼                     ▼
      ┌─────────────────────────┐
      │  Task 5                  │   ← Sequential (touches shared layout files)
      │  Relocate casual areas   │
      │  + content enhancement   │
      └─────────────────────────┘
```

**Phase 1** (parallel): Task 1 + Task 3 + Task 6
- Task 1 modifies `CyberdromeScene.tsx` (filter) + `RobotListSidebar.tsx`
- Task 3 modifies `RobotDialogue.tsx` + `RobotLabel.tsx` + `SessionRobot.tsx` (memo/throttle only)
- Task 6 modifies `robotStateMap.ts` (speed multipliers) + `SessionRobot.tsx` (base speed, walkHz, turn rate)
- **Note**: Task 3 and Task 6 both touch `SessionRobot.tsx` but in different areas (memo/dialogue vs speed init). Run Task 6 after Task 3 if conflicts arise.

**Phase 2** (sequential): Task 2 → Task 4
- Task 2 modifies `cyberdromeScene.ts` (add pathfinding) + `SessionRobot.tsx` (navigation logic) + `CyberdromeScene.tsx` (pass doors)
- Task 4 creates `robotPositionPersist.ts` + modifies `SessionRobot.tsx` (init from persistence) + `robotPositionStore.ts` + `CyberdromeScene.tsx` (save loop)
- **Conflict on SessionRobot.tsx and CyberdromeScene.tsx** — must coordinate. Task 2 changes NavState structure + useFrame navigation; Task 4 changes NavState init + adds persistence write. Run sequentially with Task 2 first.

**Phase 3** (sequential): Task 5
- Modifies `cyberdromeScene.ts`, `CyberdromeEnvironment.tsx`, `RoomLabels.tsx`, `CyberdromeScene.tsx`
- Must run after Task 2 (which also modifies `cyberdromeScene.ts`)

**Recommended serial order if not parallelizing:**
1. Task 1 — smallest
2. Task 3 — fixes critical crash
3. Task 6 — speed increase (small, isolated)
4. Task 2 — navigation overhaul
5. Task 4 — persistence (depends on Task 2's NavState changes)
6. Task 5 — largest, content + relocation

## Build Commands

```bash
npx tsc --noEmit          # Type check
npx vitest run            # Test suite (407 tests)
npx vite build            # Production build to dist/
```
