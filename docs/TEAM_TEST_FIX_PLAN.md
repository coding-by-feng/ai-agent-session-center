# Team Mission: Test, Enhance & Fix

## Context

AI Agent Session Center — a localhost dashboard (port 3333) monitoring AI coding agent sessions via hooks. Frontend: React 19 + Three.js + Zustand + Vite. Backend: Express 5 + TypeScript + WebSocket + node-pty + SQLite.

## Scope

**88 identified bugs/issues across 6 domains.**

> **IMPORTANT — DOMAIN 6 (Performance) is the highest-priority agenda.** The dashboard must remain responsive when users are actively typing in SSH terminals running Claude Code CLI, Gemini CLI, or similar interactive tools. 3D rendering, hook processing, and terminal output handling must NOT degrade typing latency or cause terminal flashing/duplicate lines.

Each issue includes severity, description, root cause, fix direction, and file location. Issues are numbered globally for cross-referencing and tracking.

---

## DOMAIN 1: Session Detail Panel (17 issues)

### CRITICAL

#### #1 — QueueTab drag-and-drop index corruption

- **File:** `src/components/session/QueueTab.tsx:232-243`
- **Problem:** `splice()` shifts indices, making `targetIdx` off-by-one after the first splice. Items reorder incorrectly or cause data corruption. `dragIdx` state updates synchronously while `reorder()` is async, causing stale index references during rapid drag.
- **Fix:** Recalculate `targetIdx` after splice (`const newIdx = targetIdx > dragIdx ? targetIdx - 1 : targetIdx`). Use immutable array operations. Add validation that final array has correct length.

#### #2 — KillConfirmModal async-after-unmount

- **File:** `src/components/session/KillConfirmModal.tsx:45`
- **Problem:** `closeModal()` unmounts the component immediately, then `await fetch()` fires on the unmounted component — React warning + state leak. `setKilling(false)` runs after component is gone.
- **Fix:** Move `closeModal()` to after fetch completes, or move `killing` state to parent and pass as prop, or use a ref to track pending requests.

#### #3 — QueueTab auto-send deletes prompt even when no terminal

- **File:** `src/components/session/QueueTab.tsx:116-132`
- **Problem:** `sendPromptToTerminal()` fails silently if no `terminalId` (shows error toast), but `remove()` still runs afterward — prompt is lost forever with no way to recover.
- **Fix:** Check `terminalId` exists before calling `remove()`. Only remove after successful send.

### HIGH

#### #4 — SessionControlBar resume fetch leaks on unmount

- **File:** `src/components/session/SessionControlBar.tsx:35-60`
- **Problem:** No AbortController. Selecting a different session mid-fetch triggers setState on unmounted component. If server is slow, `resuming` state stays true forever.
- **Fix:** Add AbortController, abort in useEffect cleanup. Reset state on sessionId change.

#### #5 — NotesTab silent API failures

- **File:** `src/components/session/NotesTab.tsx:30-45`
- **Problem:** Network error in `loadNotes()` is swallowed by empty catch block. User sees empty notes, can't distinguish "no notes" from "failed to load notes".
- **Fix:** Add error state, show error toast on load failure, add retry button.

#### #6 — SummarizeModal stale session closure

- **File:** `src/components/session/SummarizeModal.tsx:83-112`
- **Problem:** User switches sessions mid-summarize. `buildContext()` runs with current session, fetch completes for old session, toast references wrong session.
- **Fix:** Capture `sessionId` at invocation time (not from closure). Validate sessionId matches before showing toast.

#### #7 — LabelChips eventual consistency

- **File:** `src/components/session/LabelChips.tsx:55-81`
- **Problem:** Local state updates immediately, but server fetch can fail silently — label reverts on page reload. User thinks label is saved.
- **Fix:** Add error toast on failure, rollback local state on server error.

#### #8 — KillConfirmModal terminal deletion not awaited

- **File:** `src/components/session/KillConfirmModal.tsx:45-47`
- **Problem:** Terminal DELETE fetch is fire-and-forget (`.catch(() => {})`). If deletion fails, PTY process keeps running — resource leak.
- **Fix:** Await the DELETE fetch. Handle failure with toast.

### MEDIUM

#### #9 — ActivityLog key collision

- **File:** `src/components/session/ActivityLog.tsx:70-100`
- **Problem:** Key is `${item.timestamp}-${i}`. Multiple tool calls at same millisecond produce same timestamp. If items reorder, `i` changes, key changes, React remounts.
- **Fix:** Use unique item ID (e.g., `item.id` or generate UUID on creation).

#### #10 — DetailPanel Escape listener re-binds on every session update

- **File:** `src/components/session/DetailPanel.tsx:90-99`
- **Problem:** `useEffect` depends on `session` object which changes frequently (promptHistory updates, status changes). Each update adds/removes event listener — thousands of times per session.
- **Fix:** Depend on `session?.sessionId` only, not the entire session object.

#### #11 — ResizablePanel localStorage race

- **File:** `src/components/ui/ResizablePanel.tsx:36-67`
- **Problem:** Rapid open/close triggers multiple localStorage writes. No debounce. If localStorage write fails, in-memory width still updates — lost on reload.
- **Fix:** Debounce localStorage writes (200ms).

#### #12 — SessionControlBar archive/delete silent failures

- **File:** `src/components/session/SessionControlBar.tsx:80-94`
- **Problem:** catch blocks swallow errors silently. User clicks ARCHIVE/DELETE, sees no feedback on failure.
- **Fix:** Add error toasts in catch blocks.

#### #13 — QueueTab edit state doesn't reset on session change

- **File:** `src/components/session/QueueTab.tsx:315`
- **Problem:** `editingId` persists when panel switches to a different session. User submits edit → goes to wrong session's queue.
- **Fix:** Add useEffect to reset `editingId` and `editText` when `sessionId` changes.

### LOW

#### #14 — PromptHistory dead import

- **File:** `src/components/session/PromptHistory.tsx:7`
- **Problem:** `escapeHtml` imported from `@/lib/format` but never used.
- **Fix:** Remove the import.

#### #15 — DetailTabs always renders `.active` class

- **File:** `src/components/session/DetailTabs.tsx:85-87`
- **Problem:** `className` always includes `${styles.active}`, never toggles.
- **Fix:** Conditional: `${activeTab ? styles.active : ''}`.

#### #16 — AlertModal weak input validation

- **File:** `src/components/session/AlertModal.tsx:28-55`
- **Problem:** No visual feedback when minutes=0 or invalid. Button just disables silently.
- **Fix:** Add validation message, visual error indicator.

#### #17 — PromptHistory previous sessions sort inconsistency

- **File:** `src/components/session/PromptHistory.tsx:25-27`
- **Problem:** `.reverse()` on previousSessions without comment — confusing order mismatch with current session (newest-first) vs previous (oldest-first).
- **Fix:** Add comment explaining intent, or make sort order consistent.

---

## DOMAIN 2: Terminal Linkage (17 issues)

### CRITICAL

#### #18 — Missing `/api/sessions/:id/reconnect-terminal` endpoint

- **Files:** `server/apiRouter.ts` + `src/components/session/DetailPanel.tsx:53`
- **Problem:** Frontend calls `POST /api/sessions/:id/reconnect-terminal`, but this endpoint does NOT exist in the API router. Returns 404. RECONNECT button is completely broken.
- **Fix:** Add the endpoint to `apiRouter.ts` — should either reconnect existing PTY or integrate with the resume flow.

#### #19 — PTY event listener disposal missing

- **File:** `server/sshManager.ts:236-407`
- **Problem:** `ptyProcess.onData()` and `ptyProcess.onExit()` return `IDisposable` objects that are never stored. Cleanup only does `terminals.delete()` — event listeners continue firing on dead terminals. Memory leak.
- **Fix:** Store disposables, call `.dispose()` in cleanup function.

#### #20 — SSH kill doesn't close PTY

- **File:** `server/sessionStore.ts:944-962`
- **Problem:** `killSession()` unlinks terminal from session (`session.terminalId = null`) but the PTY process keeps running, consuming resources.
- **Fix:** Call `closeTerminal(session.terminalId)` before unlinking.

#### #21 — Terminal death doesn't unbind session

- **File:** `server/sshManager.ts:325-333`
- **Problem:** PTY exits → `terminals.delete()` but the associated session still has `terminalId` pointing to the dead terminal. Session state is inconsistent.
- **Fix:** In `onExit` callback, find the session by terminalId and clear `session.terminalId`, set `session.lastTerminalId`.

### HIGH

#### #22 — PTY created before WS client set

- **Files:** `server/apiRouter.ts:586`, `server/sshManager.ts:236-407`
- **Problem:** REST API calls `createTerminal(config, null)` with wsClient=null. Terminal spawns, `terminal_ready` event sent to null client — lost. Frontend may never know to subscribe.
- **Fix:** Re-emit `terminal_ready` in `setWsClient()`, or restructure initialization order.

#### #23 — Session-terminal binding race window

- **File:** `server/apiRouter.ts:586-588`
- **Problem:** Terminal exists in `terminals` Map before session is created. If a hook event arrives during this window, session matcher can't find it by terminalId — creates a duplicate session.
- **Fix:** Create session entry first (with CONNECTING status), then create terminal.

#### #24 — WS reconnect clears terminal then replays

- **File:** `src/hooks/useTerminal.ts:111-118`
- **Problem:** On WS reconnect, `term.clear()` destroys all local content, then subscribes for buffer replay. Output during the disconnection period may not be in the 128KB buffer — data loss.
- **Fix:** Don't clear terminal on reconnect, just append replayed buffer.

#### #25 — Output buffer overflow on large chunks

- **File:** `server/sshManager.ts:312-313`
- **Problem:** If a single output chunk exceeds `OUTPUT_BUFFER_MAX` (128KB), the slice logic silently discards it.
- **Fix:** Stream or split large chunks, or use circular buffer.

#### #26 — Session matching ambiguity with multiple pending resumes

- **File:** `server/sessionMatcher.ts:204-227`
- **Problem:** Same projectPath + multiple candidates → skip auto-resume → creates duplicate. Second session with same path can't be matched.
- **Fix:** Use terminalId more aggressively in Priority 0 matching.

### MEDIUM

#### #27 — Pending output buffer never cleaned for destroyed terminals

- **File:** `src/hooks/useTerminal.ts:97, 277-298`
- **Problem:** `pendingOutputRef` Map entries accumulate for orphaned terminals (max 500 items each, ~500KB per terminal). Never cleaned unless terminal is re-attached.
- **Fix:** Add TTL-based cleanup (60s) to discard stale buffers.

#### #28 — Resize debounce too short (50ms)

- **File:** `src/hooks/useTerminal.ts:243-250`
- **Problem:** 50ms debounce → ~20 resize messages/sec during window resize. Excessive server load.
- **Fix:** Increase to 200ms.

#### #29 — ResizeObserver leak on rapid reparent

- **File:** `src/hooks/useTerminal.ts:121-133, 357-387`
- **Problem:** If `reparent()` is called multiple times rapidly, old ResizeObserver not disconnected before creating new one.
- **Fix:** Explicitly disconnect old observer before replacing.

#### #30 — Terminal subscribe vs terminal close race

- **File:** `server/wsManager.ts:102-107`
- **Problem:** Client subscribes to terminal that server is closing. `setWsClient()` registers client for dead terminal.
- **Fix:** Check terminal existence in `setWsClient()` before registering.

#### #31 — PTY resize errors silent

- **File:** `server/sshManager.ts:524-534`
- **Problem:** `pty.resize()` failure is debug-logged only. Client xterm and server PTY diverge in size.
- **Fix:** Send error/notification back to client.

#### #32 — Shell ready timeout sends command anyway

- **File:** `server/sshManager.ts:74-128`
- **Problem:** If shell ready detection times out, `.then()` handler still sends the launch command to a potentially broken shell.
- **Fix:** Check terminal state in `.then()`, abort if terminal is dead or in unexpected state.

### LOW

#### #33 — Form validation missing in session creation modals

- **Files:** `src/components/modals/NewSessionModal.tsx`, `src/components/modals/QuickSessionModal.tsx`
- **Problem:** No host/port/username validation before POST. No submit debouncing — double-click creates two terminals.
- **Fix:** Add Zod validation, disable button during submit.

#### #34 — QuickSessionModal same missing reconnect endpoint

- **File:** `src/components/modals/QuickSessionModal.tsx`
- **Problem:** Same broken reconnect call as #18.
- **Fix:** Resolved by #18.

---

## DOMAIN 3: WebSocket & State Management (14 issues)

### CRITICAL

#### #35 — Approval timer holds stale session object

- **File:** `server/approvalDetector.ts:43-80`
- **Problem:** Timer fires after 3-8s, references session object from creation time — not current state. Session may have been updated, ended, or deleted.
- **Fix:** Store sessionId only, lookup current session state when timer fires.

#### #36 — Event ring buffer stores shallow copies

- **File:** `server/sessionStore.ts:60-77`
- **Problem:** `pushEvent()` stores shallow copy of session. Nested arrays (toolLog, promptHistory) are shared references. Mutations to session after push corrupt the ring buffer — replay returns wrong data.
- **Fix:** Deep clone data on push: `JSON.parse(JSON.stringify(data))`.

#### #37 — hasChildProcesses defaults false on error

- **File:** `server/approvalDetector.ts:27-37`
- **Problem:** `pgrep -P {pid}` timeout or permission error → returns false → approval timer fires even though command is still running.
- **Fix:** Return true on error as safer default (assume still running).

### HIGH

#### #38 — Resume doesn't clear cachedPid

- **File:** `server/sessionStore.ts:1016-1061`
- **Problem:** Old PID remains in `pidToSession` map after resume. New session reports different PID → conflicts or stale mapping.
- **Fix:** Clear `session.cachedPid = null` and remove from `pidToSession` before resuming.

#### #39 — Snapshot doesn't reconcile client IndexedDB

- **File:** `src/hooks/useWebSocket.ts:32`
- **Problem:** Deleted sessions aren't removed from browser IndexedDB. Stale ended sessions persist across page reloads.
- **Fix:** On snapshot, delete IndexedDB sessions not present in snapshot keys.

#### #40 — Broadcast dedup race on non-session types

- **File:** `server/sessionStore.ts:463-489`
- **Problem:** Non-session broadcasts use random keys (`${type}_${Date.now()}_${Math.random()}`). Can miss deduplication or send out-of-order.
- **Fix:** Apply unique sequencing to all broadcast types, not just session_updates.

### MEDIUM

#### #41 — PendingResume cleanup race

- **File:** `server/autoIdleManager.ts:76-100`
- **Problem:** 30s cleanup interval can delete pendingResume entry before slow SessionStart hook arrives (~2-5s on congested systems).
- **Fix:** Add grace period before cleanup, or check session status before deleting.

#### #42 — Team cleanup 15s defer + subagent restart

- **File:** `server/teamManager.ts:175-207`
- **Problem:** All children end → cleanup scheduled in 15s. If a subagent restarts within that window, it can't find the team.
- **Fix:** Cancel cleanup timer when new child is added.

#### #43 — ProcessMonitor mutates potentially deleted session

- **File:** `server/processMonitor.ts:36-94`
- **Problem:** Iterator continues modifying session after another part of code deletes it from the Map. Changes are lost.
- **Fix:** Add defensive `sessions.has(id)` check before mutating.

#### #44 — Terminal subscribe race with terminal close

- **File:** `server/wsManager.ts:102-107`
- **Problem:** `setWsClient()` registers client for dead terminal. Duplicate of #30 from server perspective.
- **Fix:** Check terminal existence before registering.

### LOW

#### #45 — WS deduplication snapshot race

- **File:** `src/hooks/useWebSocket.ts:19-32`
- **Problem:** Old+new session IDs in dedup window → stale data could be kept based on timestamp comparison.
- **Fix:** Validate Map key matches `session.sessionId`.

#### #46 — Settings persistence circular reference risk

- **File:** `src/stores/settingsStore.ts:492`
- **Problem:** Nested objects could theoretically fail `JSON.stringify` if circular refs are introduced.
- **Fix:** Use safe serializer with replacer function.

#### #47 — Session matching zombie SSH + ended collision

- **File:** `server/sessionMatcher.ts:244-271`
- **Problem:** Both zombie SSH (CONNECTING, no terminal) and ENDED sessions become candidates for same projectPath → ambiguous skip.
- **Fix:** Prefer ENDED sessions over zombie candidates.

#### #48 — Broadcast dedup 50ms window too wide

- **File:** `server/sessionStore.ts:463`
- **Problem:** Some real-time updates delayed by up to 50ms. May feel sluggish for rapid events.
- **Fix:** Consider reducing to 20ms.

---

## DOMAIN 4: 3D Scene & UI (11 issues)

### CRITICAL

#### #49 — THREE.js material leaks in CyberdromeEnvironment

- **File:** `src/components/3d/CyberdromeEnvironment.tsx:28-123`
- **Problem:** Materials created in `useMemo` (wallMat, cyStripMat, mgStripMat, deskMat, etc.) are NEVER disposed. Room reconfigurations leak hundreds of material instances → WebGL context exhaustion.
- **Fix:** Add `useEffect` cleanup that calls `.dispose()` on all materials.

#### #50 — EdgesGeometry leaks in Robot3DModel

- **File:** `src/components/3d/Robot3DModel.tsx:523-528`
- **Problem:** 6 `EdgesGeometry` instances per robot created in `useMemo`, never disposed. With 50+ robots = 300+ geometry objects leaking → GPU memory grows indefinitely.
- **Fix:** Store geometries, add `useEffect` cleanup with `.dispose()`.

### HIGH

#### #51 — SceneThemeSync mutates THREE objects in useMemo

- **File:** `src/components/3d/CyberdromeScene.tsx:50-66`
- **Problem:** `scene.fog` reassigned and properties mutated inside `useMemo`. Violates immutability principle, can cause visual glitches during rapid theme changes.
- **Fix:** Move to `useEffect` instead of `useMemo`.

#### #52 — CameraController requestId collision

- **File:** `src/components/3d/CameraController.tsx:29-60`
- **Problem:** `requestId` uses `Date.now()` with millisecond precision. Two `flyTo()` calls within 1ms share same ID → second animation ignored.
- **Fix:** Use incrementing counter instead of timestamp.

#### #53 — SessionRobot memo bypassed by array props

- **File:** `src/components/3d/SessionRobot.tsx:651-675`
- **Problem:** `workstations`, `doors`, `rooms` arrays are always new references from parent → custom `memo()` comparator doesn't check these → memo never prevents re-render.
- **Fix:** Memoize arrays in parent component, or add deep comparison for array props.

### MEDIUM

#### #54 — Multiple Escape key handlers conflict

- **Files:** `src/components/ui/Modal.tsx`, `src/components/session/DetailPanel.tsx`, `src/components/layout/WorkdirLauncher.tsx`, `src/hooks/useKeyboardShortcuts.ts`
- **Problem:** 4 handlers for Escape key with no priority system. When modal + detail panel + dropdown are open simultaneously, behavior is unpredictable.
- **Fix:** Centralized keyboard manager with priority system and `e.stopPropagation()`.

#### #55 — Canvas context exhaustion on rapid robot clicks

- **File:** `src/components/session/DetailPanel.tsx`
- **Problem:** Mini 3D robot preview creates a new WebGL context on each mount. Rapid clicks on 50 robots → 50 contexts created/destroyed. Browser limit is ~8-16 active contexts.
- **Fix:** Reuse a single offscreen Canvas, or fall back to 2D preview.

#### #56 — sessionArray recomputes on every session update

- **File:** `src/components/3d/CyberdromeScene.tsx:316-345`
- **Problem:** `sessions` Map identity changes on any update. `useMemo` recomputes on every change → 500 recomputations/sec with 50 robots.
- **Fix:** Memoize by session count + status fingerprint instead of Map identity.

#### #57 — No error boundary for 3D scene

- **File:** `src/routes/LiveView.tsx:11-25`
- **Problem:** If CyberdromeScene fails to load or crashes, user sees blank screen forever. No timeout, no fallback.
- **Fix:** Add React error boundary with user-friendly fallback UI.

#### #58 — Troika Text cache leak in RobotDialogue

- **File:** `src/components/3d/RobotDialogue.tsx:144-180`
- **Problem:** Rapidly changing text across 50 robots creates persistent cached text meshes in Troika. No explicit `.dispose()`.
- **Fix:** Add cleanup for text instances on unmount.

### ENHANCEMENT

#### #88 — Remove legs from all 3D robot character models

- **Files:** `src/lib/robot3DModels.ts`, `src/components/3d/Robot3DModel.tsx`
- **Problem:** All robot variants currently render leg geometry (legL/legR), hip joints, and foot meshes. The models with visible legs (robot, mech, spider, orb, tank) include leg meshes, hip joint spheres, foot meshes, leg edge wireframes, and associated animation code (walking, seated bending, idle reset). This adds unnecessary draw calls and visual complexity.
- **Scope of change:**
  1. **`robot3DModels.ts`** — Set `legL: { visible: false }` and `legR: { visible: false }` on all 6 model variants (robot, mech, spider, orb, tank already have leg defs; drone already has `visible: false`). Adjust `baseY` offsets so models don't float (legs contributed to grounding). Consider setting `hovers: true` for all models or recalculating base positions.
  2. **`Robot3DModel.tsx`** — Remove or gate all leg-related rendering: `legLRef`/`legRRef` refs, hip joint meshes, leg pivot groups (lines 608-624), leg edge geometries (`legLEdgeGeo`/`legREdgeGeo`), foot meshes. Remove all `legLRef.current.rotation.x` / `legRRef.current.rotation.x` assignments across all 8 animation functions (idle, thinking, working, waiting, alert, input, offline, connecting). Remove the seated-leg-bending logic (`legL/R.rotation.x = 1.2`).
  3. **Animation adjustments** — Without legs, models will need rebalanced idle bob, working motion, and alert bounce. The "seated" pose (legs bent at 1.2 radians) needs replacement — e.g., slightly lowered Y position or different body tilt to convey sitting.
  4. **Model interface cleanup** — Consider removing `legL`/`legR` from `ModelDef` interface, or keep `visible: false` as a soft removal for potential future re-enablement.
- **Fix:** Set all leg visibility to false in model defs, adjust baseY values, remove leg rendering code from Robot3DModel, update animations to remove leg references, rebalance seated/walking poses.

---

## DOMAIN 5: Mobile / Responsive (15 issues)

### CRITICAL

#### #59 — Session creation buttons disappear on mobile

- **Files:** `src/styles/modules/NavBar.module.css:32-43`, `src/components/layout/NavBar.tsx:43-73`
- **Problem:** `.actionsItems` has `max-width: 600px` with no responsive breakpoint. On phones <640px, NEW/QUICK/DIRS buttons overflow and vanish. No hamburger menu or collapse toggle exists.
- **Fix:** Add responsive media query. Options: (a) collapsible hamburger menu, (b) icon-only mode at small breakpoints, (c) horizontal scroll with `overflow-x: auto`.

#### #60 — Detail panel tabs can't scroll horizontally

- **File:** `src/styles/modules/DetailPanel.module.css:84-88`
- **Problem:** `.tabs` uses `display: flex` with NO `overflow-x: auto`. 6 tabs (TERMINAL | PROMPTS | QUEUE | NOTES | ACTIVITY | SUMMARY) overflow invisibly on phones — user can't see or access rightmost tabs.
- **Fix:** Add `overflow-x: auto`, `flex-wrap: nowrap`, `-webkit-overflow-scrolling: touch`, and optional `scroll-snap-type: x proximity`.

#### #61 — NavBar navigation links overflow on mobile

- **File:** `src/styles/modules/NavBar.module.css:1-77`
- **Problem:** 5 nav items (LIVE, HISTORY, TIMELINE, ANALYTICS, QUEUE) in flex row with no wrap, no responsive handling. Total min-width ~400px+ exceeds phone screens.
- **Fix:** Add responsive hamburger menu, or horizontal scroll with smaller padding at mobile breakpoints.

### HIGH

#### #62 — Control bar buttons overflow on mobile

- **File:** `src/styles/modules/DetailPanel.module.css:137-161`
- **Problem:** `.ctrlBar` has 7 items (RESUME, KILL, ARCHIVE, DELETE, SUMMARIZE, ALERT + room select) in flex row with NO `flex-wrap`. Minimum ~490px needed.
- **Fix:** Add `flex-wrap: wrap` and reduce button padding at `@media (max-width: 640px)`.

#### #63 — Hover-only copy/remove buttons unreachable on touch

- **Files:** `src/styles/modules/DetailPanel.module.css:116-118`, `src/styles/modules/WorkdirLauncher.module.css`
- **Problem:** `.convCopy` and `.dirRemove` buttons use `opacity: 0` + `:hover` to show. No `@media (hover: none)` fallback. On touch devices, buttons are invisible and untappable.
- **Fix:** Add `@media (hover: none)` rule to show buttons at reduced opacity (e.g., 0.5).

#### #64 — Close button too small for touch (32x32px)

- **File:** `src/styles/modules/DetailPanel.module.css:43-50`
- **Problem:** WCAG AA requires 44x44px minimum touch targets. Current close button is 32x32px, positioned tight to viewport edge (top: 12px, right: 16px).
- **Fix:** Increase to `width: 44px; height: 44px`. Add `@media (pointer: coarse)` override.

#### #65 — Room rename/delete buttons ~15x15px

- **File:** `src/components/3d/SceneOverlay.tsx:205-232`
- **Problem:** Inline styles set `fontSize: 10, padding: '0 2px'` → ~15x15px touch targets. Almost impossible to tap on mobile.
- **Fix:** Increase to minimum 44x44px with proper padding. Use CSS classes instead of inline styles.

#### #66 — Form inputs too small for touch (~30px height)

- **File:** `src/styles/modules/Modal.module.css:47-54`
- **Problem:** `padding: 6px 8px` with `font-size: 12px` creates ~30px height inputs. iOS auto-zooms viewport on inputs with font-size < 16px.
- **Fix:** Add `@media (pointer: coarse)` rule: `height: 44px; font-size: 16px; padding: 12px 14px`.

### MEDIUM

#### #67 — Detail panel header cramped on mobile

- **File:** `src/styles/modules/DetailPanel.module.css:54-81`
- **Problem:** `padding: 20px 50px` wastes right-side space. 64x80px robot preview takes too much room. No responsive stacking (always horizontal flex).
- **Fix:** At `@media (max-width: 640px)`: reduce padding to `12px 16px`, shrink preview to 48x60px, optionally stack vertically.

#### #68 — WorkdirLauncher dropdown too wide for phones

- **File:** `src/styles/modules/WorkdirLauncher.module.css:36-51`
- **Problem:** `min-width: 280px`, `max-width: 380px` with `position: absolute; right: 0`. On <420px screens, dropdown overflows viewport.
- **Fix:** At `@media (max-width: 480px)`: constrain to `max-width: 90vw; min-width: unset`.

#### #69 — NewSessionModal hardcoded 420px width

- **File:** `src/styles/modules/Modal.module.css:40, 149-153`
- **Problem:** `.newSessionPanel { width: 420px }` overflows on 375px phones. Existing media query sets `width: 95vw` but should use `max-width`.
- **Fix:** Change to `max-width: min(420px, 95vw); width: 100%`.

#### #70 — Safe area inset variables defined but never used

- **File:** `src/styles/base.css:52-56`
- **Problem:** `--safe-top`, `--safe-right`, `--safe-bottom`, `--safe-left` are declared but no component references them. On iPhone with notch/Dynamic Island, fixed elements are hidden.
- **Fix:** Apply safe area padding to fixed/absolute positioned elements (panel, nav, close buttons).

### LOW

#### #71 — Form labels too small on mobile (10px)

- **File:** `src/styles/modules/Modal.module.css:47-54`
- **Problem:** `.sshField label { font-size: 10px }` is barely readable on phones.
- **Fix:** Increase to 11-12px at `@media (max-width: 480px)`.

#### #72 — Modal padding excessive on small phones (24px)

- **File:** `src/styles/modules/Modal.module.css:19-25`
- **Problem:** `padding: 24px` wastes screen real estate on 375px devices.
- **Fix:** Reduce to 16px at `@media (max-width: 480px)`.

#### #73 — Body scroll potentially janky on iOS

- **File:** `src/styles/base.css:67-86`
- **Problem:** Mobile override sets `overflow: visible` on body without `-webkit-overflow-scrolling: touch` on main scroll container. Scrolling may feel laggy.
- **Fix:** Add smooth scrolling to main content container.

---

## DOMAIN 6: Performance — Terminal Typing, 3D Rendering, Hook Impact (14 issues)

> **This is the most important domain.** Users interact with the dashboard primarily through SSH terminals running Claude Code, Gemini CLI, etc. Any lag, flashing, or duplicate lines while typing is unacceptable. The 3D scene, hook processing, and WebSocket relay must never degrade the terminal experience.

### CRITICAL

#### #74 — Double terminal subscribe on WS reconnect causes duplicate lines

- **File:** `src/hooks/useTerminal.ts:114-118`
- **Problem:** On WebSocket reconnect, the hook calls `term.clear()` then sends `terminal_subscribe`. Server replays its 128KB output buffer to the cleared terminal. But if the original subscription is still active on the server side, the client receives BOTH the replay buffer AND live output — causing duplicate lines. Combined with the `refitTerminal()` refresh button (line 339) which also subscribes, user can accidentally trigger double subscription.
- **Impact:** Terminal content flickers, duplicate lines appear, scrollback gets corrupted after WS reconnect or clicking RECONNECT.
- **Fix:** Track subscription state with a flag. Only subscribe once. On reconnect, unsubscribe first (`terminal_disconnect`), then clear, then re-subscribe. Server should deduplicate subscriptions per client per terminal.

#### #75 — 3D scene useFrame callbacks block terminal event loop

- **Files:** `src/components/3d/SessionRobot.tsx:319-460`, `src/components/3d/CameraController.tsx:29-60`
- **Problem:** Each SessionRobot has 4-5 `useFrame()` callbacks running at 60fps. Navigation AI includes wall collision detection (`collidesAnyWall`) iterating all walls — expensive O(N * walls) per frame per robot. JavaScript is single-threaded: when R3F Canvas monopolizes the main thread during collision detection, terminal `term.write()` calls and user keypresses queue up waiting.
- **Impact:** Typing in SSH terminal (Claude Code, Gemini CLI) feels laggy when 10+ robots are actively navigating. Input events are delayed by 16-50ms per frame.
- **Fix:** (a) Throttle robot navigation to run every 2nd or 3rd frame instead of every frame. (b) Use spatial partitioning (grid) for collision checks instead of brute-force. (c) When terminal tab is active, reduce 3D scene to low-priority rendering (e.g., 15fps). (d) Consider `requestIdleCallback` for non-critical robot AI.

#### #76 — Terminal output not batched — every WS message triggers immediate write

- **Files:** `src/components/terminal/TerminalContainer.tsx:74-94`, `src/hooks/useTerminal.ts:277-298`
- **Problem:** Every `terminal_output` WebSocket message triggers `term.write(bytes)` + `term.scrollToBottom()` synchronously with no batching. When Claude Code streams output rapidly (5-20 messages/sec during tool use), each triggers a full xterm.js reflow + scroll.
- **Impact:** Fast terminal output causes visible flickering. Scrollbar jumps on every write. CPU usage spikes during rapid output.
- **Fix:** Batch terminal writes using `requestAnimationFrame`. Accumulate output in a buffer, flush once per animation frame. Remove per-write `scrollToBottom()` — let xterm handle scroll naturally, or scroll only on the batched flush.

### HIGH

#### #77 — Output flush race condition on terminal attach

- **File:** `src/hooks/useTerminal.ts:257-265`
- **Problem:** When `attach()` is called, buffered output flushes immediately via `term.write()` loop. But the terminal container may not have its final CSS layout yet (still animating panel slide-in, or waiting for ResizeObserver). Flushed content renders at wrong dimensions, then reflowing when layout stabilizes.
- **Impact:** First output after switching to terminal tab appears to flash/redraw at slightly different position. Content may briefly appear double-width or misaligned.
- **Fix:** Delay flush until after `fitAddon.fit()` confirms stable dimensions. Use `requestAnimationFrame` to ensure layout is settled before writing buffered content.

#### #78 — Forced double-resize canvas repaint on every attach

- **File:** `src/hooks/useTerminal.ts:67-88, 268`
- **Problem:** `forceCanvasRepaint()` shrinks terminal by 1 column, waits one animation frame, then refits. This forces TWO layout recalculations + TWO server resize messages. It's a workaround for xterm canvas not painting after attach.
- **Impact:** Terminal visibly flickers (shrink → expand) every time user switches to terminal tab or detail panel opens.
- **Fix:** Replace with `term.refresh(0, term.rows - 1)` which forces canvas repaint without resizing. If that's insufficient, use `term.clearTextureAtlas()` (xterm v5) to force texture rebuild.

#### #79 — Refresh button clears terminal without preserving context

- **File:** `src/hooks/useTerminal.ts:332-351`
- **Problem:** `refitTerminal()` calls `term.clear()`, re-subscribes, enters/exits fullscreen, then calls `forceCanvasRepaint()`. Terminal goes completely blank, then slowly rebuilds from server buffer. Server buffer is only 128KB — long sessions lose earlier output.
- **Impact:** Clicking REFRESH causes 1-3 second blank screen while buffer replays. Users lose scrollback context.
- **Fix:** Don't clear terminal. Just call `fitAddon.fit()` + `term.refresh()`. If re-subscribe is needed, append new output without clearing existing content.

#### #80 — Hook processing broadcasts to all WS clients on every event

- **File:** `server/hookProcessor.ts:99`
- **Problem:** Every hook event (PreToolUse, PostToolUse, etc.) triggers TWO broadcasts: `session_update` + `hook_stats`. When user is typing in Claude Code, hooks fire rapidly (~10-60/minute). Each broadcast serializes JSON and sends to ALL connected WebSocket clients, including those displaying the terminal.
- **Impact:** Server CPU waste. More critically, the broadcast can queue WebSocket writes that compete with `terminal_output` messages for bandwidth — causing terminal output delay.
- **Fix:** (a) Only broadcast to clients that are subscribed to that session. (b) Throttle `session_update` broadcasts to max 4/sec (250ms). (c) Batch multiple session updates into a single broadcast. (d) Deprioritize non-terminal broadcasts when terminal output is active.

#### #81 — No client-side WebSocket backpressure detection

- **File:** `src/lib/wsClient.ts`
- **Problem:** Server implements backpressure (`client.bufferedAmount > MAX_BUFFERED_AMOUNT` → skip non-critical messages). But client has no matching logic: it keeps sending `terminal_input` messages without checking its own `ws.bufferedAmount`. During heavy output, the WS write buffer backs up.
- **Impact:** During high-volume terminal output (e.g., `npm install` scrolling), terminal_input keystrokes may be delayed because the WS send buffer is full. User types but characters appear 200-500ms later.
- **Fix:** Check `ws.bufferedAmount` before sending terminal_input. If buffer exceeds threshold, queue locally and retry after drain.

### MEDIUM

#### #82 — Panel slide-in animation destabilizes terminal layout

- **File:** `src/styles/modules/DetailPanel.module.css:27`
- **Problem:** Detail panel uses `animation: slide-in-right 0.3s ease` with `transform: translateX()`. The panel contains the terminal container. During the 300ms animation, the terminal container's dimensions are in flux — xterm's FitAddon calculates wrong cols/rows if it runs during the animation.
- **Impact:** Terminal may show wrong column count for a brief moment after panel opens, causing content to wrap incorrectly.
- **Fix:** Defer terminal attach until after animation completes (listen for `animationend` event), or use `will-change: transform` to hint browser, or attach terminal after a 350ms delay.

#### #83 — Terminal resize debounce too short (50ms) during panel drag

- **File:** `src/hooks/useTerminal.ts:243-250`
- **Problem:** ResizeObserver fires with 50ms debounce. When user drags the panel resize handle, `fitAddon.fit()` triggers every 50ms — each fit recalculates cols/rows and sends `terminal_resize` to server. Server resizes PTY, which can cause content reflow.
- **Impact:** Dragging resize handle while terminal has content causes lines to reflow/duplicate mid-drag. Content appears to "bounce" between column widths.
- **Fix:** Increase debounce to 200-300ms. During active resize (mouse down), suppress fits entirely and only fit on mouse up.

#### #84 — First output double-render artifact

- **File:** `src/hooks/useTerminal.ts:277-291`
- **Problem:** First terminal output writes immediately, then 100ms later calls `term.refresh(0, rows-1)` to force canvas repaint. This is a workaround for xterm not painting on first write.
- **Impact:** User sees faint visual artifact — content renders, then re-renders 100ms later with slightly different anti-aliasing.
- **Fix:** Use `term.write()` with a callback that triggers refresh, eliminating the 100ms delay. Or call `term.refresh()` synchronously after write.

#### #85 — Global scanline CSS animation runs 24/7

- **File:** `src/styles/base.css:105`
- **Problem:** `animation: scanline 8s linear infinite` runs a full-body pseudo-element animation at all times, even when terminal is focused.
- **Impact:** Minor (~1-2ms/frame) but adds up. Forces browser to composite an extra layer every frame.
- **Fix:** Disable scanline animation when terminal tab is active, or when user is typing (detect via focus state). Use `animation-play-state: paused` conditionally.

#### #86 — High scrollback buffer memory (10K lines per terminal)

- **File:** `src/hooks/useTerminal.ts:188`
- **Problem:** `scrollback: 10000` lines. With ~200 chars/line average, each terminal uses ~2MB. With 5 terminals, that's 10MB of scrollback in browser memory.
- **Impact:** With many terminals, memory pressure triggers garbage collection pauses (10-50ms stalls) that interrupt smooth typing.
- **Fix:** Reduce to 5000 lines, or make configurable. Consider trimming scrollback for inactive terminals.

### LOW

#### #87 — Server-side hook MQ reader file I/O could block event loop

- **File:** `server/mqReader.ts`
- **Problem:** MQ reader uses `fs.readFileSync` (or similar blocking read) to read new bytes from the queue file. During heavy hook traffic (~60 events/minute), file reads could briefly block the Node.js event loop.
- **Impact:** Minimal on typical usage, but during team mode with 10+ subagents all firing hooks simultaneously, the event loop stall could delay terminal_output relay by 5-10ms.
- **Fix:** Ensure all file reads are async (`fs.promises.read` with file handle). Use streaming reads instead of bulk reads.

---

## Team Structure

| Agent | Domain | Issues | Primary Focus |
|-------|--------|--------|---------------|
| **Agent 1** | Session Detail Panel | #1-17 | Fix panel bugs, add error handling, test tab interactions |
| **Agent 2** | Terminal Linkage | #18-34 | Fix reconnect endpoint, PTY lifecycle, session binding, resize |
| **Agent 3** | WebSocket + State | #35-48 | Fix approval timer, ring buffer, resume flow, cleanup races |
| **Agent 4** | 3D Scene + UI | #49-58 | Fix THREE.js leaks, memo optimization, escape key conflicts |
| **Agent 5** | Mobile / Responsive | #59-73 | Fix responsive CSS, touch targets, tab scrolling, nav collapse |
| **Agent 6** | Performance | #74-87 | Fix terminal flashing/dupes, throttle 3D, batch output, backpressure |

### Priority Order Per Agent

Each agent should fix issues in this order: CRITICAL → HIGH → MEDIUM → LOW.

### Cross-Domain Dependencies

| Dependency | Details |
|------------|---------|
| #18 blocks #34 | Missing endpoint fix resolves both issues |
| #20 depends on #21 | PTY cleanup and session unbinding should be fixed together |
| #54 relates to #10 | Escape key conflicts affect both detail panel and modal layer |
| #59 relates to #61 | NavBar responsive fixes should be done together |
| #60 relates to #62 | Detail panel responsive fixes (tabs + control bar) should be coordinated |
| #74 relates to #24 | Both involve WS reconnect terminal clearing — fix together |
| #75 relates to #49, #50 | 3D performance + memory leaks compound — fix leaks first, then throttle |
| #76 relates to #81 | Output batching + backpressure are two sides of same throughput issue |
| #78 relates to #82 | Both cause terminal flicker during attach — unify the attach flow |
| #80 relates to #40 | Broadcast dedup + hook broadcast throttle should be coordinated |
| #83 relates to #28 | Both are resize debounce — use same timing strategy |

---

## Testing Checklist

### Functional Tests

- [ ] Create SSH terminal → session card appears → click robot → detail panel opens
- [ ] Terminal tab shows live output, resize works, Escape sends to PTY
- [ ] Kill session → terminal closes → PTY process exits → no orphan processes
- [ ] Resume ended session → new terminal connects → old prompt history preserved
- [ ] Drag-reorder queue items → correct order persisted, no index corruption
- [ ] Auto-send queue when session waiting + terminal attached (and NOT when no terminal)
- [ ] Label/archive/delete with error recovery (verify toast on failure)
- [ ] WS disconnect → reconnect → terminal output replays correctly (no data loss)
- [ ] Notes save/load round-trip → verify persistence across page reload
- [ ] Summarize modal → verify correct session referenced after switching

### Performance Tests (HIGHEST PRIORITY)

- [ ] **Typing latency:** Open SSH terminal running Claude Code CLI → type commands → keypress-to-render must be <50ms with 20+ robots active
- [ ] **Terminal output streaming:** Run `cat` on a large file or `npm install` → output should stream smoothly, no flicker or duplicate lines
- [ ] **WS reconnect:** Disconnect WiFi for 5s, reconnect → terminal resumes without duplicate lines or content loss
- [ ] **Refresh button:** Click terminal RECONNECT → content rebuilds without full blank screen
- [ ] **Panel open during typing:** Open detail panel while typing in terminal → no input lag spike
- [ ] **Resize during typing:** Drag panel resize handle while terminal is active → no duplicate lines, content reflows cleanly
- [ ] **Tab switch:** Switch between TERMINAL and PROMPTS tabs 20 times rapidly → no flicker, no stale content
- [ ] **Hook flood:** Run 5 Claude Code sessions simultaneously → server stays responsive, terminal output not delayed
- [ ] 50+ robots running for 1 hour → no memory growth in browser DevTools
- [ ] Rapid robot clicking (20 clicks in 5s) → no WebGL context errors
- [ ] Open/close detail panel 100 times → no event listener accumulation
- [ ] Theme switching 50 times → no material/geometry leak in THREE.js

### State Consistency Tests

- [ ] Multiple sessions same directory → correct session matching, no duplicates
- [ ] Session resume → old PID cleared, new PID mapped correctly
- [ ] Team subagent restart → team association preserved
- [ ] Page reload → IndexedDB state matches server state

### Mobile Tests (use Chrome DevTools device emulation or real device)

- [ ] **375px (iPhone SE):** Nav buttons visible or accessible via hamburger/scroll
- [ ] **375px:** All 6 detail tabs accessible via horizontal scroll
- [ ] **375px:** Control bar buttons wrap properly, all tappable (44x44px+)
- [ ] **375px:** Close button easily tappable
- [ ] **375px:** Room rename/delete buttons tappable
- [ ] **375px:** Copy/remove buttons visible on touch (not hover-only)
- [ ] **375px:** Form inputs 44px+ height, 16px+ font (no iOS auto-zoom)
- [ ] **375px:** Modals fit within viewport, no horizontal overflow
- [ ] **375px:** WorkdirLauncher dropdown fits in viewport
- [ ] **iPhone notch:** Safe areas respected — no UI hidden under notch/Dynamic Island
- [ ] **768px (iPad):** Layout degrades gracefully, all features accessible
- [ ] **Touch scrolling:** Detail panel, tabs, and modals scroll smoothly on iOS

---

## Files Likely Modified

### Domain 1 (Session Detail)
- `src/components/session/QueueTab.tsx`
- `src/components/session/KillConfirmModal.tsx`
- `src/components/session/SessionControlBar.tsx`
- `src/components/session/NotesTab.tsx`
- `src/components/session/SummarizeModal.tsx`
- `src/components/session/LabelChips.tsx`
- `src/components/session/ActivityLog.tsx`
- `src/components/session/DetailPanel.tsx`
- `src/components/session/DetailTabs.tsx`
- `src/components/session/AlertModal.tsx`
- `src/components/session/PromptHistory.tsx`
- `src/components/ui/ResizablePanel.tsx`

### Domain 2 (Terminal)
- `server/apiRouter.ts`
- `server/sshManager.ts`
- `server/sessionStore.ts`
- `server/sessionMatcher.ts`
- `server/wsManager.ts`
- `src/hooks/useTerminal.ts`
- `src/components/modals/NewSessionModal.tsx`
- `src/components/modals/QuickSessionModal.tsx`

### Domain 3 (WebSocket + State)
- `server/approvalDetector.ts`
- `server/sessionStore.ts`
- `server/processMonitor.ts`
- `server/autoIdleManager.ts`
- `server/teamManager.ts`
- `src/hooks/useWebSocket.ts`
- `src/stores/settingsStore.ts`

### Domain 4 (3D Scene)
- `src/lib/robot3DModels.ts`
- `src/components/3d/CyberdromeEnvironment.tsx`
- `src/components/3d/Robot3DModel.tsx`
- `src/components/3d/CyberdromeScene.tsx`
- `src/components/3d/CameraController.tsx`
- `src/components/3d/SessionRobot.tsx`
- `src/components/3d/RobotDialogue.tsx`
- `src/routes/LiveView.tsx`

### Domain 5 (Mobile)
- `src/styles/modules/NavBar.module.css`
- `src/styles/modules/DetailPanel.module.css`
- `src/styles/modules/Modal.module.css`
- `src/styles/modules/WorkdirLauncher.module.css`
- `src/styles/base.css`
- `src/components/layout/NavBar.tsx`
- `src/components/3d/SceneOverlay.tsx`

### Domain 6 (Performance)
- `src/hooks/useTerminal.ts` (output batching, attach flow, flush race, resize debounce)
- `src/components/terminal/TerminalContainer.tsx` (output handler batching)
- `src/components/3d/SessionRobot.tsx` (useFrame throttling, collision optimization)
- `src/components/3d/CameraController.tsx` (frame-skip when not animating)
- `src/lib/wsClient.ts` (client-side backpressure)
- `src/styles/modules/DetailPanel.module.css` (slide-in animation timing)
- `src/styles/base.css` (scanline animation pause)
- `server/hookProcessor.ts` (broadcast throttling)
- `server/wsManager.ts` (per-session subscription filtering)
- `server/mqReader.ts` (async file I/O)
