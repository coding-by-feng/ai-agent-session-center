# Cyberdrome 3D Robot → Agent Manager Adaptation Guide

Replace the 20 CSS-only 2D character models on session cards with interactive Three.js 3D robotic characters driven by real session state.

---

## Architecture Overview

```
CURRENT (agent-manager)                    TARGET
─────────────────────────────────────────────────────────────────
SessionCard                                SessionCard
  └─ .robotViewport (empty div)              └─ <Robot3DViewport>
       ↓ styled by CSS                            ↓ Three.js canvas
       CharacterModel (20 CSS divs)                Robot3D (boxy mech)
       data-status → CSS keyframes                 sessionStatus → 3D state machine
       --robot-color → CSS var                     neonColor → emissive material
```

### What Gets Replaced

| Current | Replacement |
|---------|-------------|
| `src/components/character/CharacterModel.tsx` | `src/components/character/Robot3DModel.tsx` |
| `src/components/character/RobotViewport.tsx` | `src/components/character/Robot3DViewport.tsx` |
| `src/components/character/CharacterSelector.tsx` | Updated to show 3D previews |
| `src/styles/characters/*.css` (22 files, ~80KB) | Removed (Three.js handles visuals) |
| `src/styles/animations.css` (48KB) | Reduced (keep card glow/border effects only) |

### What Stays Unchanged

- `SessionCard.tsx` — only the `.robotViewport` child changes
- `SessionCard.module.css` — card border/glow/status-badge CSS stays
- `sessionStore.ts`, `settingsStore.ts` — no schema changes
- `session.ts` types — `AnimationState` finally gets used
- Server/WebSocket/API — zero backend changes

---

## Technical Stack Delta

```
NEW DEPENDENCIES
────────────────
three              ^0.160.0    # 3D engine
@react-three/fiber ^8.15.0     # React reconciler for Three.js
@react-three/drei  ^9.92.0     # Helpers (OrbitControls, useGLTF, etc.)
```

```bash
cd /Users/kasonzhan/Documents/claude/agent-manager
npm install three @react-three/fiber @react-three/drei
npm install -D @types/three
```

---

## Session Status → 3D State Machine

The current CSS system drives animations via `data-status`. The 3D system maps the same `SessionStatus` values to robot behavior states:

```typescript
// src/lib/robotStateMap.ts

import type { SessionStatus } from '@/types/session'

export type Robot3DState =
  | 'idle'        // gentle hover, slow blink, antenna pulse
  | 'thinking'    // head tilt, eye glow cycle, antenna fast pulse
  | 'working'     // seated at desk, typing animation, sweat particles
  | 'waiting'     // standing, looking around, slow bounce
  | 'alert'       // urgent bounce, visor flash yellow, floating "!"
  | 'input'       // gentle sway, visor flash purple, floating "?"
  | 'offline'     // powered down, dim materials, no glow
  | 'connecting'  // boot-up sequence, parts assembling

export function mapStatusTo3D(status: SessionStatus): Robot3DState {
  const map: Record<SessionStatus, Robot3DState> = {
    idle:        'idle',
    prompting:   'thinking',
    working:     'working',
    waiting:     'waiting',
    approval:    'alert',
    input:       'input',
    ended:       'offline',
    connecting:  'connecting',
  }
  return map[status]
}
```

### Animation Details Per State

| Robot3DState | Body | Arms | Legs | Visor | Core | Special |
|---|---|---|---|---|---|---|
| `idle` | gentle Y bob (sin, 0.03 amp) | rest at sides | standing | neon color, slow pulse | slow pulse | antenna tip pulse |
| `thinking` | slight lean forward | one arm to chin | standing | brighter, faster pulse | fast pulse | head tilt L/R |
| `working` | seated (y=-0.12) | typing oscillation (±0.05) | bent forward (1.2 rad) | steady bright | rapid pulse | sweat particle emitter* |
| `waiting` | bounce (sin, 0.08 amp) | slight swing | standing | blue tint | blue pulse | look-around head rotation |
| `alert` | urgent bounce (fast) | raised | standing | **yellow**, flash | **yellow**, urgent | floating "!" mesh, shake |
| `input` | gentle sway | one raised (question) | standing | **purple**, gentle | **purple** | floating "?" mesh |
| `offline` | static, y=-0.05 | limp at sides | standing | **grey**, no glow | **off** | dim all emissive to 0 |
| `connecting` | scale 0→1 over 1s | animate into position | animate into position | flicker on | boot pulse | parts "assemble" |

*Sweat particle = small sphere emitter near head, matches the CSS sweat-drop effect

---

## File-by-File Implementation Plan

### 1. `src/lib/robot3DGeometry.ts` — Shared Geometry + Materials

Extract from `index.html` lines 430-460. All geometries created once, shared across all robot instances.

```typescript
// src/lib/robot3DGeometry.ts
import * as THREE from 'three'

// Shared geometries (create once, reuse for every robot)
export const robotGeo = {
  head:     new THREE.BoxGeometry(0.28, 0.24, 0.26),
  visor:    new THREE.BoxGeometry(0.24, 0.065, 0.02),
  antenna:  new THREE.CylinderGeometry(0.007, 0.007, 0.14, 4),
  aTip:     new THREE.SphereGeometry(0.02, 6, 6),
  torso:    new THREE.BoxGeometry(0.32, 0.38, 0.2),
  core:     new THREE.SphereGeometry(0.032, 8, 8),
  joint:    new THREE.SphereGeometry(0.035, 8, 8),
  arm:      new THREE.BoxGeometry(0.08, 0.26, 0.08),
  leg:      new THREE.BoxGeometry(0.09, 0.28, 0.09),
  foot:     new THREE.BoxGeometry(0.1, 0.045, 0.12),
}

export const robotEdgeGeo = {
  head:  new THREE.EdgesGeometry(robotGeo.head),
  torso: new THREE.EdgesGeometry(robotGeo.torso),
  arm:   new THREE.EdgesGeometry(robotGeo.arm),
  leg:   new THREE.EdgesGeometry(robotGeo.leg),
}

// Shared metallic body materials (same for all robots)
export const metalMat = new THREE.MeshStandardMaterial({
  color: '#2a2a3e', roughness: 0.3, metalness: 0.85,
})
export const darkMat = new THREE.MeshStandardMaterial({
  color: '#1c1c2c', roughness: 0.4, metalness: 0.7,
})

// Per-color neon materials (pooled by the 8-color palette)
export function createNeonMat(hex: string) {
  const c = new THREE.Color(hex)
  return new THREE.MeshStandardMaterial({
    color: c, emissive: c, emissiveIntensity: 2,
    roughness: 0.2, metalness: 0.3,
  })
}

export function createEdgeMat(hex: string) {
  return new THREE.LineBasicMaterial({
    color: hex, transparent: true, opacity: 0.3,
  })
}
```

### 2. `src/components/character/Robot3DModel.tsx` — The 3D Robot Component

This is a `@react-three/fiber` component that builds the robot mesh hierarchy and runs the state-driven animation loop.

```typescript
// src/components/character/Robot3DModel.tsx
import { useRef, useMemo } from 'react'
import { useFrame } from '@react-three/fiber'
import * as THREE from 'three'
import { robotGeo, robotEdgeGeo, metalMat, darkMat, createNeonMat, createEdgeMat } from '@/lib/robot3DGeometry'
import type { Robot3DState } from '@/lib/robotStateMap'

interface Robot3DModelProps {
  neonColor: string          // e.g. '#00f0ff'
  state: Robot3DState        // mapped from SessionStatus
  scale?: number             // default 1
}

export function Robot3DModel({ neonColor, state, scale = 1 }: Robot3DModelProps) {
  const groupRef = useRef<THREE.Group>(null)
  const armPivots = useRef<THREE.Group[]>([])
  const legPivots = useRef<THREE.Group[]>([])
  const bodyRef = useRef<THREE.Mesh>(null)
  const bodyEdgeRef = useRef<THREE.LineSegments>(null)
  const coreRef = useRef<THREE.Mesh>(null)
  const aTipRef = useRef<THREE.Mesh>(null)
  const glowRef = useRef<THREE.Mesh>(null)
  const phase = useRef(Math.random() * Math.PI * 2)

  const { neonMat, edgeMat } = useMemo(() => ({
    neonMat: createNeonMat(neonColor),
    edgeMat: createEdgeMat(neonColor),
  }), [neonColor])

  useFrame((_, delta) => {
    if (!groupRef.current) return
    const t = performance.now() / 1000
    const p = phase.current

    // Antenna + core pulse (always active)
    if (aTipRef.current) {
      aTipRef.current.scale.setScalar(
        0.8 + ((Math.sin(t * 6 + p) + 1) * 0.5) * 0.4
      )
    }
    if (coreRef.current) {
      coreRef.current.scale.setScalar(
        0.9 + Math.sin(t * 3 + p) * 0.12
      )
    }

    const [lp0, lp1] = legPivots.current
    const [ap0, ap1] = armPivots.current

    switch (state) {
      case 'idle': {
        groupRef.current.position.y = Math.sin(t * 2 + p) * 0.03
        if (ap0) ap0.rotation.x *= 0.9
        if (ap1) ap1.rotation.x *= 0.9
        if (lp0) lp0.rotation.x *= 0.9
        if (lp1) lp1.rotation.x *= 0.9
        break
      }
      case 'thinking': {
        groupRef.current.position.y = Math.sin(t * 2 + p) * 0.02
        if (bodyRef.current) {
          bodyRef.current.rotation.z = Math.sin(t * 0.8 + p) * 0.04
        }
        // One arm up to "chin"
        if (ap0) ap0.rotation.x = -0.7 + Math.sin(t * 1.5 + p) * 0.05
        if (ap1) ap1.rotation.x *= 0.9
        break
      }
      case 'working': {
        // Seated pose
        groupRef.current.position.y = -0.12
        if (lp0) lp0.rotation.x = 1.2
        if (lp1) lp1.rotation.x = 1.2
        const typing = Math.sin(t * 10 + p) * 0.05
        if (ap0) ap0.rotation.x = -0.5 + typing
        if (ap1) ap1.rotation.x = -0.5 - typing
        if (bodyRef.current) {
          bodyRef.current.rotation.z = Math.sin(t * 0.7 + p) * 0.012
        }
        if (glowRef.current) glowRef.current.position.y = 0.13
        break
      }
      case 'waiting': {
        groupRef.current.position.y = Math.abs(Math.sin(t * 3 + p)) * 0.08
        if (bodyRef.current) {
          bodyRef.current.rotation.y = Math.sin(t * 0.5 + p) * 0.3
        }
        break
      }
      case 'alert': {
        groupRef.current.position.y = Math.abs(Math.sin(t * 6 + p)) * 0.1
        groupRef.current.position.x = Math.sin(t * 15 + p) * 0.02
        break
      }
      case 'input': {
        groupRef.current.position.y = Math.sin(t * 1.5 + p) * 0.04
        groupRef.current.rotation.z = Math.sin(t * 1 + p) * 0.03
        if (ap1) ap1.rotation.x = -0.8 + Math.sin(t * 1.5) * 0.05
        break
      }
      case 'offline': {
        groupRef.current.position.y = -0.05
        break
      }
      case 'connecting': {
        const boot = Math.min(1, t % 2)
        groupRef.current.scale.setScalar(scale * boot)
        break
      }
    }

    // Sync body edge rotation
    if (bodyEdgeRef.current && bodyRef.current) {
      bodyEdgeRef.current.rotation.copy(bodyRef.current.rotation)
    }

    // Reset glow for non-sitting states
    if (state !== 'working' && glowRef.current) {
      glowRef.current.position.y = 0.01
    }
  })

  return (
    <group ref={groupRef} scale={scale}>
      {/* HEAD */}
      <mesh geometry={robotGeo.head} material={metalMat} position={[0, 1.32, 0]} castShadow />
      <lineSegments geometry={robotEdgeGeo.head} material={edgeMat} position={[0, 1.32, 0]} />
      <mesh geometry={robotGeo.visor} material={neonMat} position={[0, 1.32, 0.13]} />
      <mesh geometry={robotGeo.antenna} material={darkMat} position={[0.05, 1.52, 0]} />
      <mesh ref={aTipRef} geometry={robotGeo.aTip} material={neonMat} position={[0.05, 1.6, 0]} />

      {/* TORSO */}
      <mesh ref={bodyRef} geometry={robotGeo.torso} material={metalMat} position={[0, 0.87, 0]} castShadow />
      <lineSegments ref={bodyEdgeRef} geometry={robotEdgeGeo.torso} material={edgeMat} position={[0, 0.87, 0]} />
      <mesh ref={coreRef} geometry={robotGeo.core} material={neonMat} position={[0, 0.91, 0.105]} />

      {/* SHOULDERS */}
      {[-1, 1].map(s => (
        <mesh key={`sh${s}`} geometry={robotGeo.joint} material={neonMat} position={[s * 0.21, 1.07, 0]} />
      ))}

      {/* ARMS */}
      {[-1, 1].map((s, i) => (
        <group key={`arm${s}`} ref={el => { if (el) armPivots.current[i] = el }} position={[s * 0.21, 1.07, 0]}>
          <mesh geometry={robotGeo.arm} material={darkMat} position={[0, -0.18, 0]} castShadow />
          <lineSegments geometry={robotEdgeGeo.arm} material={edgeMat} position={[0, -0.18, 0]} />
        </group>
      ))}

      {/* HIPS */}
      {[-1, 1].map(s => (
        <mesh key={`hp${s}`} geometry={robotGeo.joint} material={neonMat} position={[s * 0.09, 0.54, 0]} scale={0.9} />
      ))}

      {/* LEGS */}
      {[-1, 1].map((s, i) => (
        <group key={`leg${s}`} ref={el => { if (el) legPivots.current[i] = el }} position={[s * 0.09, 0.54, 0]}>
          <mesh geometry={robotGeo.leg} material={darkMat} position={[0, -0.19, 0]} castShadow />
          <lineSegments geometry={robotEdgeGeo.leg} material={edgeMat} position={[0, -0.19, 0]} />
          <mesh geometry={robotGeo.foot} material={metalMat} position={[0, -0.36, 0.012]} castShadow />
        </group>
      ))}

      {/* GROUND GLOW (placeholder — needs CanvasTexture) */}
      {/* <mesh ref={glowRef} rotation={[-Math.PI/2,0,0]} position={[0,0.01,0]}> ... </mesh> */}
    </group>
  )
}
```

### 3. `src/components/character/Robot3DViewport.tsx` — Canvas Container

Replaces `RobotViewport.tsx`. Wraps the 3D robot in a `<Canvas>` with lighting.

```typescript
// src/components/character/Robot3DViewport.tsx
import { useMemo } from 'react'
import { Canvas } from '@react-three/fiber'
import { Robot3DModel } from './Robot3DModel'
import { mapStatusTo3D } from '@/lib/robotStateMap'
import { useSettingsStore } from '@/stores/settingsStore'
import type { SessionStatus } from '@/types/session'

const COLOR_PALETTE = [
  '#00f0ff', '#ff00aa', '#a855f7', '#00ff88',
  '#ff4444', '#ffaa00', '#00aaff', '#ff66ff',
]

interface Robot3DViewportProps {
  sessionId: string
  status: SessionStatus
  accentColor?: string
}

let globalColorIdx = 0

export function Robot3DViewport({ sessionId, status, accentColor }: Robot3DViewportProps) {
  const color = useMemo(
    () => accentColor || COLOR_PALETTE[globalColorIdx++ % COLOR_PALETTE.length],
    [accentColor]
  )
  const state3D = mapStatusTo3D(status)

  return (
    <Canvas
      camera={{ position: [0, 1.2, 2.8], fov: 40 }}
      gl={{ antialias: true, alpha: true }}
      style={{ background: 'transparent' }}
      dpr={[1, 1.5]}
    >
      <ambientLight intensity={0.8} color="#2a2040" />
      <directionalLight position={[3, 5, 3]} intensity={1.5} color="#c8b8e0" />
      <pointLight position={[-2, 2, -1]} intensity={0.6} color={color} />
      <Robot3DModel neonColor={color} state={state3D} scale={0.85} />
    </Canvas>
  )
}
```

### 4. Integration into SessionCard

The existing `SessionCard.tsx` has a placeholder:

```tsx
{/* Robot viewport placeholder */}
<div className={styles.robotViewport} />
```

Replace with:

```tsx
<div className={styles.robotViewport}>
  <Robot3DViewport
    sessionId={session.sessionId}
    status={session.status}
    accentColor={session.accentColor}
  />
</div>
```

Ensure the `.robotViewport` CSS module class has:

```css
.robotViewport {
  width: 100%;
  height: 120px; /* adjust to card layout */
  overflow: hidden;
  border-radius: 8px;
}
.robotViewport canvas {
  width: 100% !important;
  height: 100% !important;
}
```

---

## Performance Considerations

### Problem: Many Canvases

Each `SessionCard` would mount its own `<Canvas>`, each creating a separate WebGL context. Browsers limit contexts to ~8-16; beyond that, earlier ones are lost.

### Solution: Shared Canvas with Offscreen Viewports

Use a **single shared Canvas** that renders all robots, with each card showing a CSS-clipped region. `@react-three/drei` provides `<View>` for this:

```typescript
// src/components/character/Robot3DStage.tsx
import { Canvas } from '@react-three/fiber'
import { View } from '@react-three/drei'

// Mount ONCE at the app root (e.g., in App.tsx or LiveView.tsx)
export function Robot3DStage({ children }: { children: React.ReactNode }) {
  return (
    <>
      {children}
      <Canvas
        style={{ position: 'fixed', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', zIndex: 0 }}
        gl={{ antialias: true, alpha: true }}
        dpr={[1, 1.5]}
        eventSource={document.body}
      >
        <View.Port />
      </Canvas>
    </>
  )
}

// Each card uses <View> to claim a region of the shared canvas:
// src/components/character/Robot3DViewport.tsx (updated)
import { View } from '@react-three/drei'

export function Robot3DViewport({ status, accentColor }: Props) {
  const ref = useRef<HTMLDivElement>(null)
  const state3D = mapStatusTo3D(status)
  const color = accentColor || '#00f0ff'

  return (
    <div ref={ref} style={{ width: '100%', height: '120px' }}>
      <View track={ref}>
        <ambientLight intensity={0.8} color="#2a2040" />
        <directionalLight position={[3, 5, 3]} intensity={1.5} />
        <pointLight position={[-2, 2, -1]} intensity={0.6} color={color} />
        <Robot3DModel neonColor={color} state={state3D} scale={0.85} />
      </View>
    </div>
  )
}
```

This approach uses **1 WebGL context** for all robots. Critical for dashboards showing 10-50+ sessions.

### Other Performance Tips

| Concern | Solution |
|---|---|
| 50+ robots on screen | Use `<Instances>` from drei for shared geometry instancing |
| Material per color | Pool materials by palette index (8 materials, not N) |
| Offscreen robots | Pause `useFrame` when card is not in viewport (`IntersectionObserver`) |
| Mobile/low-end | Fall back to CSS characters via `settingsStore.use3D` toggle |
| Shadow maps | Disable `castShadow` in card viewport (only needed for full scene) |

---

## Migration Checklist

```
Phase 1: Foundation
─────────────────────────────────────────
[ ] npm install three @react-three/fiber @react-three/drei @types/three
[ ] Create src/lib/robot3DGeometry.ts (shared geo + materials)
[ ] Create src/lib/robotStateMap.ts (SessionStatus → Robot3DState)
[ ] Create src/components/character/Robot3DModel.tsx
[ ] Create src/components/character/Robot3DViewport.tsx
[ ] Create src/components/character/Robot3DStage.tsx (shared canvas)

Phase 2: Integration
─────────────────────────────────────────
[ ] Wrap App.tsx (or LiveView.tsx) with <Robot3DStage>
[ ] Replace .robotViewport placeholder in SessionCard with <Robot3DViewport>
[ ] Wire session.status and session.accentColor props through
[ ] Test with 1 session, then 10, then 30+

Phase 3: Polish
─────────────────────────────────────────
[ ] Add state transitions (smooth lerp between poses, not instant snap)
[ ] Add floating "!" / "?" meshes for approval/input states
[ ] Add sweat particle emitter for working state
[ ] Add boot-up animation for connecting state
[ ] Handle emote system (Wave/ThumbsUp/Jump/Yes → one-shot 3D anim)

Phase 4: Cleanup
─────────────────────────────────────────
[ ] Add settingsStore.use3D toggle (bool) for CSS fallback
[ ] Update CharacterSelector to show 3D preview (single shared canvas)
[ ] Remove src/styles/characters/*.css (22 files) if CSS chars fully deprecated
[ ] Slim down src/styles/animations.css (keep card effects, remove character anims)
[ ] Update Vitest + Playwright tests

Phase 5: Optional Enhancements
─────────────────────────────────────────
[ ] Per-session robot customization (color picker already exists via accentColor)
[ ] Use AnimationState field to drive walk/run/dance animations
[ ] Add desk/monitor mesh when robot is in "working" state
[ ] Add OrbitControls on detail panel (enlarged robot view when card is selected)
```

---

## Key Mapping Reference

### Color Palette (reuse existing)

```
Current RobotViewport         →  Robot3DViewport
COLOR_PALETTE[0] '#00e5ff'    →  Neon visor + joints + edges
COLOR_PALETTE[1] '#ff9100'    →  Neon visor + joints + edges
...                           →  ...
```

The existing auto-assignment logic in `RobotViewport` (cycling `globalColorIndex`, persisting via `PUT /api/sessions/{id}/accent-color`) works identically — just pass the color as `neonColor` to the 3D model.

### AnimationState → Enhancement Layer

The `AnimationState` enum (`Idle/Walking/Running/Waiting/Death/Dance`) stored on sessions is currently unused. With 3D robots, it can drive additional behavior:

```typescript
// Optional: enhance the 3D state with AnimationState
if (session.animationState === 'Dance') {
  // Override normal state with celebration animation
}
if (session.animationState === 'Death') {
  // Play shutdown/collapse sequence instead of normal 'offline'
}
```

### Settings Integration

```
settingsStore.animationIntensity  →  Scale all useFrame amplitudes
settingsStore.animationSpeed      →  Multiply time factor in useFrame
settingsStore.characterModel      →  Ignored (single 3D robot model)
                                     OR use as variant selector if you add multiple 3D models
```

---

## File Structure After Adaptation

```
src/components/character/
├── Robot3DModel.tsx         # NEW — Three.js robot mesh + animation
├── Robot3DViewport.tsx      # NEW — Per-card viewport (uses drei View)
├── Robot3DStage.tsx         # NEW — Shared Canvas at app root
├── CharacterModel.tsx       # KEEP — CSS fallback (if use3D is false)
├── RobotViewport.tsx        # KEEP — CSS fallback wrapper
├── CharacterSelector.tsx    # UPDATE — add 3D preview option

src/lib/
├── robot3DGeometry.ts       # NEW — shared Three.js geometries + materials
├── robotStateMap.ts         # NEW — SessionStatus → Robot3DState mapper
├── ...existing files...
```
