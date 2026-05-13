# Session Store & Lifecycle

## Function
Coordinates session lifecycle, state transitions, and in-memory session storage using the coordinator pattern.

## Purpose
Central hub that manages all session state. Every other feature reads from or writes to the session store.

## Source Files
| File | Role |
|------|------|
| `server/sessionStore.ts` (~54KB) | Coordinator: delegates to sub-modules, handles events, manages Map<string, Session> |
| `server/sessionMatcher.ts` | 8-priority hook→session linking (delegated from sessionStore) |
| `server/approvalDetector.ts` | Tool-approval timeout detection |
| `server/teamManager.ts` | Subagent / team relationship tracking |
| `server/processMonitor.ts` | PID liveness (`findClaudeProcess` lives here; sessionStore re-exports a wrapper) |
| `server/autoIdleManager.ts` | Idle transition timers (checks every 10s) |
| `server/floatingSessionSpawner.ts` | Builds the prompt + config for fork/floating sessions; calls into `createTerminalSession` with `isFork: true` and `originSessionId` |
| `server/config.ts` | Tool categories, timeouts, animation maps |
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
- prompting 30s, waiting 2min, working 3min, approval/input 10min

### Session Object
- ~57 fields including sessionId, projectPath, status, animationState, currentPrompt, promptHistory (last 50), toolLog (last 200), responseLog (last 50), events (last 50), model, teamId, terminalId, etc.
- `cliSource?: string` records the originating CLI when hooks provide `cli_source` (Codex does) or when a terminal is created from a recognizable startup command. Frontend CLI badges prefer this field before guessing from model/event data.
- Fork bookkeeping: `isFork: boolean` and `originSessionId?: string` (sessionStore.ts:988-991) — set in `createTerminalSession` when `config.isFork` is passed by the floating-session spawner / clone flow.
- Ops-terminal bookkeeping: `opsTerminalId: string | null` and `hadOpsTerminal: boolean` (sessionStore.ts:964-965) — written via `reconnectOpsTerminal` (sessionStore.ts:1293) so a session can carry a separate "ops shell" alongside the AI CLI's PTY.

### Workspace Metadata at Creation
- `createTerminalSession` applies `pinned`, `muted`, `alerted`, `accentColor`, `characterModel` from `config` at creation time (sessionStore.ts:983-987). Without this, metadata set via separate PUTs after creation would be missing from the first broadcast and a paired auto-save could overwrite the snapshot with stale values.

### Event Buffer
- Ring buffer: last 500 events for WebSocket reconnect replay

### Snapshot Persistence
- /tmp/claude-session-center/sessions-snapshot.json every 10s (atomic write)
- SSH sessions restored as idle (PTY dead), non-SSH ended sessions get ServerRestart event for Priority 0.5 auto-link

### Broadcast Throttle
- 20ms per sessionId via `BROADCAST_DEBOUNCE_MS` (sessionStore.ts:452) — ~50/sec, coalesces updates per-key within each window. Smaller window than the previous 250ms throttle to keep the 3D scene + status pills feeling live; rely on the per-key coalescing (not the window) to avoid flooding browsers.

### Heavy Work Variant
- totalToolCalls > 10 at Stop -> Dance animation instead of Waiting+ThumbsUp
- Codex `Stop` payloads may provide `last_assistant_message`; `handleEvent()` treats it like `response` for responseLog storage.
- `PostCompact` is a known event and is recorded with detail `Context compaction completed` so Codex compaction completion no longer collapses into a generic stop/unknown state.

### Key Exported Functions
- handleEvent() — processes hook events, drives state machine
- getAllSessions() / getSession() — read session state
- createTerminalSession() — creates session card when terminal connects
- findActiveSessionByConfig() — deduplicates by config (host, workDir, command, sessionTitle)
- clearAllSessions() — removes all sessions, captures terminal output buffers for replay; returns `{ removed: number, savedOutputs: SavedTerminalOutput[] }` (sessionStore.ts:1094-1126) where each `savedOutputs` entry is keyed by `title\0projectPath` for replay after workspace import
- detectSessionSource(sessionId) (sessionStore.ts:1305) — classifies a session's spawn source; used by kill flow
- findClaudeProcess(sessionId, projectPath) (sessionStore.ts:1312) — wrapper around processMonitor's resolver; passes internal `sessions` + `pidToSession` state
- killSession() / deleteSessionFromMemory() — end or remove sessions
- resumeSession() / reconnectSessionTerminal() / reconnectOpsTerminal() — resume/reconnect workflows
- setSessionTitle/Label/Pinned/Muted/Alerted/AccentColor/CharacterModel — session metadata setters
- archiveSession() / setSummary() — persistence helpers
- linkTerminalToSession() / updateQueueCount() — terminal/queue integration
- registerSessionAlias() — maps old session IDs to new ones
- getSessionsForRespawn() — returns sessions eligible for workspace respawn
- pushEvent() / getEventsSince() / getEventSeq() — event ring buffer API
- saveSnapshot() / loadSnapshot() — periodic persistence to /tmp
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

### Shared Resources
- sessions Map
- eventBuffer ring
- snapshot file

## Change Risks
- This is the most critical module
- Changes to state transitions affect 3D animations, sound system, and approval detection
- Modifying the session object schema affects ALL consumers (frontend stores, DB persistence, WebSocket protocol)
- Breaking snapshot persistence means sessions lost on restart
- **Fork-aware kill cascade** — `apiRouter.ts:788` skips `findClaudeProcess` for forks because forks share the origin session's `projectPath`; a cwd-based PID lookup would return the ORIGIN's claude PID and SIGTERM the wrong process. Forks instead rely on per-PTY `pty.kill` (group SIGHUP) via `closeTerminal`. Preserve this branch when modifying the kill flow — without it, closing a floating/fork session disconnects the parent terminal.
