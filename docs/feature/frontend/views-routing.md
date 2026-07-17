# Views & Routing

## Function

Defines the app's entry point, the React Router route tree, the persistent layout chrome (title bar, header, nav bar, toasts, global modals), and the top-level view that each route renders. This is the "shell" the rest of the frontend mounts inside.

## Purpose

Give the dashboard a single, predictable mount path: bootstrap persisted state, decide between the setup wizard / popout-terminal window / full dashboard, render a code-split route tree, and keep app-wide UI (settings, search, detail panel, floating terminals) mounted regardless of which route is active. Heavy views (3D scene, History, Queue, Agenda, Review, Project Browser) are lazy-loaded so the LIVE view paints fast.

## Source Files

| File | Role |
|------|------|
| `src/main.tsx` | App entry. Hydrates persisted queue stores from IndexedDB, then renders `<App>` (or `PopoutTerminalView` when `?popout=terminal`, or `PopoutProjectView` when `?popout=project`). Blocks Cmd/Ctrl+R / F5 reloads. Imports all theme CSS. |
| `src/App.tsx` | Setup gate, `QueryClientProvider`, `BrowserRouter`, the `<Routes>` tree, `AppLayout` (shared chrome via `<Outlet>`), `Dashboard` (mounts WebSocket + workspace hooks + scheduler), Electron before-close save flow. |
| `src/components/layout/TitleBar.tsx` | Fixed 28px draggable macOS-style title bar (z-index 99999) with Save & Quit button (Electron only). |
| `src/components/layout/Header.tsx` | App title, workspace export/import menus, settings button, exit button. |
| `src/components/layout/NavBar.tsx` | Primary nav links (LIVE / AGENDA / HISTORY / QUEUE / REVIEW), "+ NEW" session button, recent-dir launcher, shortcuts help button, agenda incomplete-task badge. |
| `src/components/modals/GlobalSearchModal.tsx` | Cmd/Ctrl+Shift+F search across all in-memory sessions' prompts, responses, tool calls, and events. |
| `src/routes/LiveView.tsx` | Default `/` route. 3D Cyberdrome scene (lazy) wrapped in an error boundary, or a flat sidebar view when 3D is disabled. |
| `src/routes/HistoryView.tsx` | `/history` route. SQLite-backed session search with filters, pagination, and a per-session detail overlay (conversation + activity tabs). |
| `src/routes/QueueView.tsx` | `/queue` route. Global prompt-queue table grouped by session (add / remove / move-between-sessions). |
| `src/routes/AgendaView.tsx` | `/agenda` route. Personal task list. Detailed behavior in [agenda.md](./agenda.md). |
| `src/routes/ProjectBrowserView.tsx` | Standalone `/project-browser?path=…` route (no chrome). Detailed behavior in [project-browser.md](./project-browser.md). |
| `src/lib/sessionSort.ts` | `sortSessions()` / `sortSessionsByActivity()` / `STATUS_ORDER` — shared session list ordering. |
| `src/types/analytics.ts` | `DistinctProject` type for the `GET /api/db/projects` filter dropdown. |

## Implementation

### Entry & bootstrap (`main.tsx`)

`main.tsx` first inspects the URL query string. If `?popout=terminal`, the window is a popped-out terminal (a fork float, or the main/commands terminal): it renders only `<PopoutTerminalView>` (inside a `BrowserRouter`), passing `terminalId`, `originSessionId`, and `label` query params — not the whole dashboard. If `?popout=project`, it renders only `<PopoutProjectView>` (which wraps the standalone `ProjectBrowserView`, reading `?path=`/`?file=`) — the content-only window opened by the PROJECT tab's **float** button. Any other URL bootstraps the full `<App>`.

Otherwise it runs `bootstrap()`, which **awaits** `useQueueStore.loadFromDb()` and `useQueueHistoryStore.loadFromDb()` (IndexedDB hydration) **before** rendering `<App>`. This ordering is load-bearing: `<App>` mounts the WebSocket, and an incoming `session_update` carrying `replacesId` (a `claude --resume` re-key) calls `queueStore.migrateSession()` synchronously. If the queue map were not hydrated first, `migrateSession` would see an empty queue and orphan the loop under the old session id. `loadFromDb()` swallows its own errors, so a hydration failure still falls through to render.

A global `keydown` listener blocks Cmd+R / Ctrl+R / F5 to prevent accidental page reloads (which would lose all terminal sessions and in-memory state). All eight theme CSS files plus `light-overrides.css` are imported here so themes can be switched at runtime.

### App shell & routing (`App.tsx`)

`App` resolves a setup gate: in web mode (no `window.electronAPI`) it skips setup; in Electron it calls `electronAPI.isSetup()`. While `isSetup === null` it shows a loading screen; `false` renders `<SetupWizard>`; `true` renders the dashboard inside `QueryClientProvider`. `<TitleBar>` is rendered in all three states. The shared `QueryClient` uses `staleTime: 30_000` and `retry: 1`.

`AuthGate` wires the real auth flow via `useAuth()`: it probes `/api/auth/status`, renders a "Connecting…" screen while `loading`, renders `<LoginScreen onLogin={login} />` when `needsLogin`, and otherwise renders `<Dashboard token={token} />`. It also listens for the `ws-auth-failed` event `wsClient` dispatches on close code 4001, flipping `needsLogin` so a fresh login can re-establish the session. When no password is configured (the default), `needsLogin` stays false and the Dashboard mounts with a null token (see [authentication.md](../server/authentication.md) / [auth-ui.md](./auth-ui.md)).

`Dashboard` is where the app's lifecycle hooks mount: `useSettingsInit`, `useWebSocket(token)`, `useWorkspaceAutoSave`, `useWorkspaceAutoLoad`, and `useGlobalQueueScheduler` (the **single** global queue scheduler — see [queue-scheduler.md](./queue-scheduler.md)). It also wires the Electron `onBeforeClose` handler: on quit it shows a `<SavingOverlay>` whose progress bar "creeps" toward 90% (`setInterval` every 120ms) while `flushSave()` persists the workspace snapshot, then snaps to 100%. `<RestorePickerModal>` and `<WorkspaceLoadingOverlay>` (see [workspace-snapshot.md](./workspace-snapshot.md)) are mounted alongside the router.

The route tree:

| Path | Element | Lazy | Chrome |
|------|---------|------|--------|
| `/project-browser` | `ProjectBrowserView` | yes | none (standalone) |
| `/` | `LiveView` | no (eager) | `AppLayout` |
| `/agenda` | `AgendaView` | yes | `AppLayout` |
| `/history` | `HistoryView` | yes | `AppLayout` |
| `/queue` | `QueueView` | yes | `AppLayout` |
| `/review` | `ReviewView` | yes | `AppLayout` |
| `*` | `<Navigate to="/" replace>` | — | `AppLayout` |

`AppLayout` is the shared chrome rendered for every route except `/project-browser`. It mounts `useKeyboardShortcuts()` and lays out: `<Header>`, `<NavBar>`, a `<main>` with `<Suspense>` + `<Outlet>` (lazy route fallback = "Loading…") plus `<DetailPanel>` (rendered inside `<main>`, so it overlays the route content), then the always-mounted app-wide UI siblings: `<ToastContainer>`, `<SettingsPanel>`, `<NewSessionModal>`, `<ShortcutsPanel>`, `<ShortcutSettingsModal>`, `<GlobalSearchModal>`, `<FloatingTerminalRoot>`, `<FileOpenChooser>`. Because these live in the layout, they persist across route changes.

**Top-bars auto-hide when a session detail is open.** `AppLayout` subscribes to `sessionStore.selectedSessionId` and `uiStore.detailPanelMinimized` and computes `hideTopBars = !!selectedSessionId && !detailPanelMinimized`. While a detail panel is in view, **both** `<Header>` and `<NavBar>` are hidden (replaced by a spacer) so the panel + scene reclaim the full vertical height. Both bars return the instant the panel closes (`selectedSessionId → null`, e.g. after a kill) or is minimized to a corner badge (`detailPanelMinimized → true`) — the panel carries its own close/minimize controls, so hiding the NavBar's route tabs doesn't trap the user. The spacer (`AppLayout.module.css` `.titleBarSpacer`) is `display:none` everywhere except macOS Electron, where it takes over the `Header`'s job of clearing the fixed 28px `TitleBar` (28px draggable region) — without it, `<main>` would slide under the titlebar. Reading these stores in `AppLayout` is safe because `AppLayout` is the DOM layer, not inside the R3F `<Canvas>`.

### Layout chrome

**TitleBar** — fixed 28px draggable bar at the very top on macOS Electron, z-index 99999 so it sits above all overlays; native traffic-light buttons render above even this. Shows the app name and (Electron only) a Save & Quit power button calling `electronAPI.quitApp()`.

**Header** — app title plus a `stats` cluster: `WorkspaceButtons` (Export menu → "Save as JSON file" / "Save to AASC config"; Import menu → "Load from JSON file" / "Load from AASC config", driven by `buildSnapshot` / `downloadSnapshot` / `saveToConfig` / `loadFromConfig` / `loadFromFile` / `importSnapshot` from `lib/workspaceSnapshot`), `SettingsButton`, and (Electron only) an `ExitButton`. Import/export feedback goes through `showToast`. Hidden by `AppLayout` while a session detail panel is in view (see "Top-bars auto-hide" above).

**NavBar** — renders `NAV_ITEMS` (`/` LIVE, `/agenda` AGENDA, `/history` HISTORY, `/queue` QUEUE, `/review` REVIEW) as `NavLink`s (the `/` link uses `end` for exact match). The AGENDA link shows a count badge of incomplete tasks (`tasks` where `!completed`). A "+ NEW" button opens the `new-session` modal via `uiStore.openModal`, `<WorkdirLauncher>` offers recent directories, and a "?" button opens the `shortcuts` modal. The NavBar is itself hidden while a detail panel is in view (see "Top-bars auto-hide"), so its tabs are only reachable with no session selected or while the panel is minimized to a badge. Each `NavLink`'s `onClick` still calls `sessionStore.deselectSession()` — in the minimized state a session is selected *and* the NavBar is visible, so clicking a tab closes the panel (which `DetailPanel` overlays *every* route with when `selectedSessionId` is set) and restores the top bars on the chosen view.

### GlobalSearchModal

Opened when `uiStore.activeModal === 'global-search'` (bound to Cmd/Ctrl+Shift+F via the keyboard shortcuts). `runSearch(sessions, query)` is a pure, in-memory scan over each session's `promptHistory`, `responseLog`, `toolLog`, and `events`, producing `SearchHit`s tagged with `field` (`prompt` | `response` | `tool` | `event`). Results are sorted by a `STATUS_ORDER` map (working 0 → ended 6, with `approval`/`input` both 2) then by recency, and capped at **100** hits. `highlightSnippet` truncates around the match (max 200 chars, ~60 chars of left context), HTML-escapes, and wraps matches in `<mark>`. Keyboard nav: Up/Down move selection, Enter selects, Esc closes. Selecting a hit calls `selectSession(hit.sessionId)`, closes the modal, then (after 150ms) dispatches a payload-less `detail-panel:find` `CustomEvent`, which makes the now-open `DetailPanel` open and focus its in-panel find bar (`openSearch()`). The query is not carried across — the find bar opens empty.

### Views

- **LiveView** (`/`, eager) — when `settingsStore.scene3dEnabled`, lazy-loads `CyberdromeScene` inside a `SceneErrorBoundary` (catches WebGL/3D crashes and offers RETRY) with an "INITIALIZING CYBERDROME…" suspense fallback. When 3D is disabled it renders `FlatView` (a "3D Scene Paused" placeholder + `SceneOverlay` + `RobotListSidebar`) to save CPU/GPU. See [cyberdrome-scene.md](../3d/cyberdrome-scene.md) and [robot-system.md](../3d/robot-system.md).
- **HistoryView** (`/history`) — TanStack Query against the SQLite store. Filters: free-text query, project (from `GET /api/db/projects`), status (idle/working/waiting/ended/archived — `archived` maps to `?archived=true`), date range, and sort (`date`→`started_at`, `duration`→`last_activity_at`, plus `prompts`/`tools` which currently both map to `started_at`) with an asc/desc toggle. `PAGE_SIZE = 50`. Each row offers Resume (`POST /api/sessions/:id/resume`) and Delete (`DELETE /api/db/sessions/:id`, confirm-gated). Clicking a row opens a detail overlay with `Conversation` (interleaved prompts + responses) and `Activity` (merged tool calls + events) tabs. See [database.md](../server/database.md) and [api-endpoints.md](../server/api-endpoints.md).
- **QueueView** (`/queue`) — table view of `queueStore.queues` grouped by session id (only sessions with ≥1 item). A compose row (session `Select` + textarea, Cmd/Ctrl+Enter to add) appends items; rows support DEL (`remove`) and MOVE (`moveToSession`, via an inline session picker). This is the global manual queue surface; automation/scheduling lives in [queue-scheduler.md](./queue-scheduler.md) and the underlying model in [prompt-queue.md](./prompt-queue.md).
- **AgendaView** (`/agenda`) — personal task management; full detail in [agenda.md](./agenda.md).
- **ReviewView** (`/review`) — git diff review surface; full detail in [review-tab.md](./review-tab.md).
- **ProjectBrowserView** (`/project-browser?path=…`, standalone) — full-page file browser; resolves an `originSessionId` for the translate/explain popup; full detail in [project-browser.md](./project-browser.md).

### Shared session ordering (`sessionSort.ts`)

`STATUS_ORDER` maps statuses to a sort weight (`working` 0, `prompting` 1, `approval`/`input` 2, `waiting` 3, `idle` 4, `connecting` 5, `ended` 6). `sortSessions()` floats pinned sessions to the top of their group, then orders by status weight, then by title (`localeCompare`, falling back to "Unnamed"). Used by RobotListSidebar and unit-tested in isolation. The GlobalSearchModal embeds the same status weighting inline.

`sortSessionsByActivity()` orders pinned-first then most-recently-active first, deliberately ignoring status; sessions with no `lastActivityAt` sink to the bottom, and ties fall through to title then `sessionId` so the order stays total (untitled sessions would otherwise compare equal and let the stable sort inherit the caller's input order — i.e. the status sort this ordering exists to ignore). Used by SessionSwitcher when `uiStore.sessionSortMode === 'activity'`.

## Dependencies & Connections

**Depends on:**
- [state-management.md](./state-management.md) — `sessionStore`, `uiStore`, `settingsStore`, `roomStore`, `queueStore`, `queueHistoryStore`, `agendaStore`.
- [client-persistence.md](./client-persistence.md) — IndexedDB hydration of queue stores at bootstrap.
- [websocket-client.md](./websocket-client.md) — `useWebSocket` mounted in `Dashboard`.
- [workspace-snapshot.md](./workspace-snapshot.md) — auto-save/auto-load hooks, before-close flush, Header import/export, RestorePickerModal.
- [queue-scheduler.md](./queue-scheduler.md) — `useGlobalQueueScheduler` mounted once in `Dashboard`.
- [keyboard-shortcuts.md](./keyboard-shortcuts.md) — `useKeyboardShortcuts` in `AppLayout`; opens NavBar/search modals.
- [settings-system.md](./settings-system.md) — `useSettingsInit`, `SettingsPanel`/`SettingsButton`, `scene3dEnabled`.
- [ui-primitives.md](./ui-primitives.md) — `ToastContainer`/`showToast`, `Select`, `Tabs`, `SearchInput`, `SavingOverlay`, `WorkspaceLoadingOverlay`.
- [session-detail-panel.md](./session-detail-panel.md) — `DetailPanel` and the `detail-panel:find` event consumer.
- [session-creation-modals.md](./session-creation-modals.md) — `NewSessionModal` (and shortcut/restore modals).
- [floating-terminal-fork.md](./floating-terminal-fork.md) — `FloatingTerminalRoot`, popout-terminal window mode.
- [setup-wizard.md](./setup-wizard.md) — setup gate target.
- [cyberdrome-scene.md](../3d/cyberdrome-scene.md) / [robot-system.md](../3d/robot-system.md) — LiveView 3D scene + sidebar.
- [agenda.md](./agenda.md), [review-tab.md](./review-tab.md), [project-browser.md](./project-browser.md), [prompt-queue.md](./prompt-queue.md) — the views that own their own behavior docs.
- [api-endpoints.md](../server/api-endpoints.md), [database.md](../server/database.md) — HistoryView queries.
- [app-lifecycle.md](../electron/app-lifecycle.md) — `isSetup`, `quitApp`, `onBeforeClose`, theme.

**Depended on by:**
- [keyboard-shortcuts.md](./keyboard-shortcuts.md) — shortcuts navigate routes and open the global modals mounted here.
- [session-detail-panel.md](./session-detail-panel.md) — relies on `DetailPanel` being mounted app-wide in `AppLayout`.

## Change Risks

- **Route element / lazy-import names** drift from `App.tsx` — keep the route table in sync with the actual `lazy()` imports and the standalone `/project-browser` exception.
- **NAV_ITEMS** must match the `<Route path>` set; adding a nav link without a route (or vice-versa) produces dead links or unreachable views.
- **Bootstrap ordering** in `main.tsx` (await queue hydration → render → WS connect) is required for `migrateSession` correctness on `claude --resume` re-keys. Do not move rendering before `loadFromDb()`.
- **App-wide modals/panels live in `AppLayout`**, so they unmount on the standalone `/project-browser` route — anything that must be globally available there needs separate mounting.
- **GlobalSearchModal** reads only in-memory session arrays (`promptHistory`/`responseLog`/`toolLog`/`events`); it does not hit the DB, so ended/evicted sessions won't appear. The 100-hit / 200-char caps are intentional performance limits.
- **HistoryView sort map** has `prompts`/`tools` aliased to `started_at` (no dedicated DB sort columns yet); changing labels without backend support silently no-ops.
- **`useGlobalQueueScheduler` must remain mounted exactly once** (in `Dashboard`) — mounting it elsewhere would double-fire queued prompts.
