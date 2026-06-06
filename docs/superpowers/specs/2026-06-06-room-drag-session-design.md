# Drag a session onto a room's 3D floor + reveal empty rooms — Design

- **Date:** 2026-06-06
- **Status:** Approved (design) — pending implementation plan
- **Topic:** Drag a session chip from the header onto a room's 3D floor in the cyberdrome to reassign it to that room; add a filter option that reveals empty rooms.

## 1. Goal

Let the user drag a session chip out of the header strip and drop it onto a room's **3D floor area** in the cyberdrome scene. Dropping **reassigns** the session to that room; the robot then autonomously walks into the room. A new **"Show empty rooms"** option in the room-filter (funnel) dropdown reveals rooms that currently have no active sessions (today they are hidden), so they are discoverable as drop targets. Clicking the placed robot re-opens/focuses the session (existing behavior).

## 2. User decisions (resolved during brainstorming)

1. **Empty-room filter option →** *Reveal* empty rooms (which are hidden today). Populated rooms still show.
2. **Drop target →** The room's **actual 3D floor** in the cyberdrome canvas.
3. **Placement →** **Reassign** the session to the room (membership change, persisted); the robot auto-walks there. No fixed per-session pin position.
4. **Re-click "reuse" →** **Open/focus** the session (today's `robot-select` behavior). No resume/respawn.

Two follow-up calls confirmed:
- (a) The "Show empty rooms" toggle lives in the **filter dropdown**; the "where can I drop" cue comes from a **drag-hover floor highlight**, not a permanent empty-room glow.
- (b) Dropping a chip onto the **corridor / outside any room** is a **no-op** (not "unassign").

## 3. Current-state grounding (verified against source)

- **Room filter** lives in `src/components/session/SessionSwitcher.tsx`. `availableRooms` (≈ lines 226–229) = `rooms.filter(r => r.sessionIds.some(id => activeSessionIds.has(id)))` — **empty rooms are excluded today**. Selection state is `uiStore.selectedRoomIds: Set<string>`, persisted to `localStorage['room-filter']` via `saveRoomFilter` (mirror this pattern).
- **Header chips:** `src/components/layout/HeaderAgentStrip.tsx` → `MiniRobot` is a `<button>` whose `onClick` dispatches `CustomEvent('robot-select', { detail: { sessionId } })`. **No drag handlers and no `data-session-id` today.** Empty room groups are skipped (`if (roomSessions.length === 0) continue;`).
- **Rooms & robots (R3F):** `src/lib/cyberdromeScene.ts` provides `computeRoomCenter(roomIndex)` (returns `[x, 0, z]` — floor is **y=0**), `computeRoomBounds(roomIndex)` (AABB), and `getZone(x, z, rooms)` (point-in-bounds → roomIndex, or −1 for corridor). `src/components/3d/CyberdromeScene.tsx` reads stores in the **DOM layer** and passes `roomConfigs` (`{ index, roomId, name, center, bounds, stripColor }`) + `roomAssignments` as **props** into `<Canvas>`. It already listens for `robot-select` → `selectSession` + camera fly.
- **Robot placement:** `src/components/3d/SessionRobot.tsx` takes a `roomIndex` prop; a `useEffect` on `roomIndex` change releases the old desk and navigates to the new room. Empty rooms with a `roomIndex` **still render** their floor in 3D, so the drop target already exists physically.
- **Session→room model:** `src/stores/roomStore.ts` — `Room = { id, name, sessionIds[], collapsed, createdAt, roomIndex? }`. Sessions carry **no** room field; membership is the inverse `Room.sessionIds[]`. `moveSession(sessionId, fromRoomId, toRoomId)` early-returns when `from === to`, tolerates a non-matching `from` (just adds to target), and **auto-persists** to `localStorage['session-rooms']` + triggers `useWorkspaceAutoSave`. `getRoomForSession(sessionId)` resolves the current room.
- **Existing patterns to reuse:** HTML5 native DnD is already used in `QueueTab.tsx` / `ProjectTab.tsx` (`draggable` + `dataTransfer`). `src/styles/modules/Room.module.css` has **orphaned** `.dragOver` / "DROP HERE" styles.
- **Invariant:** Never *subscribe* to Zustand (hooks) inside the R3F `<Canvas>` subtree (React Error #185). Imperative `useStore.getState()` calls inside event handlers are safe. Communicate into the scene via props / `CustomEvent` (as `robot-select` does).

## 4. Chosen approach — Raycast-on-drop inside R3F

The drag source (chip) is DOM; the drop target (room floor) is inside the WebGL canvas. Of three bridging options (raycast-on-drop, DOM overlay drop zones, drop-on-room-list), we use **raycast-on-drop** because it is accurate under orbit/pan/zoom and reuses the most existing machinery.

A small R3F helper component (`RoomDropController`) rendered **inside** the canvas obtains `{ gl, camera }` via `useThree` and attaches **native** `dragover` / `drop` / `dragleave` listeners to `gl.domElement`. On each event it:

1. Converts the pointer to NDC from `gl.domElement.getBoundingClientRect()`.
2. Intersects the **y=0 floor plane** mathematically: `raycaster.setFromCamera(ndc, camera)` then `raycaster.ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0,1,0), 0), out)` — **no hitbox mesh required**.
3. Resolves the room via `getZone(out.x, out.z, rooms)` → `roomIndex`, then finds the `roomConfig` whose `index === roomIndex` → `roomId`.

Rationale highlights:
- Native HTML5 drag **suppresses** `pointermove`, so MapControls/OrbitControls will not rotate the camera mid-drag — a free win (the drag begins from a DOM chip, so the canvas never receives a `pointerdown`).
- The raycast→getZone→roomId math is extracted as a **pure helper** (`resolveDropRoom`) so it is unit-testable without a live canvas.

## 5. Components

### A. Reveal empty rooms (filter)
- **`src/stores/uiStore.ts`:** add `showEmptyRooms: boolean` (default `false`), `toggleShowEmptyRooms()`, loader `loadShowEmptyRooms()` + persistence to `localStorage['show-empty-rooms']` (mirror the `room-filter` / `card-display-mode` patterns).
- **`src/components/session/SessionSwitcher.tsx`:** when `showEmptyRooms`, `availableRooms` also includes rooms with zero active sessions (still requiring a defined `roomIndex` so they are real, placeable rooms). Render empty rooms dimmed with an `(empty)` tag. Add a **"Show empty rooms"** toggle row inside the existing funnel dropdown. Empty rooms are shown for **discoverability + as 3D drop targets**; they remain checkable like any room (checking one simply filters the session tab strip to its — currently zero — sessions, which is harmless), so no special non-interactive state is needed.
- **`src/styles/modules/DetailPanel.module.css`:** styles for the toggle row + the dimmed `(empty)` room option.

### B. Drag source — `MiniRobot` (`HeaderAgentStrip.tsx`)
- Add `draggable`, `data-session-id={sessionId}`, `onDragStart` (`e.dataTransfer.setData('application/x-session-id', sessionId)`; set `effectAllowed='move'`; optional custom drag image), and `onDragEnd` (clear any drag visual state).
- Keep `onClick` (select) and the pin icon's `stopPropagation` intact — a clean click and a drag are distinct gestures.
- **`src/styles/modules/Header.module.css`:** optional `.dragging` affordance (e.g., reduced opacity on the source chip).

### C. Drop bridge — new `src/components/3d/RoomDropController.tsx` (rendered inside `CyberdromeScene` canvas)
- Receives `roomConfigs` (already computed in the DOM layer and available in the scene) as a prop; obtains `{ gl, camera }` via `useThree`.
- `dragover`: `preventDefault()` (to permit drop), compute `roomId` via the pure helper, store `hoveredZone` (ref + a light `useState` to drive the highlight). Render a **translucent highlight box** at `computeRoomBounds(hoveredZone)` as the "drop here" cue. Zone −1 (corridor / outside) → no highlight.
- `dragleave` / `drop`: clear `hoveredZone`.
- `drop`: read `sessionId` from `dataTransfer`, resolve `roomId`; if valid and different from the current room, commit (below). Ignore drops resolving to no room.
- **`src/components/3d/CyberdromeScene.tsx`:** mount `<RoomDropController roomConfigs={roomConfigs} />` inside the canvas content.
- **`src/lib/cyberdromeScene.ts`:** add the pure helper `resolveDropRoom(pointer, rect, camera, rooms, roomConfigs): { roomIndex: number; roomId: string | null }` wrapping NDC→plane→`getZone`→roomId.

### D. Drop commit (identical regardless of bridge)
```ts
const rs = useRoomStore.getState();
const old = rs.getRoomForSession(sessionId)?.id ?? '';
if (roomId && roomId !== old) rs.moveSession(sessionId, old, roomId);
window.dispatchEvent(new CustomEvent('robot-select', { detail: { sessionId } }));
```
`moveSession` auto-persists (localStorage + workspace autosave); `SessionRobot`'s `roomIndex` effect renavigates the robot; `robot-select` flies the camera over for confirmation.

### E. Re-click "reuse"
No new code. Clicking the robot already dispatches `robot-select` → `selectSession` + camera fly + DetailPanel open.

## 6. Data flow

```
MiniRobot dragstart (dataTransfer: sessionId)
  → drop on WebGL canvas (gl.domElement)
  → RoomDropController: NDC → intersect y=0 plane → getZone → roomConfig → roomId
  → roomStore.moveSession(sessionId, oldRoomId, roomId)
      → persist localStorage['session-rooms'] + useWorkspaceAutoSave
      → SessionRobot useEffect(roomIndex) renavigates robot into the room
  → CustomEvent('robot-select') → camera fly + select + DetailPanel
```

## 7. Persistence

- Room membership (the placement) persists via `roomStore` → `localStorage['session-rooms']` and the workspace snapshot. No new persistence layer is introduced. (Robot XY positions live in `sessionStorage` and are intentionally **not** used for placement — membership is the durable channel, and the robot walks to its own spot.)
- `showEmptyRooms` persists to `localStorage['show-empty-rooms']`.

## 8. Edge cases

- **Drop on the same room** → `moveSession` early-returns (`from === to`); no-op.
- **Drop on corridor / outside any room (zone −1)** → ignored (no-op), per decision (b).
- **Orphan session (no current room)** → `old = ''`; `moveSession` still adds it to the target.
- **Rooms without a `roomIndex`** (corridor-only) are **not** valid drop targets (they have no floor AABB).
- **Empty target room** → works identically; the robot is the first occupant.
- **Mid-drag camera control** → OrbitControls does not fire during native HTML5 drag; no accidental rotation.

## 9. Testing

- **Unit (`uiStore`):** `toggleShowEmptyRooms` flips state and round-trips `localStorage['show-empty-rooms']`.
- **Unit (`SessionSwitcher` selection logic):** with `showEmptyRooms` on/off, `availableRooms` includes/excludes zero-session rooms (extract the room-list derivation if needed for testability).
- **Unit (pure helper `resolveDropRoom`):** given a mock camera + `roomConfigs`, an NDC pointing inside a room resolves to that `roomId`; a pointer over the corridor resolves to `roomIndex === -1` / `roomId === null`.
- **Drop commit** is just `moveSession`, already covered by `roomStore` tests; add a focused test asserting the commit calls `moveSession(sessionId, old, target)` and skips when `target === old`.
- Target ≥80% coverage on new units (per project testing rules). E2E (Playwright) for the full drag gesture is optional/stretch given native-DnD + WebGL automation cost.

## 10. Files touched

| File | Change |
|------|--------|
| `src/stores/uiStore.ts` | `showEmptyRooms` state + toggle + persistence |
| `src/components/session/SessionSwitcher.tsx` | reveal empty rooms in filter; toggle row |
| `src/styles/modules/DetailPanel.module.css` | dropdown toggle + `(empty)` styles |
| `src/components/layout/HeaderAgentStrip.tsx` | make `MiniRobot` draggable + `data-session-id` |
| `src/styles/modules/Header.module.css` | optional dragging affordance |
| `src/lib/cyberdromeScene.ts` | pure `resolveDropRoom` helper |
| `src/components/3d/RoomDropController.tsx` | **new** — native DnD listener + raycast + highlight |
| `src/components/3d/CyberdromeScene.tsx` | mount `RoomDropController` |

## 11. Non-goals / out of scope

- No fixed per-session drop coordinates (no robot-position pinning).
- No resume/respawn on click (open/focus only).
- No permanent empty-room glow in the scene (hover highlight only during drag).
- No multi-session drag (single chip at a time).
- No new "parking" pseudo-room.

## 12. Docs to update after implementation

`docs/feature/3d/cyberdrome-scene.md`, `docs/feature/3d/robot-system.md`, `docs/feature/frontend/session-detail-panel.md` (room filter), and any header / room-grouping doc.
