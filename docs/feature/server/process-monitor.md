# Process Monitor & Auto-Idle

## Function
Periodically checks if AI CLI processes are still alive and transitions dead sessions to ended state.

## Purpose
Detects when Claude/Gemini/Codex crashes or exits without sending a SessionEnd hook. Also manages auto-idle transitions for stale sessions.

## Source Files
| File | Role |
|------|------|
| `server/processMonitor.ts` | PID liveness checking, dead-process cleanup, `findClaudeProcess()` resolution chain |
| `server/autoIdleManager.ts` | Idle transition timers + stale `pendingResume` cleanup |
| `server/config.ts` | Provides `PROCESS_CHECK_INTERVAL` and `AUTO_IDLE_TIMEOUTS` constants |

## Implementation

### Process Liveness Check (`processMonitor.ts`)
`startMonitoring(sessions, pidToSession, clearApprovalTimerFn, handleTeamMemberEndFn, broadcastFn)` installs a single `setInterval` that fires every `PROCESS_CHECK_INTERVAL` (default `15_000`ms, overridable via `serverConfig.processCheckInterval`). A guard (`if (livenessInterval) return`) keeps it a singleton; `stopMonitoring()` clears it.

Per tick, for each session it:
- Skips sessions that are `ended`, have no `cachedPid`, or whose `cachedPid` fails `validatePid()` (positive integer) — invalid PIDs are nulled out.
- Skips sessions with an active PTY (`session.terminalId && getTerminalForSession(id)`) — the terminal is the source of truth.
- Calls `process.kill(pid, 0)` (signal 0 = liveness probe, does not kill). A thrown error means the process is dead.

### Dead Process Handling
When `kill(pid, 0)` throws, the session is auto-ended:
- `status` → `ended`, `animationState` → `Death` (`ANIMATION_STATE.DEATH`), `lastActivityAt`/`endedAt` set to now.
- Pushes a synthetic `SessionEnd` event (`detail: 'Session ended (process exited)'`); the `events` array is capped at 50 entries (oldest shifted off).
- Releases the PID from `pidToSession` and nulls `session.cachedPid`.
- Clears the approval timer (`clearApprovalTimerFn`).
- Runs team cleanup (`handleTeamMemberEndFn`).
- Broadcasts a `session_update` (`WS_TYPES.SESSION_UPDATE`) message; broadcast failures are logged as warnings, not thrown.
- SSH sessions (`source === 'ssh'`) are marked `isHistorical = true`, `lastTerminalId` preserved, `terminalId` cleared.
- All sessions (SSH and non-SSH) are kept in memory — no auto-delete; the user must close them via the UI.

### `findClaudeProcess()` Resolution Chain
`findClaudeProcess(sessionId, projectPath, sessions, pidToSession)` returns the live PID for a session, caching the result via the `cachePid()` helper (sets both `pidToSession` and `session.cachedPid`). Order:
1. **Cached PID** — if `session.cachedPid` is valid and `kill(pid, 0)` succeeds, return it; otherwise evict it and re-scan.
2. Build a `claimedPids` set of PIDs owned by *other* sessions so they are never re-assigned.
3. **win32 branch** — runs a PowerShell `Get-CimInstance Win32_Process` query for `*claude*` command lines (excluding this server's own PID) and returns the first match.
4. **Unix branch** — `pgrep -f claude` (excluding this server's PID); for non-empty results:
   - **cwd match** — for each unclaimed PID, resolve cwd (`lsof -a -d cwd -Fn -p <pid>` on darwin, `readlink /proc/<pid>/cwd` on Linux) and return the PID whose cwd equals `projectPath`.
   - **TTY fallback** — first unclaimed PID with a real tty (`ps -o tty=`), excluding `??`/`?`.
   - **Last resort** — first unclaimed PID regardless of tty.

> Risk note: because the cwd match keys on `projectPath`, two sessions sharing a directory (e.g. a forked session) can resolve to the same PID — the `claimedPids` exclusion mitigates but does not fully eliminate this.

### Auto-Idle Timeouts (`autoIdleManager.ts`)
`startAutoIdle(sessions)` installs a `setInterval` that fires every **10s** (hard-coded `10000`); `stopAutoIdle()` clears it. Per tick it compares `now - session.lastActivityAt` against `AUTO_IDLE_TIMEOUTS`:

| Status | Timeout | Transitions To |
|--------|---------|----------------|
| `prompting` | `30_000` (30s) | `waiting` |
| `waiting` | `300_000` (5min) | `idle` |
| `approval` | `600_000` (10min) | `idle` (safety net) |
| `input` | `600_000` (10min) | `idle` (safety net) |
| any other working state | `900_000` (15min) | `idle` (safety net) |

`ended` and `idle` sessions are skipped outright. The final "working" branch explicitly excludes `waiting`, `prompting`, `approval`, `input`, and `connecting` states so only genuine in-flight work hits the 15-min timeout. On a transition to `idle` from `approval`/`input`, `pendingTool`, `pendingToolDetail`, and `waitingDetail` are also cleared.

### Stale `pendingResume` Cleanup
`startPendingResumeCleanup(pendingResume, sessions, broadcastFn)` installs a separate `setInterval` firing every **15s** (`stopPendingResumeCleanup()` clears it). Entries older than `120000`ms (2min) are removed; if the associated session is still in `connecting` status it is reverted to `idle` (terminal detached, `terminalId = null`) and a `session_update` broadcast is sent. The 2-min grace gives slow `SessionStart` hooks (2-5s on congested systems) time to arrive before cleanup.

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — reads sessions Map, writes status transitions
- [Approval Detection](./approval-detection.md) — clears timers on dead process
- [Team & Subagent Tracking](./team-subagent.md) — triggers team cleanup on member death

### Depended On By
- [Session Management](./session-management.md) — relies on process monitor for cleanup
- [WebSocket Manager](./websocket-manager.md) — dead process broadcasts to browsers

### Shared Resources
- `pidToSession` Map (PID → sessionId ownership)
- `sessions` Map (the live session state)
- `pendingResume` Map (terminalId → PendingResume, shared with session resume flow)

## Change Risks
- Increasing `PROCESS_CHECK_INTERVAL` delays dead-session detection; lowering it raises `pgrep`/`lsof` syscall load.
- False positives: `kill(pid, 0)` can throw `EPERM` (permission), not just `ESRCH` (no such process) — both are currently treated as "dead", which can prematurely end a still-running session owned by another user.
- The `findClaudeProcess()` chain is fragile — the cwd match keys on `projectPath`, so sessions sharing a directory can collide on the same PID despite the `claimedPids` guard.
- The auto-idle interval (10s) and pendingResume cleanup interval (15s) are hard-coded; the working-state timeout exclusion list must stay in sync with the `SESSION_STATUS` enum or transient states could be idled too early.
