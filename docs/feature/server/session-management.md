# Session Store & Lifecycle

## Function
Coordinates session lifecycle, state transitions, and in-memory session storage using the coordinator pattern.

## Purpose
Central hub that manages all session state. Every other feature reads from or writes to the session store.

## Source Files
| File | Role |
|------|------|
| `server/sessionStore.ts` (~54KB) | Coordinator: delegates to sub-modules, handles events, manages Map<string, Session> |
| `server/autoIdleManager.ts` | Idle transition timers (checks every 10s) |
| `server/config.ts` | Tool categories, timeouts, animation maps |
| `server/constants.ts` | All magic strings (events, statuses, WS types) |

## Implementation

### State Machine
- Session state machine: connecting -> idle -> prompting -> working -> approval/input -> waiting -> ended
- 8 statuses: idle, prompting, working, approval, input, waiting, ended, connecting
- `connecting` is initial status for terminal sessions before first hook arrives

### Animation State Mapping
- Idle/Walking/Running/Waiting/Death/Dance with emotes (Wave, ThumbsUp, Jump, Yes)

### Auto-Idle Timeouts
- prompting 30s, waiting 2min, working 3min, approval/input 10min

### Session Object
- ~45 fields including sessionId, projectPath, status, animationState, currentPrompt, promptHistory (last 50), toolLog (last 200), responseLog (last 50), events (last 50), model, teamId, terminalId, etc.

### Event Buffer
- Ring buffer: last 500 events for WebSocket reconnect replay

### Snapshot Persistence
- /tmp/claude-session-center/sessions-snapshot.json every 10s (atomic write)
- SSH sessions restored as idle (PTY dead), non-SSH ended sessions get ServerRestart event for Priority 0.5 auto-link

### Broadcast Throttle
- 250ms per sessionId (max 4/sec), coalesces updates within each window (via hookProcessor.ts scheduleBroadcast)

### Heavy Work Variant
- totalToolCalls > 10 at Stop -> Dance animation instead of Waiting+ThumbsUp

### Key Exported Functions
- handleEvent() — processes hook events, drives state machine
- getAllSessions() / getSession() — read session state
- createTerminalSession() — creates session card when terminal connects
- findActiveSessionByConfig() — deduplicates by config (host, workDir, command, sessionTitle)
- clearAllSessions() — removes all sessions, captures terminal output buffers for replay
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
