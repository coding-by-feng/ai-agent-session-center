# Session Detail Panel

## Function
Slide-in panel showing comprehensive session information across 7 tabs, with a session switcher strip, session control bar, and three mutually-exclusive layout modes (side-by-side split, stacked, floating Project panel).

## Purpose
Primary interface for interacting with a single session. Aggregates terminal, project browser, ops commands, conversation transcript, AI-popup history, notes, and prompt queue in one view, plus per-session controls (resume/kill/mute/alert/room) and a horizontal switcher to jump between active sessions.

## Source Files
| File | Role |
|------|------|
| `src/components/session/DetailPanel.tsx` | Main panel container, ResizablePanel host, LazyModal wrapper, `TerminalContent`/`OpsTerminalContent` memoized wrappers, `DraggableMiniBadge`, panel-wide search state, visited-projects map |
| `src/components/session/DetailTabs.tsx` | 7-tab bar (PROJECT, TERMINAL, COMMANDS, CONVERSATION, AI POPUPS, NOTES, QUEUE), always-mounted vs on-demand mounting, split/stacked/float layout toggles, in-panel search bar |
| `src/components/session/SessionControlBar.tsx` | Resume / Kill / Mute / Alert-toggle buttons + Room `<Select>` dropdown |
| `src/components/session/SessionSwitcher.tsx` | Top bar (current session name + inline rename + status/model/duration + controls slot) and horizontal session tab strip (mini-robot cards, room-group frames, attention badge, room filter, compact/detailed toggle) |
| `src/components/session/NotesTab.tsx` | Per-session notes CRUD (NOTES tab) |
| `src/components/session/QueueTab.tsx` | Prompt queue management — used both in the QUEUE tab and inline below the terminal in the TERMINAL tab |
| `src/components/session/KillConfirmModal.tsx` | Kill-confirmation modal (lazy-mounted; SIGTERM→SIGKILL), `KILL_MODAL_ID = 'kill-confirm'` |
| `src/components/session/AlertModal.tsx` | Standalone timer-alert modal — writes a `timer` alert to the `db.alerts` Dexie table; `ALERT_MODAL_ID = 'alert-modal'`. **Currently dormant** — not imported or opened by any component; unrelated to the SessionControlBar "ALERT" sound toggle |
| `src/components/session/ContentSearchModal.tsx` | Content-search modal used inside ProjectTab for searching file contents |
| `src/components/session/FloatingProjectPanel.tsx` | Detached, draggable/resizable PROJECT-tab overlay; host for the portaled ProjectTabContainer in float mode; supports maximize/restore and a minimized PROJECT badge |
| `src/lib/cliDetect.ts` | Shared `detectCli(session)` — gates the in-place fork action to Claude/Codex sessions |

Cross-referenced but owned by sibling docs:
- `src/components/session/ConversationView.tsx` — CONVERSATION tab; see [Conversation View](./conversation-view.md).
- `src/components/session/AiPopupHistory.tsx` and `src/components/session/FloatingTerminalRoot.tsx` (rendered in `App.tsx`, not inside this panel) — see [Floating Terminal Fork](./floating-terminal-fork.md).

## Implementation

### Panel shell
- `DetailPanel` wraps everything in `ResizablePanel fullscreen`. The outer overlay is `display:none` (not unmounted) when no session is selected, so `ProjectTabContainer`/terminal state survives deselection.
- `lastSessionRef` keeps the most-recent session as `displaySession` so child containers stay mounted after deselect.
- Minimizable to a draggable badge (`DraggableMiniBadge`), position saved to `localStorage['mini-badge-pos']` (`MINI_BADGE_POS_KEY`). Click restores (only if it wasn't a drag).
- Header / title / rename live in **SessionSwitcher**, not DetailPanel — the top row shows a status dot, session-index chip, the title with inline double-click rename (`setSessionTitle`, no separate EditableTitle component), optional project name, status badge, model, duration, the `SessionControlBar` (passed via the `controls` prop), the room filter, the compact/detailed toggle, and the minimize button.

### Tabs and mounting
- 7 tabs (`BASE_TABS`): PROJECT, TERMINAL, COMMANDS, CONVERSATION (id `conversation`), AI POPUPS (id `aiPopups`), NOTES, QUEUE.
- TERMINAL, COMMANDS, and PROJECT are **always mounted** (hidden via `display:none`) to preserve the xterm instance/scroll and the file-tree/open-file state. CONVERSATION, AI POPUPS, NOTES, QUEUE mount on demand. Each on-demand tab gets a unique React key (`scroll-<id>`) so scroll position doesn't bleed across tabs.
- The COMMANDS tab is the session's blank "ops" shell (`OpsTerminalContent`); it only renders when `opsTerminalId || hadOpsTerminal`. With no ops terminal it shows a "CONNECT TERMINAL" placeholder that POSTs `/api/sessions/:id/reconnect-ops-terminal`.
- The TERMINAL tab (`TerminalContent`) stacks `TerminalContainer` over an inline `QueueTab` (`bottomRow`), and exposes Reconnect / Fork / Clone actions:
  - Reconnect (`onReconnect`) shown for ended SSH sessions or sessions with a `startupCommand`; POSTs `/api/sessions/:id/reconnect-terminal`.
  - Fork (`onFork`, Claude/Codex only via `detectCli`) POSTs `/api/sessions/:id/fork`; the new `terminalId` is selected and added to the same room.
  - Clone (`onClone`) POSTs `/api/sessions/:id/clone`; same select-and-room behaviour.
  - `TerminalContainer` is passed `originSessionId={sessionId}` so the select-to-translate popup and "Translate previous answer" toolbar action can fork a floating session (see [Floating Terminal Fork](./floating-terminal-fork.md)).

### Layout modes (split / stacked / float) — mutually exclusive
The PROJECT tab shows three toggle icons (wide panels only, `SPLIT_MIN_WIDTH = 700`). Enabling one disables the other two via the shared `turnOff` helper:
- **Split**: `DraggableSplitView` shows Terminal (left) + Project (right) with a `col-resize` divider, ratio clamp 0.15–0.85. Mode flag `split-terminal-project:{sessionId}` (`SPLIT_KEY`), ratio `split-ratio:{sessionId}` (`SPLIT_RATIO_KEY`, also mirrored to a global fallback).
- **Stacked**: `StackedSplitView` shows Terminal (top) + Project (bottom) with a `row-resize` divider, ratio clamp 0.2–0.8 — fits the ~480px panel better than side-by-side. Mode flag `split-stacked-terminal-project:{sessionId}` (`STACKED_KEY`), ratio `split-stacked-ratio:{sessionId}` (`STACKED_RATIO_KEY`).
- **Float**: PROJECT content is portaled (`createPortal`) into `FloatingProjectPanel` so file-tree expansion, image-viewer state, and find-in-file survive the detach. Mode flag `float-project:{sessionId}` (`FLOAT_KEY`). When float is on, the PROJECT tab redirects to TERMINAL so the terminal owns the panel.
- `effectiveTab` resolves to `'split'`/`'stacked'` when the corresponding mode is on and the active tab is terminal/project; in those modes the always-mounted terminal/project hosts are suppressed (the combined view renders its own single copies to avoid duplicate xterm subscriptions). All three flags restore per-session on session switch (default off so the previous session's state doesn't leak).

### Search
- A search bar sits between the tabs and content (`searchOpen` toggles `.hidden`). It searches the session's `promptHistory` text, shows a match counter (`N/total` or `0 results`), and Prev/Next navigation.
- `navigateMatch` auto-switches to the CONVERSATION tab, then scrolls the active `.search-highlight` into view (adding `.search-highlight-active`).
- Opened via the `detail-panel:find` CustomEvent (from the keyboard-shortcut handler); closed on Escape or session change.

### Tab switching via keyboard
- DetailPanel listens for the `detailTabs:switchTab` CustomEvent (dispatched from `useKeyboardShortcuts.ts`) and drives `externalTab`, which DetailTabs consumes via `externalActiveTab`. `externalTab` is cleared ~50ms after set so subsequent user clicks aren't blocked. The same `externalTab` mechanism switches to PROJECT when a terminal file link is clicked (`pendingFileOpen`).
- Active tab persisted in `localStorage['active-tab']` (`STORAGE_KEY`).

### SessionSwitcher details
- Mini-robot cards and session tab cards show a **spinning conic-gradient border** when status is `working`/`prompting`, and a **pulsing border** for `approval`/`input` (CSS in `DetailPanel.module.css`). The `.sessionTabIndex` badge sits at `left: -9px`.
- **Attention badge**: a session that transitions to `waiting` (or, for Codex, jumps `idle`→`waiting`) while not selected gets a red `!` badge (`attentionIds`), cleared when switched to.
- **Room grouping**: sessions sharing a room render inside a room-colored frame (`ROOM_COLOR_PALETTE`, matching HeaderAgentStrip), ordered by `roomIndex`; orphan sessions follow. A multi-select **room filter** dropdown (funnel icon) narrows the strip (`selectedRoomIds`); the current session is never filtered out.
- **Display mode toggle** switches between compact (title-only) and detailed (mini robot face + project + CLI badge) cards (`cardDisplayMode` in uiStore).
- **CLI badge** (`getCliBadge`) derives CLAUDE/CODEX/GEMINI/AIDER from the SSH command or `backendType`.
- **Recompute gating (perf)**: the `sessions` Map reference changes on every update (`new Map(...)`). To skip the O(N) sort + room-grouping on unchanged content, SessionSwitcher derives a stable `sessionsSignature` from `sessionId|status|pinned|title|projectName|colorIndex|accentColor|terminalId` (sorted + joined) and keys the heavy memos (`sortedSessions`, `activeSessionIds`, and downstream `filteredSessions`/`tabRenderItems`) to that signature instead of the Map reference.

### SessionControlBar
- **RESUME** (only when status `ended`) POSTs `/api/sessions/:id/resume`; inflight fetch is aborted on unmount/session change.
- **KILL** opens `KillConfirmModal` (`openModal(KILL_MODAL_ID)`); the modal POSTs `/api/sessions/:id/kill` `{confirm:true}`, then DELETEs `/api/terminals/:terminalId`, toasts the PID, and deselects.
- **MUTE/UNMUTE** toggles `session.muted` (`toggleMute` + `muteSession`/`unmuteSession` in alarmEngine).
- **ALERT** toggles `session.alerted` (`toggleAlert` + `alertSession`/`unalertSession`) — loud sounds for approval & completion. (Distinct from the dormant `AlertModal`.)
- **Room `<Select>`** moves the session: removes it from any room that currently contains it, then adds it to the chosen room (`''` = No room).

### Modals
- `KillConfirmModal` is lazy-mounted via the `LazyModal` wrapper (only mounts when `activeModal === KILL_MODAL_ID`) to avoid extra Zustand subscriptions during DetailPanel mount.
- `AlertModal` (timer alert → `db.alerts`) is not currently mounted anywhere; it is documented here as a dormant component.

### Persistence
- Selection: `localStorage['selected-session']`, restored on refresh.
- Visited projects: a Map of every visited sessionId keeps each `ProjectTabContainer` mounted; on session re-key (e.g. after `/clear`, via `replacesId`) the per-session `agent-manager:project-tabs:session:{id}` and `agent-manager:file-tabs:{id}:{tabId}` localStorage keys are migrated from the old id to the new one.
- Close: Escape closes search first, else restores a minimized panel; it does **not** deselect (deselect would apply `display:none` and reset scroll to 0). Escape is ignored when an xterm has focus. The SessionSwitcher "‒" button calls `minimizeDetailPanel` (sets `detailPanelMinimized`), the panel's only non-destructive close gesture; full deselect (`selectedSessionId → null`) happens only on kill (`KillConfirmModal`).
- **Dashboard Header auto-hide**: while the panel is in view, `AppLayout` hides the global `<Header>` (`hideHeader = !!selectedSessionId && !detailPanelMinimized`) so the panel reclaims that height; `<NavBar>` stays pinned. Minimizing to a badge or deselecting restores the header. See [Views & Routing](./views-routing.md) "Header auto-hide".

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads `selectedSessionId`, session data, `toggleMute`/`toggleAlert`/`togglePin`/`setSessionTitle`; uiStore `cardDisplayMode`, room filter, `detailPanelMinimized`; roomStore membership
- [Terminal UI](./terminal-ui.md) — `TerminalContainer` in TERMINAL/COMMANDS tabs and inside split/stacked views
- [File Browser](./file-browser.md) — `ProjectTabContainer` in PROJECT tab; `ContentSearchModal`
- [Conversation View](./conversation-view.md) — CONVERSATION tab content
- [Prompt Queue](./prompt-queue.md) — `QueueTab` (QUEUE tab + inline under terminal)
- [Client Persistence](./client-persistence.md) — notes (NotesTab) and `db.alerts` (AlertModal) via Dexie
- [Server API](../server/api-endpoints.md) — resume, kill, fork, clone, reconnect-terminal, reconnect-ops-terminal, transcript
- [Keyboard Shortcuts](./keyboard-shortcuts.md) — `detailTabs:switchTab` and `detail-panel:find` CustomEvents
- [Floating Terminal Fork](./floating-terminal-fork.md) — `originSessionId` threading for select-to-translate / translate-previous-answer
- [UI Primitives](./ui-primitives.md) — `ResizablePanel`, `Select`, `Tooltip`, `ToastContainer`

### Depended On By
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — robot click opens the panel via `selectSession`
- [Views & Routing](./views-routing.md) — AppLayout renders DetailPanel
- [Keyboard Shortcuts](./keyboard-shortcuts.md) — Escape closes search / restores minimized panel

### Shared Resources
- `sessionStore.selectedSessionId`; localStorage panel-state keys above.
- Per-session FloatingProjectPanel localStorage keys: `float-project:{sessionId}` (mode), `float-project-pos:{sessionId}` (position), `float-project-size:{sessionId}` (size), `float-project-collapsed:{sessionId}` (collapsed pill state), `float-project-maximized:{sessionId}` (maximized state), `float-project-restore:{sessionId}` (pre-maximize geometry).

## Change Risks
- Defining `TerminalContent`/`OpsTerminalContent` inside `DetailPanel` (instead of module scope) remounts the terminal on every render — keep them outside.
- Adding heavy components without lazy mounting (or without the always-mounted-host pattern for terminal/project) degrades performance.
- Changing tab ids/order requires migrating `localStorage['active-tab']` and updating the keyboard-shortcut tab bindings.
- The three layout modes must stay mutually exclusive — new modes must clear the others via `turnOff`, or duplicate xterm/project subscriptions appear.
- SessionSwitcher's heavy memos depend on `sessionsSignature`, NOT on `sessions`. If you add a card-display field, include it in the signature or the tab strip won't refresh; re-adding `sessions` to the dep array re-enables the every-update recompute this optimization avoids.
- `AlertModal` is dormant — before relying on it, wire an opener (`openModal(ALERT_MODAL_ID)`) and a render site, or remove it.
