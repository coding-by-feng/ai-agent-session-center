# Frontend Features — AI Agent Session Center

> React 19 + TypeScript + Three.js + Vite. Source files in `src/`.

---

## 13. Dexie.js Client Persistence (`src/lib/db.ts`)

### Database Identity

| Property | Value |
|----------|-------|
| Database name | `claude-dashboard` |
| Schema version | `2` |
| API | Dexie.js (IndexedDB wrapper) |
| Initialization | Module-level singleton export |

### Tables (12 total)

| Table | Key Path | Auto-Increment | Purpose |
|-------|----------|----------------|---------|
| `sessions` | `id` | No | Session snapshots, one record per session |
| `prompts` | `++id` | Yes | User prompt history entries |
| `responses` | `++id` | Yes | Claude response excerpts |
| `toolCalls` | `++id` | Yes | Tool invocation records |
| `events` | `++id` | Yes | Raw hook event log |
| `notes` | `++id` | Yes | Per-session user notes |
| `promptQueue` | `++id` | Yes | Queued prompts awaiting dispatch |
| `alerts` | `++id` | Yes | Duration alert rules |
| `sshProfiles` | `++id` | Yes | SSH connection profiles |
| `settings` | `key` | No | Key-value settings store |
| `summaryPrompts` | `++id` | Yes | AI summarization prompt templates |
| `teams` | `id` | No | Subagent team definitions |

### Indexes

| Table | Index Key Paths | Notes |
|-------|----------------|-------|
| `sessions` | `status`, `projectPath`, `startedAt`, `lastActivityAt`, `archived` | Five individual indexes |
| `prompts` | `sessionId`, `timestamp`, `[sessionId+timestamp]` | Compound for sorted lookup + dedup |
| `responses` | `sessionId`, `timestamp`, `[sessionId+timestamp]` | — |
| `toolCalls` | `sessionId`, `timestamp`, `toolName`, `[sessionId+timestamp]` | Filter by tool |
| `events` | `sessionId`, `timestamp`, `[sessionId+timestamp]` | — |
| `notes` | `sessionId` | — |
| `promptQueue` | `sessionId`, `[sessionId+position]` | Ordered queue items |
| `alerts` | `sessionId` | — |
| `sshProfiles` | `name` | — |
| `summaryPrompts` | `isDefault` | Find default template |

### DbSession Schema (21 fields)

`id`, `projectPath`, `projectName`, `title`, `status`, `model`, `source`, `startedAt`, `lastActivityAt`, `endedAt`, `totalToolCalls`, `totalPrompts`, `archived`, `summary`, `characterModel`, `accentColor`, `teamId`, `teamRole`, `terminalId`, `queueCount`, `label`

### Session Persistence (`persistSessionUpdate`)

When a WebSocket `session_update` arrives, the following records are upserted/appended via Dexie transactions:

- **sessions** table: full session record
- **prompts**: new entries deduplicated by `[sessionId+timestamp]`
- **toolCalls**: new entries deduplicated by `[sessionId+timestamp]`; maps `tool` → `toolName`, `input` → `toolInputSummary`
- **responses**: new entries deduplicated by `[sessionId+timestamp]`; maps `text` → `textExcerpt`
- **events**: new entries deduplicated by `[sessionId+timestamp]`

### Session ID Migration (`migrateSessionId`)

When `session.replacesId` is set (resume/re-key), `migrateSessionId(oldId, newId)` updates `sessionId` on all child records across prompts, responses, toolCalls, events, notes, promptQueue, and alerts tables. The old session record is then deleted.

### Delete Cascade

`deleteSession(sessionId)` removes the session record and all related records from all child tables in a single transaction.

---

## 14. Zustand State Management (7 Stores)

### sessionStore (`src/stores/sessionStore.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `sessions` | `Map<string, Session>` | All active sessions |
| `selectedSessionId` | `string \| null` | Currently selected session |

**Actions:** `addSession`, `removeSession`, `updateSession` (handles `replacesId` migration), `selectSession`, `deselectSession`, `setSessions` (bulk replace).

**Deduplication:** When updating, if two sessions arrive with the same ID, the one with the most recent `lastActivityAt` wins.

### wsStore (`src/stores/wsStore.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `connected` | `boolean` | WebSocket connection state |
| `reconnecting` | `boolean` | Attempting to reconnect |
| `lastSeq` | `number` | Last received event sequence number |
| `client` | `WsClient \| null` | WebSocket client instance |

### uiStore (`src/stores/uiStore.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `activeModal` | `string \| null` | Which modal is open (shortcuts/settings/new-session) |
| `detailPanelOpen` | `boolean` | Right-side detail panel visibility |
| `activityFeedOpen` | `boolean` | Activity feed visibility |

**Actions:** `openModal(id)`, `closeModal()`, setters for panels.

### settingsStore (`src/stores/settingsStore.ts`)

Complex store managing all user preferences:

**Theme system (9 themes):**
`command-center` (default), `cyberpunk`, `warm`, `dracula`, `solarized`, `nord`, `monokai`, `light`, `blonde`

**Sound profiles (per-CLI):** 4 CLI configs — `claude`, `gemini`, `codex`, `openclaw`. Each CLI has ~19 action→sound mappings.

**Ambient presets (5):** `rain`, `lofi`, `serverRoom`, `deepSpace`, `coffeeShop`, `off`

| Category | Settings |
|----------|----------|
| Appearance | `themeName`, `fontSize` (13px default), `scanlineEnabled`, `animationIntensity`, `animationSpeed`, `characterModel` |
| Sound | `soundSettings` (enabled, volume, muteApproval, muteInput, perCli), `soundActions`, `movementActions` |
| Hooks | `hookDensity` (high/medium/low/off) |
| UI | `activityFeedVisible`, `toastEnabled`, `autoSendQueue`, `defaultTerminalTheme` |

**Persistence:** Settings persist to Dexie `settings` table. Theme/font changes apply side effects to DOM (CSS variables, data attributes). `persistSetting(key, value)` — async write to IndexedDB. Autosave flash: 2000ms.

### queueStore (`src/stores/queueStore.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `queues` | `Map<string, QueueItem[]>` | Per-session prompt queues |

**QueueItem:** `{id, sessionId, text, position, createdAt}`

**Actions:** `add`, `remove`, `reorder`, `moveToSession`, `setQueue`.

### cameraStore (`src/stores/cameraStore.ts`)

| Field | Type | Description |
|-------|------|-------------|
| `pendingTarget` | `CameraTarget \| null` | Target for camera fly-to |
| `isAnimating` | `boolean` | Flying in progress |

**Defaults:** `DEFAULT_CAMERA_POSITION: [18, 16, 18]`, `DEFAULT_CAMERA_TARGET: [0, 1, 0]`.

**Actions:** `flyTo(position, lookAt)`, `completeAnimation()`.

### roomStore (`src/stores/roomStore.ts`)

Rooms replace the old vanilla JS group system. Stored in `localStorage['session-rooms']`.

| Field | Type | Description |
|-------|------|-------------|
| `id` | `string` | `room-{timestamp}-{random}` |
| `name` | `string` | User-defined room name |
| `sessionIds` | `string[]` | Sessions assigned to this room |
| `collapsed` | `boolean` | UI collapse state |
| `roomIndex` | `number` | Grid position (0=NW, 1=NE, 2=SW, 3=SE) |

**Actions:** `createRoom`, `renameRoom`, `deleteRoom`, `addSession`, `removeSession`, `moveSession`, `toggleCollapse`, `setRoomIndex`. All changes auto-persist to localStorage.

---

## 15. React Hooks (8 Hooks)

### useWebSocket (`src/hooks/useWebSocket.ts`)

- Creates single `WsClient` instance on mount
- Handles 4 message types: `snapshot`, `session_update`, `session_removed`, `clearBrowserDb`
- Deduplicates sessions by most recent `lastActivityAt`
- Handles session migration via `replacesId`
- Integrates sound: calls `handleEventSounds()` + `checkAlarms()`
- Persists sessions to Dexie via `persistSessionUpdate()`

### useTerminal (`src/hooks/useTerminal.ts`)

| Parameter | Value |
|-----------|-------|
| Font family | JetBrains Mono (fallbacks: Cascadia Code, Fira Code, Menlo) |
| Font size | 11px (≤480w), 12px (≤640w), 14px (default) |
| Scrollback | 10,000 lines |
| Cursor | Bar, non-blinking |
| Resize debounce | 50ms |
| Output buffer max | 500 pending items |
| First output refresh | 100ms delay |
| Setup retries | 60 (at 50ms intervals ≈ 3s timeout) |

**Addons:** FitAddon, Unicode11Addon, WebLinksAddon.

**Returns:** `containerRef`, `attach()`, `detach()`, `isAttached`, `activeTerminalId`, `toggleFullscreen()`, `isFullscreen`, `sendEscape()`, `refitTerminal()`, `setTheme()`, `handleTerminalOutput()`, `handleTerminalReady()`, `handleTerminalClosed()`, `reparent()`, `scrollToBottom()`.

**Escape key** always forwards `\x1b` to SSH terminal.

### useSound (`src/hooks/useSound.ts`)

Returns `{play(action), preview(soundName), enabled, volume}`. Respects global `soundSettings.enabled`, per-category muting (`muteApproval`, `muteInput`). Unlocks Web Audio on first user interaction.

### useAuth (`src/hooks/useAuth.ts`)

Returns `{token, loading, needsLogin, login(password), logout()}`. Token stored in `localStorage['auth_token']`. Listens for `ws-auth-failed` custom event. `authFetch()` helper adds `Authorization: Bearer {token}` header.

### useKeyboardShortcuts (`src/hooks/useKeyboardShortcuts.ts`)

| Key | Context | Action |
|-----|---------|--------|
| `/` | Any (not in input) | Focus search input |
| `?` | Any (not in input) | Toggle shortcuts panel |
| `S` | Any (not in input) | Toggle settings modal |
| `T` | Any (not in input) | New terminal session |
| `K` | Session selected | Kill session (with confirmation) |
| `A` | Session selected | Archive session |
| `M` | Any (not in input) | Toggle global mute |
| `Escape` | Any | Close modal / deselect session (passes through to terminal if xterm focused) |
| `Alt+Cmd+R` / `Alt+Ctrl+R` | Terminal | Refresh terminal |
| `Alt+F11` | Any | Browser fullscreen toggle |

All shortcuts are suppressed when focus is in `INPUT`, `TEXTAREA`, `SELECT`, or `contentEditable` elements.

### useSettingsInit (`src/hooks/useSettingsInit.ts`)

Runs once on app startup. Loads persisted settings from Dexie, applies theme/font side effects, syncs master volume to sound engine, unlocks Web Audio on first user interaction.

### useClickOutside (`src/hooks/useClickOutside.ts`)

`useClickOutside(ref, handler, enabled = true)` — Calls handler on `mousedown` outside the element.

### useKnownProjects (`src/hooks/useKnownProjects.ts`)

Returns `string[]` — deduplicated project paths. Merges workdir history from `localStorage['workdir-history']` with known projects from `GET /api/known-projects`.

---

## 16. Library Utilities

### WebSocket Client (`src/lib/wsClient.ts`)

| Parameter | Value |
|-----------|-------|
| Base reconnection delay | 1,000 ms |
| Max reconnection delay | 10,000 ms |
| Backoff formula | `min(1000 × 2^attempt, 10000)` |
| Auth failure code | `4001` (no reconnect) |

On reconnect, sends `{type: 'replay', sinceSeq: lastSeq}` to recover missed events.

### Sound Engine, Ambient Engine, Alarm Engine

> See [_3d_multimedia_features.md](_3d_multimedia_features.md) sections 22-24 for full sound system documentation.

- **`soundEngine`** (`src/lib/soundEngine.ts`): 16 synthesized sounds, 19 actions, per-CLI profiles. Zero audio files.
- **`ambientEngine`** (`src/lib/ambientEngine.ts`): 5 procedural presets (rain, lofi, serverRoom, deepSpace, coffeeShop).
- **`alarmEngine`** (`src/lib/alarmEngine.ts`): Approval alarm (repeating 10s), input notification (one-shot), per-tool sound mapping.

### CLI Detection (`src/lib/cliDetect.ts`)

| CLI | Detection Keywords |
|-----|-------------------|
| `claude` | claude, opus, sonnet, haiku |
| `gemini` | gemini, gemma |
| `codex` | gpt, codex, o1, o3, o4 |
| `openclaw` | openclaw, claw |

Fallback: event type (`BeforeAgent/AfterAgent` → gemini, `agent-turn-complete` → codex).

### Robot State Map (`src/lib/robotStateMap.ts`)

Maps session status to 3D robot state (8 states: idle, thinking, working, waiting, alert, input, offline, connecting). Each state defines `seekDesk`, `wander`, `urgentFlash`, `visorColorOverride`, `speedMultiplier`, `casualTarget`.

> See [_3d_multimedia_features.md](_3d_multimedia_features.md) section 15.14 for full animation details per state.

### Format Utilities (`src/lib/format.ts`)

- `formatDuration(ms)` — Returns "Xh Ym", "Xm Ys", or "Xs"
- `escapeHtml(str)` — HTML entity escaping
- `getSourceLabel(source)` — Maps 12 source types to display labels
- `getStatusLabel(status)` — Maps session status to uppercase display

### Scene Themes, Robot Geometry, Robot Models, Position Persistence

> See [_3d_multimedia_features.md](_3d_multimedia_features.md) sections 15.13, 15.22 for full geometry, material, model variant, and theme documentation.

- **`sceneThemes.ts`**: 9 theme definitions (54 color/lighting properties each): command-center, cyberpunk, warm, dracula, solarized, nord, monokai, light, blonde.
- **`robot3DGeometry.ts`**: 16-color neon palette, 10 shared geometries, 4 shared materials (metalMat, darkMat, neonMat pool, edgeMat pool).
- **`robot3DModels.ts`**: 6 model variants (robot, mech, drone, spider, orb, tank) with per-part overrides.
- **`robotPositionPersist.ts`**: Saves robot positions to `sessionStorage['cyberdrome-robot-positions']` every 2s. Persists posX, posZ, rotY, mode, deskIdx.

---

## 17. 3D Cyberdrome Scene (`src/components/3d/`)

> Full 3D scene documentation including room layout, desk geometry, robot navigation AI, animation states, pathfinding, particle systems, and lighting is in [_3d_multimedia_features.md](_3d_multimedia_features.md) sections 15.1–15.22.

### Component Overview

| Component | File | Purpose |
|-----------|------|---------|
| `CyberdromeScene` | CyberdromeScene.tsx | DOM-side orchestrator: Zustand subscriptions, CustomEvent bridge, precomputed props for Canvas |
| `CyberdromeEnvironment` | CyberdromeEnvironment.tsx | Room walls, floors, desks, lighting, coffee lounge, gym, particles, stars |
| `SessionRobot` | SessionRobot.tsx | Per-session avatar: navigation AI, desk seeking, dialogue, CLI badge, position persistence |
| `Robot3DModel` | Robot3DModel.tsx | Mesh + animation: 8 state animations, tool-specific working, charging effect, label frame effects |
| `CameraController` | CameraController.tsx | Smooth fly-to animation via LERP, imperative store polling |
| `SubagentConnections` | SubagentConnections.tsx | Dashed laser lines between parent and child sessions |
| `RobotDialogue` | RobotDialogue.tsx | Floating speech bubbles (ref-based, no useState) |
| `StatusParticles` | StatusParticles.tsx | Burst effects on state transitions (pre-allocated buffers) |
| `RobotLabel` | RobotLabel.tsx | Floating name plates with status dot and alert banner |
| `RoomLabels` | RoomLabels.tsx | 3D floor text at room entrances |
| `SceneOverlay` | SceneOverlay.tsx | HUD: units online, mute toggle, room management |
| `RobotListSidebar` | RobotListSidebar.tsx | Agent list panel (top-left), sorted by status priority |

### Architecture Principles

1. **ZERO Zustand inside Canvas** — All store subscriptions in DOM-side `CyberdromeScene`. Data flows into Canvas via props only.
2. **CustomEvent bridge** — Robot clicks dispatch `CustomEvent('robot-select')` with `setTimeout(0)`, caught by DOM-side `useEffect`.
3. **Ref-based animation** — All per-robot state in refs (NavState, dialogueRef, seatedRef). No `useState` in render loop.
4. **Imperative store reads** — `useStore.getState()` inside `useFrame` (CameraController, Robot3DModel).
5. **Memoized SessionRobot** — `React.memo` with 16-field custom equality check.

### Store Dependencies

| Component | Location | Store Subscriptions |
|-----------|----------|---------------------|
| CyberdromeScene | DOM wrapper | sessionStore, roomStore, settingsStore, cameraStore |
| SceneOverlay | DOM overlay | roomStore, sessionStore, cameraStore, settingsStore |
| RobotListSidebar | DOM overlay | sessionStore, roomStore |
| All Canvas components | Canvas | NONE (props only or imperative reads) |

---

## 18. Session Detail Panel (`src/components/session/`)

### DetailPanel.tsx

Slides in from the right. Initial width 480px, min 320, max 95vw (resizable via drag handle).

**Sections:**
1. **Header:** Mini 3D robot preview (64×80px Canvas), project name, title, status/model/duration badges
2. **SessionControlBar:** Resume/Kill/Archive/Delete/Summarize/Alert buttons, room selector, label chips
3. **DetailTabs:** 6 tabs (see below)

Close on Escape (unless xterm focused). Selection persisted to `localStorage['selected-session']`.

### DetailTabs (6 tabs)

| Tab | Component | Content |
|-----|-----------|---------|
| `TERMINAL` | TerminalContainer | xterm.js terminal connected via WebSocket relay. Reconnect button for ended sessions. |
| `PROMPTS` | PromptHistory | Scrollable prompt history. Previous sessions if resumed. |
| `QUEUE` | QueueTab | Prompt queue management — compose, reorder, send, move between sessions. |
| `NOTES` | NotesTab | Per-session notes, saved to localStorage by sessionId. |
| `ACTIVITY` | ActivityLog | Interleaved events, tool calls, response excerpts. |
| `SUMMARY` | SummaryTab | AI-generated summary text. |

Lazy mounting: only the active tab's content mounts. Tab state persisted in `localStorage['active-tab']`.

### SessionControlBar

| Button | Action |
|--------|--------|
| Resume | `POST /api/sessions/:id/resume` (if ended) |
| Kill | Opens KillConfirmModal → `POST /api/sessions/:id/kill` |
| Archive | Marks ended+archived, `DELETE /api/sessions/:id` |
| Delete | Permanent delete with confirm dialog |
| Summarize | Opens SummarizeModal → `POST /api/sessions/:id/summarize` |
| Alert | Opens AlertModal |

**Room selector:** Dropdown to assign/move session to room or create new room.
**Label chips:** ONEOFF, HEAVY, IMPORTANT quick-assign chips.

### Modals (lazy-mounted)

- **KillConfirmModal**: Confirm kill, `POST /api/sessions/:id/kill`
- **AlertModal**: Set duration alert
- **SummarizeModal**: Choose template, trigger summarization

---

## 19. New Session Modals (`src/components/modals/`)

### NewSessionModal (Full Terminal Creation)

| Field | Default | Notes |
|-------|---------|-------|
| Host | `localhost` | Auto-detected |
| Port | `22` | — |
| Username | System username | Auto-filled from `os.userInfo()` or last used |
| Auth method | `key` | Options: key, password |
| Private key | — | Loaded from `GET /api/ssh-keys` |
| Password | — | Shown when auth method = password |
| Working directory | — | Text input with history dropdown + known projects from `GET /api/known-projects` |
| Command | `claude` | Options: claude, gemini, codex, custom |
| API key | — | Optional override |
| Session title | — | Optional |
| Label | — | Datalist with saved labels |

**Tmux modes:**
- Default: Fresh shell
- tmux-wrap: New tmux window
- tmux-attach: List existing sessions via `POST /api/tmux-sessions`

**Persistence:** `localStorage['lastSession']` stores connection config. `localStorage['workdir-history']` (max 20 entries, MRU order).

**Submission:** `POST /api/terminals`.

### QuickSessionModal (Quick Launch)

Abbreviated form for fast localhost session launching.

| Field | Notes |
|-------|-------|
| Label | Pre-filled from button (ONEOFF/HEAVY/IMPORTANT) or custom chips |
| Session title | Optional |
| Working directory | Defaults to last-used, suggestions from known projects |

Custom labels stored in `localStorage['custom-labels']`. Submission: `POST /api/terminals` with `command='claude'`.

---

## 20. Route Components

### LiveView (`src/routes/LiveView.tsx`)

Renders `<CyberdromeScene/>` lazily via `Suspense` fallback.

### HistoryView (`src/routes/HistoryView.tsx`)

**Filters:** Query (search prompts), Project, Status, Date range, Sort by (date/duration/prompts/tools).

**Display:** Table of sessions with columns: title, project, date, duration, status, prompts count, tools count, delete button.

**Pagination:** 50 sessions per page.

**Row click:** Fetches `GET /api/db/sessions/:id`, opens detail overlay.

**APIs used:** `GET /api/db/projects`, `GET /api/db/sessions`, `GET /api/db/sessions/:id`, `DELETE /api/db/sessions/:id`.

### TimelineView (`src/routes/TimelineView.tsx`)

**Granularity:** Hour / Day / Week selector.

**Filters:** Project, date range.

**Chart:** Recharts BarChart with 3 grouped bars per time bucket:

| Series | Color |
|--------|-------|
| Sessions | `#00e5ff` (cyan) |
| Prompts | `#00ff88` (green) |
| Tool Calls | `#ff9800` (orange) |

### AnalyticsView (`src/routes/AnalyticsView.tsx`)

Dashboard with summary stats, tool usage, project activity, and heatmap. APIs: `GET /api/db/analytics/summary`, `/tools`, `/projects`, `/heatmap`.

### QueueView (`src/routes/QueueView.tsx`)

Shows pending command queues across all sessions.

---

## 21. Shared UI Components (`src/components/ui/`)

| Component | Purpose |
|-----------|---------|
| `Modal` | Overlay backdrop, centered card, close on Escape/backdrop click |
| `Tabs` | Tab bar + content area, active styling, `onTabChange` callback |
| `SearchInput` | Debounced input with clear button |
| `ResizablePanel` | Resizable from side, min/max constraints, slide-in animation |
| `ToastContainer` | `showToast(message, type)`, auto-dismiss 3s, types: success/error/info |

---

## 22. Status Colors

| Status | Hex | Color |
|--------|-----|-------|
| `idle` | `#00ff88` | Green |
| `prompting` | `#00e5ff` | Cyan |
| `working` | `#ff9100` | Orange |
| `waiting` | `#00e5ff` | Cyan |
| `approval` | `#ffdd00` | Yellow |
| `input` | `#aa66ff` | Purple |
| `ended` | `#ff4444` | Red |
| `connecting` | `#666666` | Gray |

---

## 23. Performance Optimizations

| Technique | Where | Impact |
|-----------|-------|--------|
| Zero Zustand in Canvas | CyberdromeScene | Prevents cross-reconciler cascades (React Error #185) |
| Ref-based state in Canvas | SessionRobot, Robot3DModel | No React re-renders in R3F tree |
| Lazy modal children | DetailPanel modals | Only active modal mounts |
| Lazy component loading | CyberdromeScene | Suspense boundary for 3D scene |
| Memoization | SessionRobot, RobotLabel | Granular prop comparison |
| Material reuse | robot3DGeometry.ts | Shared geometry/material pools |
| Batch useFrame updates | Robot3DModel | Multiple refs in single frame |
| DrawRange optimization | StatusParticles | Visibility via geometry.setDrawRange() |
| Imperative store reads | CameraController, Robot3DModel | `useStore.getState()` inside useFrame |

---

## 24. localStorage / sessionStorage Keys Reference

| Key | Module | Contents |
|-----|--------|----------|
| `auth_token` | useAuth | JWT token string |
| `selected-session` | DetailPanel | Session ID string |
| `active-tab` | DetailTabs | Tab name string |
| `session-rooms` | roomStore | JSON array of room objects |
| `workdir-history` | NewSessionModal | JSON array of working dirs (max 20) |
| `lastSession` | NewSessionModal | JSON object with SSH connection config |
| `custom-labels` | QuickSessionModal | JSON array of custom label definitions |
| `cyberdrome-robot-positions` | robotPositionPersist (**sessionStorage**) | JSON map of robot positions |
