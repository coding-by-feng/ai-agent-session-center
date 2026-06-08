# Particles, Connection Beams & Visual Effects

## Function
Status transition particle bursts, animated subagent connection beams between parent/child robots, and scene-level visual effects.

## Purpose
Visual feedback for state changes (burst when robot starts working, confetti when task completes) and team relationships (laser lines between parent and subagent robots).

## Source Files
| File | Role |
|------|------|
| `src/components/3d/StatusParticles.tsx` | Particle bursts on status transitions (pre-allocated buffers, zero React state) |
| `src/components/3d/SubagentConnections.tsx` | Animated dashed laser lines between parent and child sessions |

## Implementation

### StatusParticles

#### Buffer Strategy
Takes a single `state: Robot3DState` prop; a burst is triggered (ref-only, via `useEffect`) when that prop changes between renders. Always mounted with `bufferGeo.setDrawRange(0, 0)` to hide particles when inactive. Uses a pre-allocated `Float32Array(MAX_PARTICLES * 3)` where `MAX_PARTICLES = 25`. Per-instance `PointsMaterial` with `AdditiveBlending`, `opacity: 0`, and `depthWrite: false` for the glow effect; only `instanceMat` is disposed on unmount (the `bufferGeo` lives for the component's lifetime).

#### Burst Configurations
| Transition | Color | Count | Pattern | Speed | Gravity | Duration | Size |
|------------|-------|-------|---------|-------|---------|----------|------|
| idle/waiting -> working/thinking | `#ffdd00` | 20 | up | 2.5 | -1.5 | 1.5s | 0.04 |
| working/thinking -> waiting | `#00ff88` | 20 | confetti | 1.2 | 2.0 | 1.5s | 0.05 |
| any -> alert | `#ffdd00` | 25 | ring | 2.0 | 0 | 1.2s | 0.06 |
| any -> input | `#aa66ff` | 20 | ring | 1.5 | 0 | 1.2s | 0.05 |
| any -> offline | `#666688` | 20 | down | 0.8 | 0.5 | 2.0s | 0.06 |

#### Burst Patterns
| Pattern | Behavior |
|---------|----------|
| `up` | Velocity mainly upward with small XZ spread |
| `down` | Velocity mainly downward |
| `ring` | Radial XZ spread with angular distribution |
| `confetti` | Random XZ with upward bias |

#### Animation Physics
- Opacity: `1 - progress^2` (quadratic fade-out)
- Size: `burstSize * (1 - progress * 0.5)` (gradual shrink)
- Velocity decay: `0.99x` per tick (air resistance)
- Gravity: subtracts from Y velocity each tick (configurable per burst type)

### SubagentConnections

#### Detection Logic
Receives precomputed `ConnectionData[]` (`{ parentId, childId, color }`) from the DOM layer (zero Zustand access inside Canvas). The list is built in `CyberdromeScene.tsx` via a `useMemo` over `sessions`. Detection criteria:
1. Session has `teamRole === 'member'` and `teamId` exists
2. Parent ID derived from `teamId.replace(/^team-/, '')`; skipped when empty or equal to the session's own `sessionId`
3. Parent session exists and neither parent nor child has `status === 'ended'`
4. Connection color = parent's `accentColor`, falling back to `PALETTE[(colorIndex ?? 0) % PALETTE.length]` (`PALETTE` from `@/lib/robot3DGeometry`)

#### Line Rendering
- Raw `THREE.Line` with `LineDashedMaterial`
- Dash size: 0.3, gap size: 0.2
- Opacity: 0.3
- Color: parent's `accentColor` or `PALETTE`-derived fallback (passed in via `ConnectionData.color`)

#### Animation
- `useFrame` updates endpoint positions from `robotPositionStore` each frame
- `dashOffset` decrements at `delta * 2` for flowing data visual effect
- `computeLineDistances()` called each frame (required for dashed line rendering)

#### Cleanup
Geometry and material are disposed on unmount via `useEffect` cleanup to prevent memory leaks.

## Dependencies & Connections

### Depends On
- [Robot System](./robot-system.md) -- reads robotPositionStore for connection beam endpoints; session status changes trigger particle bursts
- [Cyberdrome Scene](./cyberdrome-scene.md) -- ConnectionData[] computed in DOM layer and passed as props
- [Server Team/Subagent](../server/team-subagent.md) -- team relationships (teamId, teamRole) determine which sessions are connected

### Depended On By
- [Cyberdrome Scene](./cyberdrome-scene.md) -- computes `ConnectionData[]` and renders `SubagentConnections` inside the Canvas
- [Robot System](./robot-system.md) -- `SessionRobot` mounts `StatusParticles` (passing the robot's `Robot3DState`) inside each robot group

### Shared Resources
- `robotPositionStore` (read-only access for beam endpoint positions)
- Three.js scene (particles and lines rendered as scene children)

## Change Risks
- Pre-allocated particle buffer size is fixed at `MAX_PARTICLES = 25`. Changing this requires resizing the `Float32Array` buffer.
- Adding React state to `StatusParticles` breaks performance (triggers re-renders at 60fps).
- `SubagentConnections` creates per-line geometry and material. Failure to dispose on unmount causes memory leaks.
- `computeLineDistances()` must be called each frame for dashed lines to render correctly. Removing this call makes all lines appear solid.
- `ConnectionData` must be precomputed in the DOM layer and passed as props (zero Zustand rule inside Canvas).
- Changing `AdditiveBlending` on particles affects how they visually composite with the scene background and other transparent objects.
