# React Error #185: Complete Architecture Analysis

> **Error**: "Maximum update depth exceeded" when clicking a 3D robot to open session detail panel.
> **Impact**: Crashes the WebGL context (`THREE.WebGLRenderer: Context Lost`), requires page reload.

---

## 1. What is React Error #185?

React Error #185 fires when a component triggers a state update during rendering, which triggers another render, which triggers another update — an infinite `setState → render → setState` loop. React detects this after ~50 nested updates and throws.

---

## 2. Current Click-to-Detail Architecture

### Component Tree

```
App.tsx (React DOM root)
├── AppLayout
│   ├── Header, NavBar, ActivityFeed (React DOM)
│   ├── <LiveView /> → <CyberdromeScene />
│   │   ├── <Canvas>  ← R3F RECONCILER BOUNDARY
│   │   │   ├── SceneContent
│   │   │   │   ├── SessionRobot ×N (memo'd)
│   │   │   │   │   ├── Robot3DModel (pure Three.js meshes)
│   │   │   │   │   ├── RobotLabel (drei <Text> + <Billboard>)
│   │   │   │   │   ├── RobotDialogue (drei <Text> + <Billboard>)
│   │   │   │   │   └── StatusParticles (Three.js Points)
│   │   │   │   ├── SubagentConnections (Three.js Lines)
│   │   │   │   └── CyberdromeEnvironment (Three.js meshes)
│   │   │   ├── CameraController
│   │   │   └── OrbitControls
│   │   ├── MapControls (DOM overlay, outside Canvas)
│   │   ├── SceneOverlay (DOM overlay, outside Canvas)
│   │   └── RobotListSidebar (DOM overlay, outside Canvas)
│   ├── DetailPanel ← OUTSIDE Canvas, subscribes to selectedSessionId
│   ├── SettingsPanel
│   └── Modals (Kill, Alert, Summarize)
```

### The Click Flow

```
1. User clicks robot mesh
     ↓
2. R3F raycasts and fires onClick on <group> in SessionRobot
     ↓
3. handleClick: setTimeout(() => onSelect(session.sessionId), 0)
     ↓ (deferred to next event loop tick)
4. onSelect = handleSelect in SceneContent:
     a. selectSession(sessionId)   → updates sessionStore.selectedSessionId
     b. flyTo(pos, lookAt)         → updates cameraStore.animation
     ↓
5. Zustand notifies ALL subscribers synchronously:
     ↓
   SUBSCRIBERS TO selectedSessionId (sessionStore):
     a. DetailPanel (React DOM)       → re-renders, shows slide-in panel
     b. RobotListSidebar (React DOM)  → re-renders, highlights selected entry
     c. SummarizeModal (React DOM)    → conditional re-render
     d. KillConfirmModal (React DOM)  → conditional re-render
     e. AlertModal (React DOM)        → conditional re-render
     f. useKeyboardShortcuts hook     → no visual re-render

   SUBSCRIBERS TO sessions (sessionStore):
     a. SceneContent (R3F)            → NOT triggered (sessions Map unchanged)
     b. SubagentConnections (R3F)     → NOT triggered (sessions Map unchanged)
     c. RobotListSidebar (React DOM)  → also subscribes to sessions

   SUBSCRIBERS TO animation (cameraStore):
     a. CameraController (R3F)        → triggers useFrame lerp animation
```

### The Dual-Reconciler Problem

React Three Fiber maintains its OWN React reconciler separate from React DOM's reconciler. Both share the same React runtime. When a Zustand store update fires:

1. **React DOM reconciler** processes subscribers (DetailPanel, RobotListSidebar, modals)
2. **R3F reconciler** processes subscribers (SceneContent, CameraController)

These two reconcilers can **interleave** — one reconciler's flush can trigger effects that cause the other to flush, creating a ping-pong cascade.

---

## 3. Why Previous Fixes Failed

### Fix Attempt 1: `startTransition(() => onSelect(...))`
**Why it failed**: `startTransition` defers the update within ONE reconciler, but doesn't prevent cross-reconciler cascades. React DOM's deferred update can still trigger R3F's reconciler to flush synchronously.

### Fix Attempt 2: `setTimeout(() => onSelect(...), 0)`
**Why it partially works**: Moves the store update completely out of R3F's render loop. But the problem persists because:
- The `setTimeout` fires and calls `selectSession(sessionId)` + `flyTo()`
- `selectSession` synchronously notifies Zustand subscribers
- DetailPanel (React DOM) re-renders → mounts heavy child components
- R3F's animation frame may be processing simultaneously
- If any R3F component also triggers a state update (even indirectly), cascade begins

### Fix Attempt 3: `memo(SessionRobot)` with granular comparator
**Why it helps but isn't sufficient**: Prevents SessionRobots from re-rendering when `sessions` Map gets a new reference but their specific session data hasn't changed. However, the `sessions` Map reference doesn't change on `selectSession` (only `selectedSessionId` changes), so this memo was never the actual trigger.

### Fix Attempt 4: `seatedRef` / `isHoveredRef` / `dialogueRef`
**Why it helps but isn't the root cause**: Eliminates all `useState` from SessionRobot's render cycle. No React state updates happen inside R3F's tree from these refs. Good defensive measure, but the crash still happens because the problem is in the cross-reconciler interaction triggered by Zustand, not by local state.

---

## 4. Root Cause: The Zustand Cross-Reconciler Bridge

The **fundamental** problem is:

```
sessionStore.selectSession(id)
  → Zustand.setState({ selectedSessionId: id })
  → Zustand notifies ALL subscribers SYNCHRONOUSLY
  → React DOM subscribers (DetailPanel) flush
  → React DOM flush may trigger layout effects
  → R3F's next frame picks up any pending work
  → If any R3F component has pending effects → cascade
```

Specifically, when Zustand notifies subscribers, it calls `useSyncExternalStore` in both reconcilers. React 19's concurrent features mean the DOM reconciler may start a render that the R3F reconciler then sees as a pending update.

### The Dangerous Components Inside R3F's Canvas

Even after all fixes, these components inside `<Canvas>` still subscribe to Zustand stores:

| Component | Store | Selector | Risk |
|-----------|-------|----------|------|
| SceneContent | sessionStore | `s.sessions` | Medium — triggers on any session update |
| SceneContent | sessionStore | `s.selectSession` | Low — stable fn ref |
| SceneContent | cameraStore | `s.flyTo` | Low — stable fn ref |
| SubagentConnections | sessionStore | `s.sessions` | Medium — triggers on any session update |
| Robot3DModel | settingsStore | `s.animationIntensity` | Low |
| Robot3DModel | settingsStore | `s.animationSpeed` | Low |
| SessionRobot | roomStore | `s.getRoomForSession` | Low — stable fn ref |
| SessionRobot | settingsStore | `s.characterModel` | Low |
| SessionRobot | settingsStore | `s.labelSettings` | Low |
| CameraController | cameraStore | `s.animation` | **HIGH — triggers on flyTo()** |
| SceneThemeSync | settingsStore | `s.themeName` | Low |

**CameraController** is the likely remaining trigger. When `handleSelect` calls `flyTo()`, CameraController re-renders because `s.animation` changes. This re-render happens **inside R3F's reconciler** at the same time that DetailPanel is re-rendering in React DOM's reconciler.

---

## 5. The Remaining Hazard: `SubagentConnections`

`SubagentConnections` subscribes to `useSessionStore((s) => s.sessions)`. While `selectSession` doesn't change `sessions`, the `updateSession` action (from WebSocket) creates a new `Map` reference every time. If a WebSocket update arrives at the exact moment the click handler fires, SubagentConnections re-renders inside R3F while DetailPanel re-renders in DOM — cross-reconciler cascade.

---

## 6. Solution: Decouple the Two Reconcilers Completely

The only reliable fix is to ensure **NO shared reactive state** bridges the R3F and DOM reconcilers. The R3F tree should read data imperatively (via refs or callbacks), never via Zustand subscriptions that can trigger simultaneous re-renders.

### Option A: Event-Based Communication (Recommended)

Replace the Zustand `selectedSessionId` bridge with a custom event:

```
Robot click → dispatch CustomEvent('select-session', { sessionId })
              ↓
DOM listener (outside Canvas) → updates local React state
              ↓
DetailPanel renders from local state (never touches R3F)
```

R3F components never subscribe to `selectedSessionId`. The click handler dispatches a DOM event. A DOM-only listener (in CyberdromeScene's wrapper or App) catches it and calls `selectSession`. This ensures:

- R3F's reconciler has ZERO work to do when a session is selected
- React DOM's reconciler handles DetailPanel independently
- No cross-reconciler flush interleaving

### Option B: Ref-Based Bridge

Store `selectedSessionId` in a `useRef` at the Canvas boundary. R3F reads it imperatively in `useFrame`. DOM components use the normal Zustand subscription. No R3F component subscribes to `selectedSessionId`.

### Option C: Move ALL Zustand Subscriptions Outside Canvas

Move `SceneContent` and `SubagentConnections` to read sessions via a ref that's updated outside Canvas. Pass session data as props computed in the DOM layer. This eliminates all Zustand subscriptions from inside `<Canvas>`.

---

## 7. Additional Hazards to Fix

### A. `SubagentConnections` sessions subscription
Subscribes to `s.sessions` inside Canvas. Every WebSocket `updateSession` creates a new Map, causing re-render. Should use a ref or compute connections outside Canvas.

### B. `SceneContent` sessions subscription
Same issue — `useSessionStore((s) => s.sessions)` re-renders SceneContent on every session update. Should receive sessions as a prop from outside Canvas, or use a ref.

### C. `Robot3DModel` settingsStore subscriptions
`animationIntensity` and `animationSpeed` subscriptions cause Robot3DModel to re-render when settings change. Should read via `useSettingsStore.getState()` inside useFrame instead of subscribing.

### D. `CameraController` cameraStore subscription
Re-renders when `flyTo()` is called. The animation data should be read via ref in useFrame, not via subscription.

### E. `RobotListSidebar` calls `selectSession` directly
Line 202: `selectSession(sessionId)` — this DOM component calls the same function that triggers the cross-reconciler cascade. Should use the same decoupled mechanism as the robot click.

---

## 8. Files Involved

| File | Role | Issues |
|------|------|--------|
| `src/App.tsx:53` | Mounts `<DetailPanel />` | None — correct placement outside Canvas |
| `src/routes/LiveView.tsx` | Wraps `<CyberdromeScene />` | None |
| `src/components/3d/CyberdromeScene.tsx:89-103` | `SceneContent` subscribes to `sessions` + calls `selectSession` + `flyTo` | **PRIMARY ISSUE**: Zustand subscriptions inside Canvas |
| `src/components/3d/CyberdromeScene.tsx:74-130` | `SceneContent` function | Sessions subscription triggers re-render |
| `src/components/3d/SessionRobot.tsx:431-438` | `handleClick` with setTimeout | Good fix but insufficient |
| `src/components/3d/SessionRobot.tsx:668-692` | `memo` wrapper | Good but sessions Map ref unchanged on select |
| `src/components/3d/Robot3DModel.tsx:100-102` | Settings subscriptions | Should use getState() in useFrame |
| `src/components/3d/RobotLabel.tsx` | Pure WebGL (drei Text) | **SAFE** — no Html portals, no store subscriptions |
| `src/components/3d/RobotDialogue.tsx` | Pure WebGL (drei Text) | **SAFE** — ref-based, no store subscriptions |
| `src/components/3d/SubagentConnections.tsx:89` | `sessions` subscription | **DANGEROUS** — re-renders inside Canvas on every session update |
| `src/components/3d/CameraController.tsx` | `animation` subscription | **DANGEROUS** — re-renders inside Canvas on flyTo |
| `src/components/session/DetailPanel.tsx:68` | `selectedSessionId` subscription | Fine — outside Canvas |
| `src/components/3d/RobotListSidebar.tsx:180-183` | Multiple store subscriptions | Fine — outside Canvas (DOM overlay) |
| `src/stores/sessionStore.ts:56` | `selectSession` action | Triggers all subscribers synchronously |
| `src/stores/cameraStore.ts` | `flyTo` action | Triggers CameraController re-render inside Canvas |

---

## 9. Recommended Redevelopment Plan

### Phase 1: Eliminate ALL Zustand subscriptions from inside `<Canvas>`

1. **SceneContent**: Remove `useSessionStore` and `useCameraStore` subscriptions. Receive `sessions`, `selectSession`, `flyTo` as props from CyberdromeScene (DOM layer).

2. **SubagentConnections**: Remove `useSessionStore` subscription. Receive `sessions` or precomputed connections as props.

3. **Robot3DModel**: Replace `useSettingsStore` subscriptions with `useSettingsStore.getState()` reads inside useFrame.

4. **CameraController**: Replace `useCameraStore((s) => s.animation)` subscription with polling in useFrame via `useCameraStore.getState()`.

5. **SceneThemeSync**: Replace `useSettingsStore` subscription with receiving theme as a prop.

### Phase 2: Replace cross-reconciler selection bridge

1. Robot click dispatches `window.dispatchEvent(new CustomEvent('robot-select', { detail: { sessionId } }))`.

2. CyberdromeScene (DOM wrapper) listens for 'robot-select' and calls `selectSession()` + `flyTo()`.

3. RobotListSidebar dispatches same event instead of calling `selectSession()` directly.

4. DetailPanel remains unchanged — subscribes to `selectedSessionId` in React DOM, which is safe.

### Phase 3: Verify no cross-reconciler state bridges remain

- Grep for `useSessionStore`, `useCameraStore`, `useSettingsStore`, `useRoomStore` inside any component rendered within `<Canvas>`.
- Each must use either `.getState()` in useFrame/callbacks, or receive data as props from the DOM layer.

---

## 10. Summary

The error persists because **Zustand store updates synchronously notify subscribers in BOTH React reconcilers** (R3F and DOM). When the user clicks a robot:

1. `selectSession()` notifies DOM subscribers (DetailPanel) → heavy re-render
2. `flyTo()` notifies R3F subscribers (CameraController) → re-render inside Canvas
3. If a WebSocket `updateSession` arrives simultaneously, SceneContent + SubagentConnections re-render
4. Both reconcilers flush work, potentially interleaving, causing the infinite loop

**The fix is architectural**: no component inside `<Canvas>` should subscribe to Zustand stores. All data flows into the Canvas via props or is read imperatively via `.getState()` in useFrame callbacks.
