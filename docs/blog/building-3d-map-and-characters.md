# Building a 3D Live Map and Animated Characters with React Three Fiber

One of the most distinctive parts of the AI Agent Session Center is its 3D visualization — a live cyberpunk "Cyberdrome" where each AI coding session is represented as an animated robot that walks around, sits at desks, and reacts to what it's doing in real time. This post walks through exactly how it's built, from the procedural geometry to the navigation AI.

---

## Why 3D?

The dashboard monitors multiple concurrent AI sessions (Claude Code, Gemini CLI, Codex). A flat list of status cards works fine for 5 sessions, but when you have 20+ agents running in parallel — some spawning subagents of their own — it becomes hard to understand what's happening at a glance. A spatial, animated view makes it immediately obvious: which robots are sitting and working, which are frozen waiting for approval, which are wandering idle.

The other reason: it's just fun to watch. Monitoring dashboards don't have to be boring.

---

## The Tech Stack

| Layer | Library |
|-------|---------|
| 3D rendering | Three.js |
| React integration | `@react-three/fiber` (R3F) |
| Helpers (billboard text, orbit controls) | `@react-three/drei` |
| State | Zustand (outside Canvas only) |
| Persistence | `sessionStorage` via a custom persist lib |

No external 3D assets are used. Every mesh — the floor, walls, desks, chairs, and all six robot model variants — is built from `BoxGeometry`, `SphereGeometry`, and `CylinderGeometry` primitives.

---

## Part 1: The 3D Map

### Scene Entry Point

Everything starts in [CyberdromeScene.tsx](../../src/components/3d/CyberdromeScene.tsx). It's the DOM-side wrapper that:

1. Reads all Zustand stores (sessions, rooms, settings, camera)
2. Pre-computes derived data (room configs, workstation positions, subagent connections)
3. Passes everything **down as props** into the `<Canvas>`

```tsx
// CyberdromeScene.tsx
export default function CyberdromeScene() {
  const sessions = useSessionStore((s) => s.sessions);
  const storeRooms = useRoomStore((s) => s.rooms);

  // All expensive calculations happen here, OUTSIDE Canvas
  const roomConfigs = useMemo(() => computeRoomConfigs(storeRooms), [storeRooms]);
  const workstations = useMemo(() => buildDynamicWorkstations(roomConfigs), [roomConfigs]);

  return (
    <div style={{ position: 'absolute', inset: 0 }}>
      <Canvas
        shadows
        camera={{ position: [18, 16, 18], fov: 50 }}
        gl={{ antialias: true, toneMapping: THREE.ACESFilmicToneMapping }}
      >
        <OrbitControls enableDamping dampingFactor={0.06} maxPolarAngle={Math.PI / 2.1} />
        <SceneContent rooms={roomConfigs} workstations={workstations} ... />
      </Canvas>
    </div>
  );
}
```

**Critical architectural rule: zero Zustand subscriptions inside `<Canvas>`.**

R3F runs its own React reconciler. Calling `useStore()` inside the Canvas tree creates subscriptions in a *different reconciler context*, which can cascade into React Error #185 (unmounted component state updates). The solution is to read all stores in the DOM wrapper and pass data in as plain props.

### Dynamic Room Grid

Rooms are not hardcoded — they're generated from `roomStore`, which is populated as sessions are grouped. The layout logic lives in [src/lib/cyberdromeScene.ts](../../src/lib/cyberdromeScene.ts).

Rooms are arranged in a grid with these constants:

```ts
export const ROOM_SIZE = 8;   // internal room dimension
export const ROOM_GAP = 2;    // corridor width between rooms
export const ROOM_CELL = ROOM_SIZE + ROOM_GAP; // 10
export const ROOM_COLS = 4;   // max rooms per row before wrapping
```

Each room gets a `RoomConfig`:

```ts
export interface RoomConfig {
  index: number;
  roomId: string;
  name: string;
  center: [number, number, number];
  bounds: { minX: number; maxX: number; minZ: number; maxZ: number };
  stripColor: 0 | 1;
}
```

The grid expands automatically as you add more rooms — rooms flow left-to-right then wrap to a new row, just like CSS `flex-wrap`.

### What the Environment Renders

[CyberdromeEnvironment.tsx](../../src/components/3d/CyberdromeEnvironment.tsx) takes the computed `RoomConfig[]` and renders the physical world:

**Floor** — a single large `PlaneGeometry`, slightly reflective:

```tsx
<mesh rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
  <planeGeometry args={[floorSize, floorSize]} />
  <meshStandardMaterial color="#0d0d1a" roughness={0.8} metalness={0.2} />
</mesh>
```

**Neon border strips** — four thin planes around each room's perimeter, rendered as a `<BorderGlow>` component. These pulse with `emissiveIntensity: 1.5` in the room's accent color, giving that cyberpunk grid-floor look.

**Desks and chairs** — each desk is a `<DeskWithChair>` group made of five box meshes: tabletop, two legs, a monitor frame, and a glowing screen surface. The screen color cycles through the neon palette per workstation:

```tsx
<mesh position={[0, 0.92, -0.185]}>
  <boxGeometry args={[0.44, 0.28, 0.005]} />
  <meshStandardMaterial
    color={screenColor}
    emissive={screenColor}
    emissiveIntensity={0.6}
  />
</mesh>
```

**Lighting** — a combination of ambient, directional (with shadows), and per-room point lights in the room's accent color.

**Fog** — exponential fog tied to the scene theme:

```tsx
<fogExp2 attach="fog" args={[sceneTheme.background, sceneTheme.fogDensity]} />
```

### Workstation Positions

`buildDynamicWorkstations()` returns an array of `Workstation` objects — one per desk:

```ts
export interface Workstation {
  idx: number;
  zone: number;       // room index (-1 = corridor, -2 = casual area)
  seatPos: THREE.Vector3;
  faceRot: number;    // which direction the robot faces when seated
  occupantId: string | null;
}
```

The `occupantId` field is the key to desk-claiming: when a robot navigates to a desk, it writes its `sessionId` into `occupantId`. Other robots filter out occupied desks when looking for a seat.

Desks are arranged in rows inside each room. Corridor workstations sit between rooms along the connecting paths. A separate "casual area" (zone `-2`) holds a coffee station for idle robots.

### Door Waypoints

Robots navigate between rooms through doorways. Each room has a south and north door, represented as `DoorWaypoint` objects:

```ts
export interface DoorWaypoint {
  roomIndex: number;
  side: 'south' | 'north';
  outside: THREE.Vector3;  // 1 unit past the doorway, outside
  inside: THREE.Vector3;   // 1 unit past the doorway, inside
}
```

`computePathWaypoints()` resolves a path for cross-room navigation:

```
from corridor → exit door (outside point) → enter room (inside point) → desk seat
```

If the robot is already in the same zone as the target, it walks directly.

---

## Part 2: The Robot Character

### Shared Geometry — One Allocation, All Instances

All geometry is defined once in [src/lib/robot3DGeometry.ts](../../src/lib/robot3DGeometry.ts) and shared across every robot instance:

```ts
export const robotGeo = {
  head:    new THREE.BoxGeometry(0.28, 0.24, 0.26),
  visor:   new THREE.BoxGeometry(0.24, 0.065, 0.02),
  antenna: new THREE.CylinderGeometry(0.007, 0.007, 0.14, 4),
  aTip:    new THREE.SphereGeometry(0.02, 6, 6),
  torso:   new THREE.BoxGeometry(0.32, 0.38, 0.2),
  core:    new THREE.SphereGeometry(0.032, 8, 8),
  joint:   new THREE.SphereGeometry(0.035, 8, 8),
  arm:     new THREE.BoxGeometry(0.08, 0.26, 0.08),
  leg:     new THREE.BoxGeometry(0.09, 0.28, 0.09),
  foot:    new THREE.BoxGeometry(0.1, 0.045, 0.12),
};
```

This is the classic instancing pattern: since geometry is immutable, every robot shares the same GPU buffer. Only materials and transforms differ per instance.

### The Color Palette

Each session gets a unique neon color from a 16-color cyberpunk palette:

```ts
export const PALETTE = [
  '#00f0ff', '#ff00aa', '#a855f7', '#00ff88',
  '#ff4444', '#ffaa00', '#00aaff', '#ff66ff',
  // ...
] as const;
```

Material pools are pre-built for the entire palette at startup:

```ts
export const neonMats = PALETTE.map((h) => createNeonMat(h));
export const edgeMats = PALETTE.map((h) => createEdgeMat(h));
```

When a robot's color matches one of the 16 palette colors, it reuses the shared material. Custom accent colors (set per-session) get freshly created materials that are disposed on unmount.

### Robot Model Variants

There are six model types defined in [src/lib/robot3DModels.ts](../../src/lib/robot3DModels.ts): `robot`, `mech`, `drone`, `spider`, `orb`, `tank`. Each variant overrides geometry and positions for specific body parts:

```ts
const modelDefs: Record<RobotModelType, ModelDef> = {
  drone: {
    head: {
      geometry: new THREE.SphereGeometry(0.14, 8, 8), // sphere head
      position: [0, 1.2, 0],
    },
    torso: {
      geometry: new THREE.BoxGeometry(0.28, 0.18, 0.28), // flat body
    },
    armL: {
      geometry: new THREE.BoxGeometry(0.22, 0.04, 0.06), // rotor arms
      position: [-0.25, 0.95, 0],
    },
    legL: { visible: false }, // drones don't have legs
    legR: { visible: false },
    hovers: true,
    baseY: 0.3,
  },
  // ...
};
```

`Robot3DModel` resolves which geometry to use at render time:

```ts
const headGeo = modelDef.head.geometry ?? robotGeo.head;
const headPos = modelDef.head.position ?? [0, 1.32, 0];
```

### The Robot JSX Structure

[Robot3DModel.tsx](../../src/components/3d/Robot3DModel.tsx) assembles the body from parts using pivot `<group>` nodes for animated joints:

```tsx
<group ref={groupRef} position={[0, modelDef.baseY, 0]} rotation={[0, rotation, 0]}>
  {/* Head */}
  <mesh ref={headRef} geometry={headGeo} material={metalMat} position={headPos} castShadow />
  <lineSegments geometry={headEdgeGeo} material={edgeMat} position={headPos} />

  {/* Visor — neon glow stripe */}
  <mesh ref={visorRef} geometry={robotGeo.visor} material={visorMat} position={[...]} />

  {/* Torso with per-instance cloned material (animations mutate it) */}
  <mesh ref={bodyMeshRef} geometry={torsoGeo} material={bodyMat} position={torsoPos} castShadow />
  <lineSegments ref={bodyEdgeRef} geometry={torsoEdgeGeo} material={bodyEdgeMat} position={torsoPos} />

  {/* Core energy sphere */}
  <mesh ref={coreRef} geometry={robotGeo.core} material={neonMat} position={[...]} />

  {/* Left arm — pivot group so rotation.x animates the whole arm */}
  <group ref={armLRef} position={armLPos}>
    <mesh geometry={armLGeo} material={darkMat} position={[0, -0.18, 0]} castShadow />
  </group>

  {/* Right arm */}
  <group ref={armRRef} position={armRPos}>
    <mesh geometry={armRGeo} material={darkMat} position={[0, -0.18, 0]} castShadow />
  </group>
</group>
```

The wireframe edges (`<lineSegments>` with `EdgesGeometry`) are the signature visual — each body part has a neon outline that makes the boxy shapes look like they're drawn with light.

**Why per-instance cloned materials for the body?**
The `working` animation mutates `emissive` and `emissiveIntensity` on the body material every frame. If the shared palette material were used directly, all robots with the same color would flash simultaneously. Cloning the material per robot isolates the mutation.

### The Animation State Machine

Session status maps to a `Robot3DState` enum in [src/lib/robotStateMap.ts](../../src/lib/robotStateMap.ts):

```ts
const STATUS_TO_ROBOT_STATE: Record<SessionStatus, Robot3DState> = {
  idle:       'idle',
  prompting:  'thinking',
  working:    'working',
  waiting:    'waiting',
  approval:   'alert',
  input:      'input',
  ended:      'offline',
  connecting: 'connecting',
};
```

Each state drives a different `animateXxx()` function inside `useFrame`. All animation is done by **directly mutating `ref.current.rotation` and `ref.current.position`** — no React state, no re-renders.

Here's the idle animation:

```ts
function animateIdle(t: number, ph: number, ai: number) {
  const group = groupRef.current!;
  group.position.y = Math.sin(t * 1.5 + ph) * 0.02 * ai; // gentle float
  armLRef.current!.rotation.x = Math.sin(t * 0.8 + ph) * 0.08 * ai;  // arm sway
  armRRef.current!.rotation.x = -Math.sin(t * 0.8 + ph) * 0.08 * ai;
  bodyMeshRef.current!.rotation.z = Math.sin(t * 0.5 + ph) * 0.01 * ai; // body rock
}
```

The `ph` (phase) parameter is a random offset per robot so they don't all sway in sync. `ai` is an animation intensity setting (0–100) from the settings store.

### Tool-Specific Working Animations

When a robot is `working`, the active tool drives a sub-animation. Tool names are classified into categories:

```ts
function classifyTool(toolName: string): ToolAnimCategory {
  if (t === 'read' || t === 'grep' || t === 'glob') return 'read';
  if (t === 'write' || t === 'edit')                 return 'write';
  if (t === 'bash')                                  return 'bash';
  if (t === 'webfetch' || t === 'websearch')         return 'web';
  if (t === 'task')                                  return 'task';
  return 'default';
}
```

Each category has a unique pose:

| Tool Category | Animation |
|---------------|-----------|
| `read` | Head scans left-right (like reading a file) |
| `write` | Both arms rapidly typing |
| `bash` | One arm extended forward |
| `task` | Both arms raised (directing subagents) |
| `web` | Antenna crackles with extra-bright emissive |

### The "Charging Body" Effect

When working, the robot's entire body gets an electrified look through material mutations each frame:

```ts
// Edge wireframe: electric surge flicker
if (bodyEdgeRef.current) {
  const surge = 1.0 + Math.sin(t * 12 + ph) * 0.4 + Math.sin(t * 23 + ph * 2) * 0.3;
  edgeMtl.opacity = Math.min(1, 0.6 + surge * 0.2);
}

// Core glow: rapid pulsing
coreMtl.emissiveIntensity = 2.0 + Math.sin(t * 8 + ph) * 1.2 + Math.sin(t * 19) * 0.6;

// Visor: brightened and flickering
visorMtl.emissiveIntensity = 2.0 + Math.sin(t * 10 + ph) * 0.8 + Math.sin(t * 17) * 0.4;

// Body mesh: neon color emissive glow
bodyMtl.emissive.set(neonColor);
bodyMtl.emissiveIntensity = 0.15 + Math.sin(t * 14 + ph) * 0.1;
```

The double-frequency sine waves (e.g., `t * 12` and `t * 23`) create a non-periodic beat that feels more organic than a single oscillation.

### Alert Urgency Escalation

When a robot enters `approval` state (waiting for the user to approve a tool call), the visor flashes yellow. The longer it waits, the more urgent the flash:

```ts
function animateAlert(t: number, ph: number, ai: number, elapsed: number) {
  const baseIntensity = elapsed > 30 ? 2.5 : 1.5;
  const pulseRange   = elapsed > 30 ? 1.5 : 1.0;
  const pulseSpeed   = elapsed > 15 ? 12  : 8;

  const intensity = baseIntensity + Math.sin(t * pulseSpeed) * pulseRange;
  visorRef.current!.material.emissiveIntensity = intensity;

  // 30s+: add subtle body shake
  if (elapsed > 30) {
    group.position.x = Math.sin(t * 16 + ph) * 0.03 * ai;
  }
}
```

The `elapsed` time comes from `statusStartTimeRef` — a ref that resets whenever `session.status` changes. This escalates urgency without any scheduled timers.

### CLI Badge on the Chest

Each robot displays a small letter on its chest indicating which AI CLI it belongs to:

```ts
const CLI_BADGES: Record<string, CliBadge> = {
  claude: { letter: 'C', color: '#00f0ff' },
  gemini: { letter: 'G', color: '#4285f4' },
  codex:  { letter: 'X', color: '#10a37f' },
};
```

It's rendered as a `<Billboard><Text>` from `@react-three/drei` — a text mesh that always faces the camera:

```tsx
<Billboard position={[0, 0.81, 0.12]} follow>
  <Text fontSize={0.14} color={cliBadge.color} anchorX="center" anchorY="middle">
    {cliBadge.letter}
    <meshStandardMaterial emissive={cliBadge.color} emissiveIntensity={0.8} />
  </Text>
</Billboard>
```

---

## Part 3: Navigation AI

### The NavState

Each robot has a `NavState` ref — not React state, so mutations never trigger re-renders:

```ts
interface NavState {
  mode: number;          // NAV_WALK | NAV_GOTO | NAV_SIT | NAV_IDLE
  target: THREE.Vector3;
  deskIdx: number;       // index into workstations[], -1 = no desk
  speed: number;         // 1.2–1.8 (randomized per robot)
  walkHz: number;        // walk bounce frequency
  phase: number;         // random offset for desync
  decisionTimer: number;
  posX: number;
  posY: number;
  posZ: number;
  rotY: number;
  waypoints: THREE.Vector3[];
  waypointIdx: number;
}
```

### State → Behavior Mapping

`RobotStateBehavior` describes what a robot *wants* to do given its current state:

```ts
const STATE_BEHAVIORS = {
  idle:    { seekDesk: false, wander: false, casualTarget: 'coffee', speedMultiplier: 1.0 },
  working: { seekDesk: true,  wander: false, casualTarget: null,     speedMultiplier: 1.2 },
  alert:   { seekDesk: false, wander: false, casualTarget: null,     speedMultiplier: 0   },
  // ...
};
```

When the session status changes, a `useEffect` reads these behaviors and updates `nav.current`:

- `working` → find an available desk in the assigned room, set `NAV_GOTO`
- `idle` / `waiting` → find a coffee station, set `NAV_GOTO`
- `approval` / `input` → freeze in place, set `NAV_IDLE`
- `ended` → freeze, set `NAV_IDLE`

### Movement in useFrame

The actual movement loop runs in `useFrame`, throttled to every 3rd frame to save CPU:

```ts
useFrame((_, delta) => {
  if ((navFrameCounter.current++ + navFrameOffset.current) % 3 !== 0) return;
  const dt = Math.min(delta * 3, 0.15); // compensate for frame skip

  const dx = n.target.x - n.posX;
  const dz = n.target.z - n.posZ;
  const dist = Math.sqrt(dx * dx + dz * dz);

  if (dist < 0.5) {
    // Arrived at waypoint — advance or sit
    if (n.mode === NAV_GOTO) seatAt(n, workstations);
    else pickNewWanderTarget();
    return;
  }

  // Rotate toward target (smooth lerp)
  const want = Math.atan2(dx, dz);
  n.rotY += angleDiff(want, n.rotY) * Math.min(1, 10 * dt);

  // Step forward
  const step = n.speed * behavior.speedMultiplier * dt;
  const nx = n.posX + Math.sin(n.rotY) * step;
  const nz = n.posZ + Math.cos(n.rotY) * step;

  // Wall collision: try X-only or Z-only slide if full move blocked
  if (!collidesAnyWall(nx, nz, wallRects)) {
    n.posX = nx; n.posZ = nz;
  } else if (!collidesAnyWall(nx, n.posZ, wallRects)) {
    n.posX = nx; // slide along Z wall
  } else if (!collidesAnyWall(n.posX, nz, wallRects)) {
    n.posZ = nz; // slide along X wall
  }

  // Walk bounce
  n.posY = Math.abs(Math.sin((performance.now() / 1000) * n.walkHz * 2 + n.phase)) * 0.03;
});
```

The staggered frame offset (`navFrameOffset = Math.floor(Math.random() * 3)`) means robots' expensive nav AI doesn't all land on the same frame.

### Seating

When `dist < 0.5` and `mode === NAV_GOTO`, the robot snaps to the desk's exact seat:

```ts
function seatAt(nav: NavState, workstations: Workstation[]) {
  const ws = workstations[nav.deskIdx];
  nav.mode = NAV_SIT;
  nav.posX = ws.seatPos.x;
  nav.posY = -0.12;  // lower slightly (sitting down)
  nav.posZ = ws.seatPos.z;
  nav.rotY = ws.faceRot; // face the monitor
}
```

The `seatedRef` boolean is checked by `Robot3DModel` in its own `useFrame` to switch leg angles from the walking pose (legs swinging) to the seated pose (legs bent at 1.2 rad).

### Position Persistence

Robot positions are saved to `sessionStorage` every 2 seconds, so when you refresh the page robots reappear where they were:

```ts
// CyberdromeScene.tsx
useEffect(() => {
  const interval = setInterval(() => {
    const persistMap = new Map<string, PersistedRobotState>();
    getAllNavInfo().forEach((info, id) => {
      persistMap.set(id, { posX: info.x, posZ: info.z, rotY: info.rotY, mode: info.mode, deskIdx: info.deskIdx });
    });
    saveRobotPositions(persistMap);
  }, 2000);
  return () => clearInterval(interval);
}, []);
```

On robot mount, the persisted position is read back:

```ts
const persisted = loadRobotPositions().get(session.sessionId);
const initPosX = persisted ? persisted.posX : (Math.random() - 0.5) * 4;
```

`NAV_GOTO` is reset to `NAV_WALK` on restore — the robot can't resume mid-navigation, but it restores the desk claim if it was seated (`NAV_SIT`).

---

## Part 4: Dialogue Bubbles and Labels

### Dialogue Bubbles — Pure Ref, No useState

The speech bubbles that appear above robots (e.g., "Reading utils.ts...", "AWAITING APPROVAL") are driven by a `dialogueRef`, not React state:

```ts
const dialogueRef = useRef<{
  text: string;
  borderColor: string;
  persistent: boolean;
  timestamp: number;
} | null>(null);
```

A `useEffect` writes to this ref on status/tool changes. `RobotDialogue` reads it in its own `useFrame` to update the visible text. This design eliminates any React state updates from the R3F render tree.

Tool-to-dialogue mapping:

```ts
if (toolName === 'Bash') {
  dialogueRef.current = { text: `$ ${cmd}`, borderColor: '#ff9100', persistent: false };
} else if (toolName === 'Edit' || toolName === 'Write') {
  const filename = extractFilename(input);
  dialogueRef.current = { text: `Editing ${filename}...`, borderColor: '#00aaff', persistent: false };
} else if (toolName === 'Task') {
  dialogueRef.current = { text: 'Spawning agent...', borderColor: '#aa66ff', persistent: false };
}
```

### Robot Click → Store Update Pattern

Clicking a robot needs to update the Zustand `sessionStore` to select it and fly the camera. But dispatching a Zustand action from inside R3F's pointer event causes a cross-reconciler cascade. The solution uses a `CustomEvent` bridge:

```ts
// Inside Canvas (R3F)
const handleClick = useCallback((e: ThreeEvent<MouseEvent>) => {
  e.stopPropagation();
  onSelect(session.sessionId);
}, []);

// onSelect dispatches a CustomEvent, not a store action
const handleSelect = useCallback((sessionId: string) => {
  setTimeout(() => {
    window.dispatchEvent(new CustomEvent('robot-select', { detail: { sessionId } }));
  }, 0);
}, []);
```

```ts
// In the DOM wrapper (CyberdromeScene)
useEffect(() => {
  const handler = (e: Event) => {
    const { sessionId } = (e as CustomEvent).detail;
    selectSession(sessionId);      // Zustand update — safe, in DOM context
    flyTo([...]);                  // Camera animation
  };
  window.addEventListener('robot-select', handler);
  return () => window.removeEventListener('robot-select', handler);
}, []);
```

The `setTimeout(..., 0)` defers the dispatch until after R3F's pointer event cycle completes.

---

## Part 5: Performance Considerations

### Memoized SessionRobot

`SessionRobot` is wrapped in `React.memo` with a granular comparator that only re-renders when session fields that actually affect the visual change:

```ts
const SessionRobot = memo(SessionRobotInner, (prev, next) =>
  prev.session.status === next.session.status &&
  prev.session.accentColor === next.session.accentColor &&
  (prev.session.toolLog?.length ?? 0) === (next.session.toolLog?.length ?? 0) &&
  // ... 14 more fields
);
```

Without this, every WebSocket message that touches any session field would re-render all robots simultaneously.

### Frame Throttling

Navigation AI runs every 3rd frame per robot. Store writes (position persistence) also run every 3rd frame. The random stagger offset means robots' expensive operations land on different frames across the animation loop.

### Geometry Sharing vs. Material Cloning

- **Geometry**: fully shared — all instances reference the same GPU buffer via `robotGeo.*`
- **Edge geometries**: created per-instance via `new THREE.EdgesGeometry(...)` because they need to be disposed individually on unmount
- **Neon/edge materials**: shared from the pre-built palette pool when color matches; cloned when custom
- **Body material**: always cloned per instance because the `working` animation mutates `emissive` each frame

---

## Summary

The Cyberdrome is built from:

1. **A dynamic room grid** computed from `roomStore` via `computeRoomConfigs()` — rooms appear and resize as sessions are grouped
2. **Procedural geometry** — every mesh is a primitive (Box, Sphere, Cylinder), no external assets
3. **A shared geometry + per-instance material pattern** — geometry GPU buffers are reused across all robots
4. **A ref-based animation loop** — all animation mutates `ref.current.*` in `useFrame`, never via React state
5. **A behavior-driven navigation AI** — session status maps to behaviors (seekDesk, casualTarget, freeze), and a per-robot `NavState` ref drives movement each frame
6. **A CustomEvent bridge** for click interactions — Zustand store updates stay in the DOM reconciler, completely separate from R3F

The result is a scene that can handle 20+ animated robots at 60fps with real-time hook data flowing in, without cross-reconciler state bugs.
