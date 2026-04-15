# Session Detail Panel

## Function
Slide-in panel showing comprehensive session information with 6 tabs, session controls, session switcher, and split view.

## Purpose
Primary interface for interacting with a single session. Aggregates terminal, project browser, commands, prompts, notes, and queue in one view.

## Source Files
| File | Role |
|------|------|
| `src/components/session/DetailPanel.tsx` | Main panel container, header, control bar, tab system, TerminalContent/OpsTerminalContent wrappers |
| `src/components/session/DetailTabs.tsx` | 6-tab system (PROJECT, TERMINAL, COMMANDS, PROMPTS, NOTES, QUEUE) with always-mounted + on-demand mounting, split view |
| `src/components/session/SessionControlBar.tsx` | Resume/Kill/Mute/Alert buttons + Room select dropdown |
| `src/components/session/SessionSwitcher.tsx` | Horizontal session tab strip with pinned-first sort |
| `src/components/session/PromptHistory.tsx` | Scrollable prompt history with search highlighting |
| `src/components/session/NotesTab.tsx` | Per-session notes CRUD |
| `src/components/session/QueueTab.tsx` | Prompt queue management |
| `src/components/session/LabelChips.tsx` | Session label picker chips |
| `src/components/session/KillConfirmModal.tsx` | Kill confirmation modal (lazy-mounted) |

## Implementation
- Panel: ResizablePanel with fullscreen mode, minimizable to draggable badge (DraggableMiniBadge, position saved to localStorage['mini-badge-pos'])
- Header: collapsible (localStorage['detail-header-collapsed']), 64x80px character preview (CSS circle, not 3D Canvas), project name, editable title (EditableTitle component), status badge, model, LabelChips, SessionControlBar
- Session switcher: SessionSwitcher component with compact header info when collapsed. Mini-robot cards and session tab cards show a **spinning conic-gradient border** when session status is `working` or `prompting` (CSS `@property --spin-angle` animated via `spinBorder` keyframes, 2s linear infinite). Approval/input states use a pulsing border instead.
- 6 tabs: PROJECT, TERMINAL, COMMANDS, PROMPTS (id: conversation), NOTES, QUEUE — TERMINAL/COMMANDS/PROJECT always mounted (preserves xterm + file state), other tabs mounted on demand
- Split view: >=700px panel width shows Terminal+Project side-by-side (DraggableSplitView) with draggable divider, ratio persisted per-session (localStorage['split-ratio:{sessionId}'])
- Tab state persisted in localStorage['active-tab'], split state in localStorage['split-terminal-project:{sessionId}']
- Selection: localStorage['selected-session'], restored on refresh
- Close: Escape (close search first -> restore if minimized; skipped if xterm focused). Escape does NOT deselect the session — deselecting applies display:none which resets scroll positions to 0
- TerminalContent + OpsTerminalContent are memoized components defined OUTSIDE DetailPanel to prevent unmount/remount
- Search bar: between tabs and content, supports session-wide search across prompts with match counter, Previous/Next navigation, auto-switches to conversation tab
- Visited projects: Map of all visited sessionIds keeps ProjectTabContainers mounted, with localStorage migration on session re-key (replacesId)
- KillConfirmModal: lazy-mounted via LazyModal wrapper (only mounts when modal is active)

## Dependencies & Connections

### Depends On
- [State Management](./state-management.md) — reads selectedSessionId, session data from sessionStore
- [Terminal UI](./terminal-ui.md) — TerminalContainer in TERMINAL tab
- [File Browser](./file-browser.md) — ProjectTabContainer in PROJECT tab
- [Prompt Queue](./prompt-queue.md) — QueueTab
- [Client Persistence](./client-persistence.md) — notes, prompts from IndexedDB
- [Server API](../server/api-endpoints.md) — kill, resume, summarize, title/label/color updates

### Depended On By
- [3D Cyberdrome Scene](../3d/cyberdrome-scene.md) — robot click triggers panel open via selectSession
- [Views & Routing](./views-routing.md) — AppLayout renders DetailPanel
- [Keyboard Shortcuts](./keyboard-shortcuts.md) — Escape closes search / restores minimized panel

### Shared Resources
- sessionStore.selectedSessionId, localStorage keys for panel state

## Change Risks
- Defining TerminalContent inside DetailPanel causes terminal remount on every render
- Adding heavy components without lazy mount degrades performance
- Changing tab names/order requires localStorage migration
- Breaking split view persistence loses user preferences
