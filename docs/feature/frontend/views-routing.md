# Views & Routing

## Function

Defines the app's entry point, the React Router route tree, the persistent layout chrome (title bar, header, nav bar, toasts, global modals), and the top-level view that each route renders. This is the "shell" the rest of the frontend mounts inside.

## Purpose

Give the dashboard a single, predictable mount path: bootstrap persisted state, decide between the setup wizard / a popout window (terminal, project, or whole session) / full dashboard, render a code-split route tree, and keep app-wide UI (settings, search, detail panel, floating terminals) mounted regardless of which route is active. Heavy views (3D scene, History, Queue, Agenda, Review, Project Browser) are lazy-loaded so the LIVE view paints fast.

## Source Files

| File | Role |
|------|------|
| `src/main.tsx` | App entry. Calls `installClientIdentityHeaders()` first — before any module can fetch — then hydrates persisted queue stores from IndexedDB, then renders `<App>` (or a **lazily imported** `PopoutTerminalView` when `?popout=terminal`, `PopoutProjectView` when `?popout=project`, or `PopoutSessionView` when `?popout=session` — the session branch hydrates the queue stores itself before rendering, same as the dashboard path, since its `DetailPanel` needs the QUEUE tab populated). Blocks Cmd/Ctrl+R / F5 reloads. Imports all theme CSS. |
| `src/App.tsx` | Setup gate, `QueryClientProvider`, `BrowserRouter`, the `<Routes>` tree, `AppLayout` (shared chrome via `<Outlet>`), `Dashboard` (mounts WebSocket + workspace hooks + scheduler), Electron before-close save flow. |
| `src/components/layout/TitleBar.tsx` | Fixed 28px draggable macOS-style title bar (z-index 99999) with Save & Quit button (Electron only). |
| `src/components/layout/Header.tsx` | App title plus the single icon-only control cluster (`.stats`): `?` shortcuts, `DevicePresenceChip`, workspace export/import menus, settings, exit. The first two moved here from NavBar; order puts them FIRST so settings/quit keep their far-right corner. |
| `src/components/layout/NavBar.tsx` | Primary nav links (LIVE / AGENDA / HISTORY / PROMPTS / QUEUE / REVIEW), "+ NEW" session button, recent-dir launcher, agenda incomplete-task badge. The `?` shortcuts button and `DevicePresenceChip` **moved to `Header`** — see below. |
| `src/styles/modules/Header.module.css` | Header styling, incl. `.workspaceMenu` dropdown. `.hookStatsPanel`/`.hookStatsReset`/`.hookStatsTable` have no TSX referencing them (confirmed still true as of this pass) — likely dead, kept in sync anyway since removing it is out of scope here |
| `src/components/modals/GlobalSearchModal.tsx` | Cmd/Ctrl+Shift+F search across all in-memory sessions' prompts, responses, tool calls, and events. |
| `src/routes/LiveView.tsx` | Default `/` route. 3D Cyberdrome scene (lazy) wrapped in an error boundary, or a flat sidebar view when 3D is disabled. |
| `src/routes/HistoryView.tsx` | `/history` route. SQLite-backed session search with filters, pagination, and a per-session detail overlay (conversation + activity tabs). |
| `src/routes/PromptsView.tsx` | `/prompts` route. Global prompt trace over the SQLite `prompts` table — day-grouped, source-faceted, searchable. Detailed behavior in [prompt-trace.md](./prompt-trace.md). |
| `src/routes/QueueView.tsx` | `/queue` route. Global prompt-queue table grouped by session (add / remove / move-between-sessions). |
| `src/routes/AgendaView.tsx` | `/agenda` route. Personal task list. Detailed behavior in [agenda.md](./agenda.md). |
| `src/routes/ProjectBrowserView.tsx` | Standalone `/project-browser?path=…` route (no chrome). Detailed behavior in [project-browser.md](./project-browser.md). |
| `src/lib/sessionSort.ts` | `sortSessions()` / `sortSessionsByActivity()` / `STATUS_ORDER` — shared session list ordering. |
| `src/types/analytics.ts` | `DistinctProject` type for the `GET /api/db/projects` filter dropdown. |

## Implementation

### Entry & bootstrap (`main.tsx`)

`main.tsx` first inspects the URL query string. If `?popout=terminal`, the window is a popped-out terminal (a fork float, or the main/commands terminal): it renders only `<PopoutTerminalView>` (inside a `BrowserRouter`), passing `terminalId`, `originSessionId`, and `label` query params — not the whole dashboard. If `?popout=project`, it renders only `<PopoutProjectView>` (which wraps the standalone `ProjectBrowserView`, reading `?path=`/`?file=`) — the content-only window opened by the PROJECT tab's **float** button. If `?popout=session`, it renders only `<PopoutSessionView>` (which wraps `DetailPanel` itself — every tab, not a purpose-built view) after hydrating the queue stores, reading `?sessionId=` — the whole-session window opened by `SessionSwitcher`'s title-row detach icon; see [Session Detail Panel](./session-detail-panel.md) "Pop-out to a native window". Any other URL bootstraps the full `<App>`.

All three popout views are `lazy()`-imported **inside their own branch** and wrapped in `<Suspense fallback={null}>`. The four targets (dashboard, terminal, project, session) are mutually exclusive per window, so a static import made the dashboard load them too — and `PopoutProjectView` reaches `ProjectTab` (as does `PopoutSessionView`, transitively, through `DetailPanel`'s PROJECT tab), which pulls in `xlsx`, `react-arborist`, `highlight.js`, `DOMPurify` and the react-markdown stack. That single static import was the largest contributor to a 2.5 MB eager entry chunk. `PopoutSessionView` compiles to its own chunk (verified: 0 static chunk imports in the entry after adding it) precisely because `DetailPanel` — already a static, eager import in `App.tsx` for the dashboard itself — is reached here only through the lazy boundary.

Otherwise it runs `bootstrap()`, which **awaits** `useQueueStore.loadFromDb()`, `useQueueHistoryStore.loadFromDb()` and `usePromptSnippetStore.loadFromDb()` (IndexedDB hydration, one `Promise.all`) **before** rendering `<App>`. This ordering is load-bearing: `<App>` mounts the WebSocket, and an incoming `session_update` carrying `replacesId` (a `claude --resume` re-key) calls `queueStore.migrateSession()` synchronously. If the queue map were not hydrated first, `migrateSession` would see an empty queue and orphan the loop under the old session id. `loadFromDb()` swallows its own errors, so a hydration failure still falls through to render. Only the queue store has the re-key ordering requirement; the history and [snippet](./saved-prompts.md) stores are global (not keyed by `sessionId`) and ride along in the same `await` so every Dexie read happens once, before first paint.

A global `keydown` listener blocks Cmd+R / Ctrl+R / F5 to prevent accidental page reloads (which would lose all terminal sessions and in-memory state). All nine theme CSS files plus `light-overrides.css` are imported here so themes can be switched at runtime.

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
| `/prompts` | `PromptsView` | yes | `AppLayout` |
| `/queue` | `QueueView` | yes | `AppLayout` |
| `/review` | `ReviewView` | yes | `AppLayout` |
| `*` | `<Navigate to="/" replace>` | — | `AppLayout` |

`AppLayout` is the shared chrome rendered for every route except `/project-browser`. It mounts `useKeyboardShortcuts()` and lays out: `<Header>`, `<NavBar>`, a `<main>` with `<Suspense>` + `<Outlet>` (lazy route fallback = "Loading…") plus `<DetailPanel>` (rendered inside `<main>`, so it overlays the route content), then the always-mounted app-wide UI siblings: `<ToastContainer>`, `<SettingsPanel>`, `<NewSessionModal>`, `<ShortcutsPanel>`, `<ShortcutSettingsModal>`, `<GlobalSearchModal>`, `<FloatingTerminalRoot>`, `<FileOpenChooser>`. Because these live in the layout, they persist across route changes. `AppLayout` also subscribes to Electron's `onReturnToList` and calls `sessionStore.deselectSession()` on receipt — the counterpart to the `?popout=session` window's "back to main" button (see [Session detail panel → Pop-out to a native window](./session-detail-panel.md#pop-out-to-a-native-window)); undefined in browser mode, like every other `electronAPI` call here.

**Top-bars auto-hide when a session detail is open.** `AppLayout` subscribes to `sessionStore.selectedSessionId` and `uiStore.detailPanelMinimized` and computes `hideTopBars = !!selectedSessionId && !detailPanelMinimized`. While a detail panel is in view, **both** `<Header>` and `<NavBar>` are hidden (replaced by a spacer) so the panel + scene reclaim the full vertical height. Both bars return the instant the panel closes (`selectedSessionId → null`, e.g. after a kill) or is minimized to a corner badge (`detailPanelMinimized → true`) — the panel carries its own close/minimize controls, so hiding the NavBar's route tabs doesn't trap the user. The spacer (`AppLayout.module.css` `.titleBarSpacer`) is `display:none` everywhere except macOS Electron, where it takes over the `Header`'s job of clearing the fixed 28px `TitleBar` (28px draggable region) — without it, `<main>` would slide under the titlebar. Reading these stores in `AppLayout` is safe because `AppLayout` is the DOM layer, not inside the R3F `<Canvas>`.

### Layout chrome

**TitleBar** — fixed 28px draggable bar at the very top on macOS Electron, z-index 99999 so it sits above all overlays; native traffic-light buttons render above even this. Shows the app name and (Electron only) a Save & Quit power button calling `electronAPI.quitApp()`.

**Header** — app title plus a `stats` cluster: `WorkspaceButtons` (Export menu → "Save as JSON file" / "Save to AASC config"; Import menu → "Load from JSON file" / "Load from AASC config", driven by `buildSnapshot` / `downloadSnapshot` / `saveToConfig` / `loadFromConfig` / `loadFromFile` / `importSnapshot` from `lib/workspaceSnapshot`), `SettingsButton`, and (Electron only) an `ExitButton`. Import/export feedback goes through `showToast`. Hidden by `AppLayout` while a session detail panel is in view (see "Top-bars auto-hide" above).

**Platform-divergent UI** follows one rule, in [`src/lib/platform.ts`](../../../src/lib/platform.ts): *capability* differences (needs the desktop app) use `useIsDesktopApp()` + unmount; *purely visual* size differences use a CSS media query; size differences where the element **should not exist** use `useIsMobile()` + unmount. `window.electronAPI` is a CAPABILITY check and must never stand in for a size check — a desktop browser at 1920px has no `electronAPI`. Desktop-only nav entries are data (`NAV_ITEMS[].desktopOnly`), not inline conditionals; today that is **AGENDA**, and `Header` additionally unmounts the workspace export/import buttons on mobile (Settings deliberately stays — it is the only route to theme/TTS/translation prefs, which do apply on a phone). Hiding a tab does **not** disable its route: `/agenda` still resolves when deep-linked or restored from a snapshot.

**NavBar** — renders `NAV_ITEMS` (`/` LIVE, `/agenda` AGENDA, `/history` HISTORY, `/prompts` PROMPTS, `/queue` QUEUE, `/review` REVIEW) as `NavLink`s (the `/` link uses `end` for exact match). The AGENDA link shows a count badge of incomplete tasks (`tasks` where `!completed`). A "+ NEW" button opens the `new-session` modal via `uiStore.openModal` and `<WorkdirLauncher>` offers recent directories. **The `?` shortcuts button and `DevicePresenceChip` now live in `Header`'s `.stats` cluster, not here** — both are icon-only controls, and keeping them in this bar left a wide dead band (a flex `.spacer` pushed the chip to the far right) that shoved the route tabs off-screen at phone widths. Moving them let the tabs start immediately after DIRS; `.spacer` and `.shortcutsBtn` were retired from `NavBar.module.css` with them. The NavBar is itself hidden while a detail panel is in view (see "Top-bars auto-hide"), so its tabs are only reachable with no session selected or while the panel is minimized to a badge. Each `NavLink`'s `onClick` still calls `sessionStore.deselectSession()` — in the minimized state a session is selected *and* the NavBar is visible, so clicking a tab closes the panel (which `DetailPanel` overlays *every* route with when `selectedSessionId` is set) and restores the top bars on the chosen view.

### GlobalSearchModal

Opened when `uiStore.activeModal === 'global-search'` (bound to Cmd/Ctrl+Shift+F via the keyboard shortcuts). `runSearch(sessions, query)` is a pure, in-memory scan over each session's `promptHistory`, `responseLog`, `toolLog`, and `events`, producing `SearchHit`s tagged with `field` (`prompt` | `response` | `tool` | `event`). Results are sorted by a `STATUS_ORDER` map (working 0 → ended 6, with `approval`/`input` both 2) then by recency, and capped at **100** hits. `highlightSnippet` truncates around the match (max 200 chars, ~60 chars of left context), HTML-escapes, and wraps matches in `<mark>`. Keyboard nav: Up/Down move selection, Enter selects, Esc closes. Selecting a hit calls `selectSession(hit.sessionId)`, closes the modal, then (after 150ms) dispatches a payload-less `detail-panel:find` `CustomEvent`, which makes the now-open `DetailPanel` open and focus its in-panel find bar (`openSearch()`). The query is not carried across — the find bar opens empty.

### Views

- **LiveView** (`/`, eager) — when `settingsStore.scene3dEnabled`, lazy-loads `CyberdromeScene` inside a `SceneErrorBoundary` (catches WebGL/3D crashes and offers RETRY) with an "INITIALIZING CYBERDROME…" suspense fallback. When 3D is disabled it renders `FlatView` (a "3D Scene Paused" placeholder + `SceneOverlay` + `RobotListSidebar`) to save CPU/GPU. `FlatView`'s inline styles now live in `LiveView.module.css`; below 640px the placeholder is hidden so the full-bleed session list *is* the page — but **only via the `scenePausedHasSidebar` modifier, which `LiveView` adds solely when `sessions.size > 0`**. `RobotListSidebar` returns `null` at zero sessions, so a blanket mobile hide left a session-less phone visit staring at a genuinely blank page; the true-empty case keeps the placeholder as its only content. **`scene3dEnabled` defaults to `false`** — the scene is opt-in via the `3D Off`/`3D On` button in `SceneOverlay`, so a fresh install never pays the Three.js chunk download or the render loop until the user asks for it. See [cyberdrome-scene.md](../3d/cyberdrome-scene.md) and [robot-system.md](../3d/robot-system.md).
- **HistoryView** (`/history`) — TanStack Query against the SQLite store. Filters: free-text query, project (from `GET /api/db/projects`), status (idle/working/waiting/ended/archived — `archived` maps to `?archived=true`), date range, and sort (`date`→`started_at`, `duration`→`last_activity_at`, plus `prompts`/`tools` which currently both map to `started_at`) with an asc/desc toggle. `PAGE_SIZE = 50`. Each row offers Resume (`POST /api/sessions/:id/resume`) and Delete (`DELETE /api/db/sessions/:id`, confirm-gated). Clicking a row opens a detail overlay with `Conversation` (interleaved prompts + responses) and `Activity` (merged tool calls + events) tabs. See [database.md](../server/database.md) and [api-endpoints.md](../server/api-endpoints.md).
- **PromptsView** (`/prompts`) — every prompt ever recorded, read from SQLite via `GET /api/db/prompts` (`PAGE_SIZE = 50`). Source facets `MINE`/`/CMD`/`AGENT`/`ALL` default to `MINE`, which excludes the ~10% of rows the harness injected through the same `UserPromptSubmit` hook. Full detail in [prompt-trace.md](./prompt-trace.md).
- **QueueView** (`/queue`) — table view of `queueStore.queues` grouped by session id (only sessions with ≥1 item). A compose row (session `Select` + textarea, Cmd/Ctrl+Enter to add) appends items; rows support DEL (`remove`) and MOVE (`moveToSession`, via an inline session picker). This is the global manual queue surface; automation/scheduling lives in [queue-scheduler.md](./queue-scheduler.md) and the underlying model in [prompt-queue.md](./prompt-queue.md).
- **AgendaView** (`/agenda`) — personal task management; full detail in [agenda.md](./agenda.md).
- **ReviewView** (`/review`) — git diff review surface; full detail in [review-tab.md](./review-tab.md).
- **ProjectBrowserView** (`/project-browser?path=…`, standalone) — full-page file browser; resolves an `originSessionId` for the translate/explain popup; full detail in [project-browser.md](./project-browser.md).

### Shared session ordering (`sessionSort.ts`)

`STATUS_ORDER` maps statuses to a sort weight (`working` 0, `prompting` 1, `approval`/`input` 2, `waiting` 3, `idle` 4, `connecting` 5, `ended` 6). `sortSessions()` floats pinned sessions to the top of their group, then orders by status weight, then by [`sessionDisplayTitle()`](../../../src/lib/sessionDisplayTitle.ts) (`title || projectName || 'Unnamed'`) via `localeCompare`. Used by RobotListSidebar and unit-tested in isolation. The GlobalSearchModal embeds the same status weighting inline.

`sortSessionsByActivity()` orders pinned-first then most-recently-active first, deliberately ignoring status; sessions with no `lastActivityAt` sink to the bottom, and ties fall through to `sessionDisplayTitle()` then `sessionId` so the order stays total (untitled sessions would otherwise compare equal and let the stable sort inherit the caller's input order — i.e. the status sort this ordering exists to ignore). Used by SessionSwitcher when `uiStore.sessionSortMode === 'activity'`.

### Bundle splitting

Eagerly-parsed JS at boot is **1,268,373 bytes** (`dist/client/assets/index-*.js`), down from 2,523,500 — measured by walking the entry chunk's static import graph in `dist/client/`. The entry chunk has **zero** static chunk imports; everything else is reached through a `lazy()` boundary. (`PromptsView` adds 8.6 kB JS + 6.1 kB CSS as its own lazy chunk.) The number moves with every eagerly-reachable addition — e.g. the SelectionPopup Model/Effort quick-settings row and the `FileTypeIcon`/`DetachIcon`/`markdownHeadings` extractions all landed on this path via `ProjectTab.tsx`/`DetailPanel.tsx` — so treat it as a snapshot to re-measure after touching an eager root, not a number to keep hand-syncing piecemeal.

`vite.config.ts` deliberately sets **no `manualChunks`**. Grouping vendors by name (`{ three: ['three', '@react-three/fiber'] }`) only renames bytes, and it backfires: Rollup assigns a package's shared dependencies to the same manual chunk, so `@react-three/fiber`'s copy of `zustand` landed in the `three` chunk and every eagerly-loaded store then statically imported it — dragging ~1.2 MB of Three.js into the boot path.

What actually splits the bundle:
1. `lazy()` boundaries — routes in `App.tsx`, popout views in `main.tsx`, PROJECT tab and AI POPUPS in `DetailPanel`.
2. Keeping Three-free data out of Three-importing modules — [`robotPalette.ts`](../../../src/lib/robotPalette.ts), [`robotModelMeta.ts`](../../../src/lib/robotModelMeta.ts), [`roomGrid.ts`](../../../src/lib/roomGrid.ts).

To verify after a change, list the entry chunk's static imports:
```bash
npm run build
node -e "const h=require('fs').readFileSync('dist/client/index.html','utf8');const f='dist/client/assets/'+/src=\"\/assets\/(index-[^\"]+\.js)\"/.exec(h)[1];const s=require('fs').readFileSync(f,'utf8');console.log([...new Set([...s.matchAll(/from\"(\.\/[^\"]+)\"/g)].map(m=>m[1]))])"
```
An empty array is the expected result. **The recipe reads the entry filename out of `dist/client/index.html`'s `<script src>`, not by globbing `dist/client/assets` for `index-*.js`** — Rollup can (and does) name a lazy chunk `index-<hash>.js` too when a route file happens to be called `index.tsx`/`index.ts`; `readdirSync`'s alphabetical order then has no guarantee of returning the real entry first. `index.html` only ever references the actual entry, so it's the one reliable source.

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
- [agenda.md](./agenda.md), [review-tab.md](./review-tab.md), [project-browser.md](./project-browser.md), [prompt-queue.md](./prompt-queue.md), [prompt-trace.md](./prompt-trace.md) — the views that own their own behavior docs.
- [api-endpoints.md](../server/api-endpoints.md), [database.md](../server/database.md) — HistoryView queries.
- [app-lifecycle.md](../electron/app-lifecycle.md) — `isSetup`, `quitApp`, `onBeforeClose`, theme.

**Depended on by:**
- [keyboard-shortcuts.md](./keyboard-shortcuts.md) — shortcuts navigate routes and open the global modals mounted here.
- [session-detail-panel.md](./session-detail-panel.md) — relies on `DetailPanel` being mounted app-wide in `AppLayout`.

## Change Risks

- **Route element / lazy-import names** drift from `App.tsx` — keep the route table in sync with the actual `lazy()` imports and the standalone `/project-browser` exception.
- **NAV_ITEMS** must match the `<Route path>` set; adding a nav link without a route (or vice-versa) produces dead links or unreachable views.
- **A static import of a heavy component from `main.tsx`, `App.tsx` or `AppLayout` silently re-inflates the eager bundle** — those are the eager roots. Re-run the entry-chunk check above after adding an import there; no linter catches this.
- **Bootstrap ordering** in `main.tsx` (`installClientIdentityHeaders()` → await queue hydration → render → WS connect) is required: identity headers must be on every `fetch` before any module can issue one — the server treats an unstamped request as an anonymous device — and `migrateSession` correctness on `claude --resume` re-keys still requires queue hydration before rendering. Do not move rendering before `loadFromDb()`, and do not move the identity-header install after it.
- **App-wide modals/panels live in `AppLayout`**, so they unmount on the standalone `/project-browser` route — anything that must be globally available there needs separate mounting.
- **GlobalSearchModal** reads only in-memory session arrays (`promptHistory`/`responseLog`/`toolLog`/`events`); it does not hit the DB, so ended/evicted sessions won't appear. The 100-hit / 200-char caps are intentional performance limits.
- `Header.module.css`'s `.hookStatsToggle`/`.hookStatsPanel`/`.hookStatsReset`/`.hookStatsTable th`/`.workspaceMenu`/`.workspaceMenuTitle` all referenced `var(--border-dim)` — undefined in every theme file, so these dropdowns' borders were always the same hardcoded fallback regardless of theme. Fixed to `var(--border-subtle)`, the real token used for quiet dividers everywhere else in the codebase.
- **HistoryView sort map** has `prompts`/`tools` aliased to `started_at` (no dedicated DB sort columns yet); changing labels without backend support silently no-ops.
- **`useGlobalQueueScheduler` must remain mounted exactly once** (in `Dashboard`) — mounting it elsewhere would double-fire queued prompts.
