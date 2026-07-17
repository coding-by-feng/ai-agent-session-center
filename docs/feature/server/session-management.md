# Session Store & Lifecycle

## Function
Coordinates session lifecycle, state transitions, and in-memory session storage using the coordinator pattern.

## Purpose
Central hub that manages all session state. Every other feature reads from or writes to the session store.

## Source Files
| File | Role |
|------|------|
| `server/sessionStore.ts` (~61KB, ~1478 lines) | Coordinator: delegates to sub-modules, handles events, manages Map<string, Session> |
| `server/sessionMatcher.ts` | 8-priority hook→session linking (delegated from sessionStore) |
| `server/approvalDetector.ts` | Tool-approval timeout detection |
| `server/teamManager.ts` | Subagent / team relationship tracking |
| `server/processMonitor.ts` | PID liveness (`findClaudeProcess` lives here; sessionStore re-exports a wrapper) |
| `server/autoIdleManager.ts` | Idle transition timers (checks every 10s) + stale `pendingResume` cleanup (checks every 15s) |
| `server/floatingSessionSpawner.ts` | Builds the prompt + config for fork/floating sessions; calls into `createTerminalSession` with `isFork: true`, `isFloating: true`, and `originSessionId`. Detailed in [Floating Session Spawner](./floating-session-spawner.md) |
| `server/sessionTitle.ts` | Pure title helpers (`makeShortTitle`, `isCloneForkTemplateTitle`, `buildAutoTitle`) — no DB imports so they are unit-testable (`test/sessionTitle.test.ts`) without tripping the better-sqlite3 Vitest worker crash |
| `server/config.ts` | Tool categories, timeouts, animation maps, permission-flag + launch-flag command helpers |
| `server/constants.ts` | All magic strings (events, statuses, WS types) |
| `src/types/session.ts`, `src/types/hook.ts`, `src/types/index.ts` | Shared hook/session types (`cliSource`, Codex event metadata, `PostCompact`) |

## Implementation

### State Machine
- Session state machine: connecting -> idle -> prompting -> working -> approval/input -> waiting -> ended
- 8 statuses: idle, prompting, working, approval, input, waiting, ended, connecting
- `connecting` is initial status for terminal sessions before first hook arrives
- `connectingTimeout` safety net: sessions stuck in CONNECTING transition to idle after 30s (Claude) or 3s (non-Claude agents)

### Animation State Mapping
- Idle/Walking/Running/Waiting/Death/Dance with emotes (Wave, ThumbsUp, Jump, Yes)

### Auto-Idle Timeouts
- `AUTO_IDLE_TIMEOUTS` (config.ts): prompting 30s → waiting, waiting 5min → idle, working 15min → idle, approval/input 10min → idle (safety net). `startAutoIdle` checks every 10s. The `waiting`/`working` timeouts are deliberately lenient: a busy agent can think or run a single long tool for minutes WITHOUT emitting any hook event, and in the Electron app the server never sees the streaming terminal output — short timeouts therefore mislabel a running session as green "Idle". `working → idle` is kept (the queue [chain gate](../frontend/queue-scheduler.md) relies on decayed-`idle` NOT counting as a Stop signal) but made patient.
- `startPendingResumeCleanup` (autoIdleManager.ts) runs every 15s and reverts a session still stuck in `connecting` for >2min back to idle, clearing its `pendingResume` entry (gives slow SessionStart hooks time to arrive).

### Session Object
- 62 fields on the `Session` interface (`src/types/session.ts:136-236`) including sessionId, projectPath, status, animationState, currentPrompt, promptHistory (last 50), toolLog (last 200), responseLog (last 50), events, model, teamId, terminalId, etc.
- `cliSource?: string` records the originating CLI when hooks provide `cli_source` (the Codex and Gemini hooks both emit it) or when a terminal is created from a recognizable startup command (`inferCliSource`). Frontend CLI badges prefer this field before guessing from model/event data, and the floating-popup spawner's `resolveOriginCli` reads it first so a popup inherits the parent's CLI.
- Fork bookkeeping: `isFork: boolean` and `originSessionId?: string` — set in `createTerminalSession` when `config.isFork` is passed (floating spawner, clone/fork endpoints, snapshot restore). `isFork` is the process-isolation marker (kill-guard, hook fork-routing) and does NOT control visibility. `isFloating: boolean` is set separately (floating spawner + snapshot restore only) and marks hidden PiP popups; clone/fork sessions carry `isFork` without `isFloating` and stay visible in the session lists.
- Ops-terminal bookkeeping: `opsTerminalId: string | null` and `hadOpsTerminal: boolean` (sessionStore.ts:1047-1048) — written via `reconnectOpsTerminal` (sessionStore.ts:1385) so a session can carry a separate "ops shell" alongside the AI CLI's PTY.

### Workspace Metadata at Creation
- `createTerminalSession` applies `pinned`, `muted`, `alerted`, `accentColor`, `characterModel` from `config` at creation time (sessionStore.ts:1067-1071), plus `effortLevel` and `model` (1074-1075) so floating popups can inherit them before any hook sets `model`. Without this, metadata set via separate PUTs after creation would be missing from the first broadcast and a paired auto-save could overwrite the snapshot with stale values.

### Session Title Generation
Title helpers live in `server/sessionTitle.ts` (pure, no DB deps). On `USER_PROMPT_SUBMIT`, `handleEvent` auto-titles a session when it has **no title yet** OR when it still carries the static `"Clone of …"` / `"Fork of …"` template baked in at spawn:
- Guard: `if (!session.title || isCloneForkTemplateTitle(session.title))` (sessionStore.ts:700). `isCloneForkTemplateTitle` matches `/^(?:Clone|Fork) of /` (case-sensitive — only the generated template, never a manual rename).
- Title text: `buildAutoTitle(projectName, counter, prompt)` → `"<project> #<n> — <makeShortTitle(prompt)>"`, falling back to `"<project> — Session #<n>"` for an empty/uninformative prompt. `makeShortTitle` strips one leading polite prefix, keeps the first sentence/line up to ~60 chars, and capitalizes.
- **Clone/fork re-title**: clone/fork sessions spawn with `title = "Fork of X"` / `"Clone of X"` (apiRouter.ts:753,822 via `config.sessionTitle`). The widened guard re-titles them from their *own* first prompt so the card reflects the new session's work, not the origin's name. It is **one-shot** (the regenerated title no longer matches the template) and never clobbers a manual edit. Requires a CLI that emits a prompt hook (Claude/Codex); a clone that never receives one keeps the template title.
- Persistence + broadcast are free on this path: `USER_PROMPT_SUBMIT` is a DB-persist event (`dbUpsertSession`) and `handleEvent` returns the spread session that rides the next throttled `SESSION_UPDATE` broadcast; the next `saveSnapshot` captures the new title for restart survival.

### Event Buffer
- Ring buffer: last 500 events for WebSocket reconnect replay

### Snapshot Persistence
- `sessions-snapshot.json` in `SNAPSHOT_DIR` (sessionStore.ts:94: `APP_USER_DATA` for Electron, Windows TEMP, else `/tmp/claude-session-center`), written atomically every 10s (`SNAPSHOT_INTERVAL_MS = 10_000`)
- `loadSnapshot` restores **only `source === 'ssh'` sessions** — every non-SSH session is skipped outright at sessionStore.ts:190. Non-ended SSH sessions come back as `idle` with a `ServerRestart` event (the PTY is always dead — it was a child of the old node process), `terminalId` cleared and `lastTerminalId` preserved; this applies whether the cached PID is still alive (sessionStore.ts:209-226) or died while the server was down (227-243). The `ServerRestart` event is what makes them [Priority 0.5](./session-matching.md) auto-link eligible.
- Sessions that were **already `ended`** at snapshot time stay ended (sessionStore.ts:199-207) — they `continue` before the PID-liveness branch and are only re-inserted when `isHistorical` is true. There is no revive-from-`ended` path on load.
- Ephemeral floating popups (`isFloating`, or `isFork` with an `originSessionId`) are skipped on load (sessionStore.ts:196) — they have no standalone UI presence and no PTY recovery path, so server-side revival would create invisible idle zombies hidden from every list. The dashboard re-opens any still-relevant popup during workspace import.
- The non-SSH ended-session `ServerRestart` tagging branch (sessionStore.ts:288-302) is currently **dead code**: its loop iterates the `sessions` Map, which the load loop only ever populates with SSH sessions, and `loadSnapshot()` is called once at boot (server/index.ts:363) when the Map is empty — so `nonSshCleanupIds` is always empty.

### Broadcast Throttle
- 20ms debounce via `BROADCAST_DEBOUNCE_MS` (sessionStore.ts:464, reduced from the earlier 50ms) — ~50/sec. `debouncedBroadcast` batches all broadcasts in the window then deduplicates: `session_update` collapses to the latest per `sessionId`, every other type collapses to one per message type. Smaller window keeps the 3D scene + status pills feeling live; rely on the per-key coalescing (not the window) to avoid flooding browsers.

### Heavy Work Variant
- At `Stop`, `wasHeavyWork = totalToolCalls > 10 && status === WORKING` -> Dance animation instead of Waiting+ThumbsUp (sessionStore.ts:752). `totalToolCalls` is reset to 0 after each Stop.
- Codex `Stop` payloads may provide `last_assistant_message`; `handleEvent()` reads `response` / `last_assistant_message` / `message` / `stop_reason_str` (first non-empty), stores a 2000-char excerpt in `responseLog` (last 50).
- `PostCompact` is a known event recorded with detail `Context compaction completed` (and `PreCompact` → `Context compaction starting`) so Codex compaction completion no longer collapses into a generic stop/unknown state.

### Key Exported Functions
- handleEvent() — processes hook events, drives state machine
- getAllSessions() / getSession() — read session state
- createTerminalSession() — creates session card when terminal connects
- findActiveSessionByConfig() — deduplicates by config (host, workDir, command, sessionTitle)
- getSessionByTerminalId() (sessionStore.ts:957) — resolves a session from its `terminalId`; used for fork parent resolution (`floatingSessionSpawner.ts:165`)
- clearAllSessions() — removes all sessions, captures terminal output buffers for replay; returns `{ removed: number, savedOutputs: SavedTerminalOutput[] }` (sessionStore.ts:1183-1223) where each `savedOutputs` entry is keyed by `title\0workDir` (the raw `sshConfig.workingDir`, falling back to `projectPath`) for replay after workspace import
- detectSessionSource(sessionId) (sessionStore.ts:1397) — classifies a session's spawn source (returns `session.source`, defaulting to `'ssh'`; `'unknown'` when the session is not found); used by kill flow
- findClaudeProcess(sessionId, projectPath) (sessionStore.ts:1404) — wrapper around processMonitor's resolver; passes internal `sessions` + `pidToSession` state
- killSession() / deleteSessionFromMemory() — end or remove sessions
- resumeSession() / reconnectSessionTerminal() / reconnectOpsTerminal() — resume/reconnect workflows
- setSessionTitle / setSessionPinned / setSessionMuted / setSessionAlerted / setSessionAccentColor / setSessionCharacterModel — session metadata setters. `setSessionTitle` mutates the in-memory session **and** persists to SQLite via `dbUpdateTitle` (it does not broadcast on its own; the title rides the next `SESSION_UPDATE`, and the originating browser updates optimistically).
- archiveSession() / setSummary() — persistence helpers
- linkTerminalToSession() / updateQueueCount() — terminal/queue integration
- registerSessionAlias() — maps old session IDs to new ones
- getSessionsForRespawn() — returns sessions eligible for workspace respawn
- pushEvent() / getEventsSince() / getEventSeq() — event ring buffer API
- saveSnapshot() / loadSnapshot() — periodic persistence to `SNAPSHOT_DIR` (see Snapshot Persistence)
- startPeriodicSave() / stopPeriodicSave() — snapshot interval management

### Ended Session Retention
- Kept in memory, broadcast to browsers, persisted to IndexedDB

## Dependencies & Connections

### Depends On
- [Hook System](./hook-system.md) — receives processed hook events
- [Session Matching](./session-matching.md) — delegates hook-to-session linking
- [Approval Detection](./approval-detection.md) — manages approval state transitions
- [Team & Subagent Tracking](./team-subagent.md) — manages team/subagent relationships
- [Process Monitor](./process-monitor.md) — monitors PID liveness

### Depended On By
- [WebSocket Manager](./websocket-manager.md) — broadcasts session state changes
- [API Endpoints](./api-endpoints.md) — reads/writes session data
- [Database](./database.md) — persists session state on key events
- [Floating Session Spawner](./floating-session-spawner.md) — calls `createTerminalSession` (with `isFork`/`isFloating`/`originSessionId`) to spawn floating sessions

### Shared Resources
- sessions Map
- eventBuffer ring
- snapshot file

## Change Risks
- This is the most critical module
- Changes to state transitions affect 3D animations, sound system, and approval detection
- Modifying the session object schema affects ALL consumers (frontend stores, DB persistence, WebSocket protocol)
- Breaking snapshot persistence means sessions lost on restart
- **Fork-aware kill cascade** — `apiRouter.ts:969` (`const pid = mem.isFork ? null : findClaudeProcess(...)`) skips `findClaudeProcess` for forks because forks share the origin session's `projectPath`; a cwd-based PID lookup would return the ORIGIN's claude PID and SIGTERM the wrong process. Forks instead rely on per-PTY `pty.kill` (group SIGHUP) via `closeTerminal`. Preserve this branch when modifying the kill flow — without it, closing a floating/fork session disconnects the parent terminal.
- **Clone/fork auto-rename vs title-based dedup** — once a clone/fork is re-titled from its first prompt (see *Session Title Generation*), `session.title` no longer equals the `sessionTitle` baked into its workspace-snapshot config. `findActiveSessionByConfig` deduplicates partly by `sessionTitle`, so a server-restart workspace reload that relies on the title branch could create a duplicate card. This is mitigated because the `originalSessionId` match path is preferred and title-independent; keep that path intact if you touch dedup.
