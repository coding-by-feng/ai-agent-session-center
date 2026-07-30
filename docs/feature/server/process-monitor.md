# Process Monitor & Auto-Idle

## Function
Periodically checks if AI CLI processes are still alive and transitions dead sessions to ended state. Also periodically scans the OS for interactive `claude` sessions started outside the dashboard (which fire no hooks) and surfaces them as thin cards (**Mechanism B**).

## Purpose
Detects when Claude/Gemini/Codex crashes or exits without sending a SessionEnd hook. Surfaces `claude` sessions that were already running before the dashboard hooks were installed — these fire no hooks, so neither the liveness loop nor `sessionMatcher` would ever create a card for them. Also manages auto-idle transitions for stale sessions.

## Source Files
| File | Role |
|------|------|
| `server/processMonitor.ts` | PID liveness checking, dead-process cleanup, `findClaudeProcess()` resolution chain, external-session discovery scan (Mechanism B), and the kill primitives `terminateProcessTree(pid)` (SIGTERM → ~2s poll → SIGKILL → ~1s verify, signalled to `-pgid` with a bare-PID fallback) + `reapPtyChildren(shellPid)` (group-terminates each `pgrep -P` child when a PTY closes) |
| `server/autoIdleManager.ts` | Idle transition timers + stale `pendingResume` cleanup |
| `server/config.ts` | Provides `PROCESS_CHECK_INTERVAL` and `AUTO_IDLE_TIMEOUTS` constants |
| `server/sessionStore.ts` | Implements the `registerDiscovered` callback (`registerDiscoveredSession`) and wires `startExternalDiscovery(...)` |
| `server/sessionKillPolicy.ts` | Detects live Codex thread cards sharing a host PID so per-card kill can use PTY isolation or reject safely |
| `test/externalDiscovery.test.ts` | Unit tests for the exported discovery helpers (`isInteractiveClaude`, `parseNameFlag`, `parseModelFlag`) |
| `test/terminateProcess.test.ts` | Process-group termination and PTY-child reaping integration coverage |

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
1. **Cached PID** — if `session.cachedPid` is valid and `kill(pid, 0)` succeeds, return it; otherwise evict it.
2. Resolve the process family from `session.cliSource` or its launch command.
3. **Codex/Gemini safety stop** — without a live cached PID, return `null`. Multiple terminals can share a cwd and multiple Codex threads can share a PID, so an OS scan cannot prove which process the user selected; the exact managed PTY is closed separately.
4. **Claude fallback only** — build a `claimedPids` set, then on win32 query `Get-CimInstance Win32_Process`; on Unix run `pgrep -f claude` and:
   - **cwd match** — for each unclaimed PID, resolve cwd (`lsof -a -d cwd -Fn -p <pid>` on darwin, `readlink /proc/<pid>/cwd` on Linux) and return the PID whose cwd equals `projectPath`.
   - **Claude-only TTY fallback** — first unclaimed PID with a real tty (`ps -o tty=`), excluding `??`/`?`.
   - **Claude-only last resort** — first unclaimed PID regardless of tty.

> Risk note: because the cwd match keys on `projectPath`, two sessions sharing a directory (e.g. a forked session) can resolve to the same PID — the `claimedPids` exclusion mitigates but does not fully eliminate this.

The API adds a second guard after resolution: `findLiveCodexPidPeers()` treats a PID shared by live Codex cards as a host identity, not a thread identity. It signals no shared PID; an exact managed PTY is the isolated target, and a terminal-less per-card request is rejected.

### External Session Discovery — Mechanism B (`processMonitor.ts`)
`startExternalDiscovery(sessions, pidToSession, registerDiscovered)` installs a **second** `setInterval` firing every `EXTERNAL_DISCOVERY_INTERVAL_MS` (`20_000`ms / 20s); `stopExternalDiscovery()` clears it. It is a **no-op on win32** (the scan is `ps`/`lsof`-based) and a singleton (`if (discoveryInterval) return`). A module-level `discoveryRunning` boolean is a **re-entrancy guard** — if a pass is still in flight when the timer fires again, the new tick returns immediately so overlapping scans can't pile up; the flag is reset in `.finally()`.

**Why it exists:** the liveness loop only tracks sessions it already knows about, and `sessionMatcher` only creates cards from hook events. A `claude` CLI started *before* the dashboard hooks were installed fires no hooks and would otherwise never appear. This scan surfaces those orphan sessions.

**Fully async / non-blocking:** the pass `discoverExternalSessions(...)` uses promisified `execFile` (`execFileAsync = promisify(execFile)`), never `execFileSync`, so the periodic scan never blocks the Node event loop — hook processing, WS relays, and HTTP stay responsive while `pgrep`/`ps`/`lsof` run.

**Pass steps (`discoverExternalSessions`, in order):**
1. `pgrep -f claude` (5s timeout) → candidate PIDs; excludes the server's own `process.pid`, and returns early if `pgrep` exits non-zero (no matches).
2. Build a `tracked` set = every key in `pidToSession` ∪ every `session.cachedPid`, **excluding pids held by an `external-<pid>` card**. Those are deliberately re-examined every pass: a discovered card minted *before* its owning PTY could be identified must get a chance to be reconciled away (step 6). Without the exclusion such a card would permanently shield its own pid from re-evaluation.
3. For each untracked PID, in parallel: `ps -o args=` (command line), `ps -o tty=` (controlling tty), and `ps -o ppid=` (parent pid), each with a 3s timeout. A PID that vanished between `pgrep` and `ps` is skipped. The ppid rides along in the existing `Promise.all`, so it costs no extra wall-clock.
4. Keep the PID only if `isInteractiveClaude(args)` **and** it has a real tty (not `''`, `'??'`, or `'?'`) — interactive sessions have a controlling terminal; daemons/headless workers don't.
5. Skip re-examined pids that are provably external: `pidToSession.has(pid) && !getTerminalByPtyPid(ppid)` — the parent is visibly not one of ours and never will be, so there is no point paying for the cwd lookup below on every pass.
6. Resolve cwd via `resolveCwd(pid)` (darwin: `lsof -a -d cwd -Fn -p <pid>`, linux: `readlink /proc/<pid>/cwd`, 3s timeout, `''` on failure).
7. Call `registerDiscovered({ pid, tty, ppid, cwd, name, model })`.
8. After the pass resolves, call the optional `reconcile` callback ([`sessionStore.reconcileDiscoveredSessions`](./session-management.md)) and log how many duplicate cards it dropped. It runs *after* the pass so it observes the pid bindings the pass just made.

**Exported pure helpers** (unit-tested in `test/externalDiscovery.test.ts`):
| Helper | Behavior |
|--------|----------|
| `isInteractiveClaude(args)` | `true` **only** when the first arg's basename is `claude` **and** `args` does NOT match `daemon`/`bg-pty-host`/`bg-spare` (background infra) or `--print`/`stream-json`/`--output-format`/`mcp-server`/`mcp ` (headless/MCP invocations). |
| `parseNameFlag(args)` | Extracts the `-n <label>` session name; labels may contain spaces, so it runs from after ` -n ` until the next ` --` flag. Returns `null` if absent. |
| `parseModelFlag(args)` | Extracts `--model <id>` (`--model\s+(\S+)`). Returns `null` if absent. |

**Exported interface** `DiscoveredProcess { pid: number; tty: string; ppid: number | null; cwd: string; name: string | null; model: string | null }` — everything a hook would otherwise carry, scraped from a bare OS process.

### Ownership: telling our own agents apart from external ones
A dashboard-launched agent fires **no hook while it waits at a prompt** — a login flow, a trust dialog, or simply idling. From the scan's point of view it is indistinguishable from an external session: live pid, real tty, no `cachedPid` owner. The original launch-race guard (skip if a `CONNECTING` session shares this cwd) only covers the first ~2 minutes, because `autoIdleManager` flips an unclaimed placeholder to `idle` at 120s. Past that point every such agent got a **second** card. Observed live on 2026-07-29: 12 duplicate pairs, 9 with byte-identical titles (`external-89298 "Verification"` shadowing the `term-…667 "Verification"` card that owned its PTY).

`ppid` is the fix. An agent started inside a managed terminal runs as `PTY → /bin/zsh -l → claude`, so its parent **is** `term.pty.pid`, giving an exact 1:1 `ppid → terminal → session` chain. `registerDiscoveredSession` resolves it with [`sshManager.getTerminalByPtyPid(ppid)`](./terminal-ssh.md) — a **pure Map scan with no syscall**, deliberately separate from the older `getTerminalByPtyChild`, which does the same lookup but shells out with `execSync` and therefore must never be called from this interval.

**cwd is not a substitute.** Many sessions share one directory (five shared `agent-manager/` on the machine where this was found), so cwd may only ever *suppress* card creation — it must never be used to *bind* a pid to a card, or the pid lands on an arbitrary sibling.

**Integration:** the `registerDiscovered` callback is [`sessionStore.registerDiscoveredSession`](./session-management.md) (wired via `startExternalDiscovery(...)` in `sessionStore.ts`). Order of operations:
1. **Ownership check first.** If `getTerminalByPtyPid(proc.ppid)` resolves, the agent is ours: bind `proc.pid` onto that terminal's session (so the card stops looking dead), drop any `external-<pid>` card an earlier pass already minted for it, and create nothing.
2. Otherwise the original guards apply — skip a PID already tracked, a cwd-less process, or a `CONNECTING` dashboard launch mid-flight for the same cwd.
3. Create the thin `external-<pid>` card (`status = idle`, no terminal, no transcript — just live status + name + cwd). It carries a `cachedPid`, so the liveness loop above auto-ends it when the process dies.

If a real hook later fires for that PID, [`sessionMatcher`](./session-matching.md) **Priority 1.5** (cached-PID match) re-keys the `external-<pid>` card in place onto the real `session_id` — for a discovered card the upgrade fires on the *first* hook of **any** event type (not just `SessionStart`), so a non-`SessionStart` first hook can't slip past into a duplicate card via Priority 5.

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
- The Claude fallback chain is fragile because cwd is not unique; forks continue to bypass it. Codex/Gemini intentionally require a live exact cached PID and otherwise rely on exact managed-terminal teardown.
- The auto-idle interval (10s) and pendingResume cleanup interval (15s) are hard-coded; the working-state timeout exclusion list must stay in sync with the `SESSION_STATUS` enum or transient states could be idled too early.
- **The ppid ownership check must stay syscall-free.** It runs inside the discovery interval, where a sync process spawn blocks the event loop and stalls hook processing / WS relays. Use `getTerminalByPtyPid` (Map scan) fed by the ppid the async `ps` batch already collected — **never** `getTerminalByPtyChild`, which calls `execSync`. The two functions look interchangeable and are not.
- **Never bind a pid from a cwd match.** cwd is shared by many sessions; only `ppid → PTY → session` is 1:1. cwd may suppress card creation, never assign ownership. Getting this wrong attaches a live pid to an arbitrary sibling card, which then reports the wrong liveness and can be killed by mistake.
- **Excluding `external-<pid>` pids from `tracked` is load-bearing.** It is what lets an already-minted discovered card be reconciled away once its PTY becomes identifiable. Re-adding them to `tracked` freezes every existing duplicate in place forever (sessions are never auto-expired). The step-5 "provably external" skip is what keeps that re-examination cheap — remove it and every genuine external session pays an `lsof` every 20s.
- **External discovery (Mechanism B):** the `discoveryRunning` re-entrancy guard is the only backpressure — if `EXTERNAL_DISCOVERY_INTERVAL_MS` (20s) is lowered below a pass's worst-case `pgrep`/`ps`/`lsof` latency, passes will simply skip rather than pile up, but discovery lag grows. The `tracked` set (`pidToSession` keys + `session.cachedPid`) is the dedup barrier; if a hook-bound session ever lacks a `cachedPid`, a duplicate `external-<pid>` card could be created until Priority 1.5 re-keys it. Weakening the `isInteractiveClaude` filters (basename check, tty requirement, daemon/headless exclusions) risks surfacing background infra (daemon, bg-pty-host, MCP/`--print` workers) as phantom sessions. Discovery is a no-op on win32, so external sessions are never surfaced there.
