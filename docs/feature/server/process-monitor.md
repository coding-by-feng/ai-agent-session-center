# Process Monitor & Auto-Idle

## Function
Periodically checks if AI CLI processes are still alive and transitions dead sessions to ended state. Also periodically scans the OS for interactive `claude` sessions started outside the dashboard (which fire no hooks) and surfaces them as thin cards (**Mechanism B**).

## Purpose
Detects when Claude/Gemini/Codex crashes or exits without sending a SessionEnd hook. Surfaces `claude` sessions that were already running before the dashboard hooks were installed — these fire no hooks, so neither the liveness loop nor `sessionMatcher` would ever create a card for them. Also manages auto-idle transitions for stale sessions.

## Source Files
| File | Role |
|------|------|
| `server/processMonitor.ts` | PID liveness checking, dead-process cleanup, `findClaudeProcess()` resolution chain, external-session discovery scan (Mechanism B) |
| `server/autoIdleManager.ts` | Idle transition timers + stale `pendingResume` cleanup |
| `server/config.ts` | Provides `PROCESS_CHECK_INTERVAL` and `AUTO_IDLE_TIMEOUTS` constants |
| `server/sessionStore.ts` | Implements the `registerDiscovered` callback (`registerDiscoveredSession`) and wires `startExternalDiscovery(...)` |
| `test/externalDiscovery.test.ts` | Unit tests for the exported discovery helpers (`isInteractiveClaude`, `parseNameFlag`, `parseModelFlag`) |

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

### External Session Discovery — Mechanism B (`processMonitor.ts`)
`startExternalDiscovery(sessions, pidToSession, registerDiscovered)` installs a **second** `setInterval` firing every `EXTERNAL_DISCOVERY_INTERVAL_MS` (`20_000`ms / 20s); `stopExternalDiscovery()` clears it. It is a **no-op on win32** (the scan is `ps`/`lsof`-based) and a singleton (`if (discoveryInterval) return`). A module-level `discoveryRunning` boolean is a **re-entrancy guard** — if a pass is still in flight when the timer fires again, the new tick returns immediately so overlapping scans can't pile up; the flag is reset in `.finally()`.

**Why it exists:** the liveness loop only tracks sessions it already knows about, and `sessionMatcher` only creates cards from hook events. A `claude` CLI started *before* the dashboard hooks were installed fires no hooks and would otherwise never appear. This scan surfaces those orphan sessions.

**Fully async / non-blocking:** the pass `discoverExternalSessions(...)` uses promisified `execFile` (`execFileAsync = promisify(execFile)`), never `execFileSync`, so the periodic scan never blocks the Node event loop — hook processing, WS relays, and HTTP stay responsive while `pgrep`/`ps`/`lsof` run.

**Pass steps (`discoverExternalSessions`, in order):**
1. `pgrep -f claude` (5s timeout) → candidate PIDs; excludes the server's own `process.pid`, and returns early if `pgrep` exits non-zero (no matches).
2. Build a `tracked` set = every key in `pidToSession` ∪ every `session.cachedPid`. Any candidate already in `tracked` is skipped (bound by a hook or a prior discovery pass).
3. For each untracked PID, in parallel: `ps -o args=` (command line) and `ps -o tty=` (controlling tty), each with a 3s timeout. A PID that vanished between `pgrep` and `ps` is skipped.
4. Keep the PID only if `isInteractiveClaude(args)` **and** it has a real tty (not `''`, `'??'`, or `'?'`) — interactive sessions have a controlling terminal; daemons/headless workers don't.
5. Resolve cwd via `resolveCwd(pid)` (darwin: `lsof -a -d cwd -Fn -p <pid>`, linux: `readlink /proc/<pid>/cwd`, 3s timeout, `''` on failure).
6. Call `registerDiscovered({ pid, tty, cwd, name, model })`.

**Exported pure helpers** (unit-tested in `test/externalDiscovery.test.ts`):
| Helper | Behavior |
|--------|----------|
| `isInteractiveClaude(args)` | `true` **only** when the first arg's basename is `claude` **and** `args` does NOT match `daemon`/`bg-pty-host`/`bg-spare` (background infra) or `--print`/`stream-json`/`--output-format`/`mcp-server`/`mcp ` (headless/MCP invocations). |
| `parseNameFlag(args)` | Extracts the `-n <label>` session name; labels may contain spaces, so it runs from after ` -n ` until the next ` --` flag. Returns `null` if absent. |
| `parseModelFlag(args)` | Extracts `--model <id>` (`--model\s+(\S+)`). Returns `null` if absent. |

**Exported interface** `DiscoveredProcess { pid: number; tty: string; cwd: string; name: string | null; model: string | null }` — everything a hook would otherwise carry, scraped from a bare OS process.

**Integration:** the `registerDiscovered` callback is [`sessionStore.registerDiscoveredSession`](./session-management.md) (wired via `startExternalDiscovery(...)` in `sessionStore.ts`). It creates a thin `external-<pid>` card (`status = idle`, no terminal, no transcript — just live status + name + cwd), guarded against duplicating a PID already tracked, a cwd-less process, or a `CONNECTING` dashboard launch mid-flight for the same cwd (avoids racing a dashboard-launched claude in its pre-hook window). The card carries a `cachedPid`, so the liveness loop above auto-ends it when the process dies. If a real hook later fires for that PID, [`sessionMatcher`](./session-matching.md) **Priority 1.5** (cached-PID match) re-keys the `external-<pid>` card in place onto the real `session_id` — for a discovered card the upgrade fires on the *first* hook of **any** event type (not just `SessionStart`), so a non-`SessionStart` first hook can't slip past into a duplicate card via Priority 5.

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
- [Session Management](./session-management.md) — reads sessions Map, writes status transitions; discovery invokes the `registerDiscoveredSession` callback (implemented there) to create `external-<pid>` cards
- [Session Matching](./session-matching.md) — discovered `external-<pid>` cards are upgraded in place by `sessionMatcher` **Priority 1.5** (cached-PID match) when a real hook later fires for the PID
- [Approval Detection](./approval-detection.md) — clears timers on dead process
- [Team & Subagent Tracking](./team-subagent.md) — triggers team cleanup on member death

### Depended On By
- [Session Management](./session-management.md) — relies on process monitor for cleanup; `startExternalDiscovery(...)` is wired here
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
- **External discovery (Mechanism B):** the `discoveryRunning` re-entrancy guard is the only backpressure — if `EXTERNAL_DISCOVERY_INTERVAL_MS` (20s) is lowered below a pass's worst-case `pgrep`/`ps`/`lsof` latency, passes will simply skip rather than pile up, but discovery lag grows. The `tracked` set (`pidToSession` keys + `session.cachedPid`) is the dedup barrier; if a hook-bound session ever lacks a `cachedPid`, a duplicate `external-<pid>` card could be created until Priority 1.5 re-keys it. Weakening the `isInteractiveClaude` filters (basename check, tty requirement, daemon/headless exclusions) risks surfacing background infra (daemon, bg-pty-host, MCP/`--print` workers) as phantom sessions. Discovery is a no-op on win32, so external sessions are never surfaced there.
