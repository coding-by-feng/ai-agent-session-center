# Session Store & Lifecycle

## Function
Coordinates session lifecycle, state transitions, and in-memory session storage using the coordinator pattern.

## Purpose
Central hub that manages all session state. Every other feature reads from or writes to the session store.

## Source Files
| File | Role |
|------|------|
| `server/sessionStore.ts` (~61KB, ~1478 lines) | Coordinator: delegates to sub-modules, handles events, manages Map<string, Session> |
| `server/sessionTrim.ts` | In-memory text caps: `truncateText`, `trimCurrentPrompt`, `pushPrompt` (entry-count + character budget), `toArchivedSession`. Constants `MAX_PROMPT_CHARS` / `MAX_PROMPT_HISTORY_CHARS` / `MAX_PROMPT_HISTORY_ENTRIES` / `MAX_CURRENT_PROMPT_CHARS` |
| `test/sessionTrim.test.ts` | 22 tests — truncation markers, budget eviction, newest-prompt survival, archive field set, DB-restore replay |
| `server/sessionMatcher.ts` | 8-priority hook→session linking (delegated from sessionStore); Priority 5 marks hook-only external sessions (`isExternal`), Priority 1.5 re-keys `external-<pid>` discovered cards in place on their first hook |
| `server/approvalDetector.ts` | Tool-approval timeout detection |
| `server/teamManager.ts` | Subagent / team relationship tracking |
| `server/processMonitor.ts` | PID liveness (`findClaudeProcess` lives here; sessionStore re-exports a wrapper) **and** external-session discovery (`startExternalDiscovery` OS scan, `DiscoveredProcess` type) |
| `server/autoIdleManager.ts` | Idle transition timers (checks every 10s) + stale `pendingResume` cleanup (checks every 15s) |
| `server/floatingSessionSpawner.ts` | Builds the prompt + config for fork/floating sessions; calls into `createTerminalSession` with `isFork: true`, `isFloating: true`, and `originSessionId`. Detailed in [Floating Session Spawner](./floating-session-spawner.md) |
| `server/sessionTitle.ts` | Pure title helpers (`makeShortTitle`, `isCloneForkTemplateTitle`, `buildAutoTitle`) — no DB imports so they are unit-testable (`test/sessionTitle.test.ts`) without tripping the better-sqlite3 Vitest worker crash |
| `server/sessionAliasResolver.ts` | Pure multi-hop alias resolver used for saved-terminal → fresh-terminal → hook-UUID chains |
| `test/sessionAliasResolver.test.ts`, `test/sessionLinkage.test.ts` | Alias-chain unit coverage and session-store integration coverage |
| `server/config.ts` | Tool categories, timeouts, animation maps, permission-flag + launch-flag command helpers |
| `server/constants.ts` | All magic strings (events, statuses, WS types) |
| `src/types/session.ts`, `src/types/hook.ts`, `src/types/index.ts` | Shared hook/session types (`cliSource`, `isExternal`, Codex event metadata, `PostCompact`) |

## Implementation

### State Machine
- Session state machine: connecting -> idle -> prompting -> working -> approval/input -> waiting -> ended
- 8 statuses: idle, prompting, working, approval, input, waiting, ended, connecting
- `connecting` is initial status for terminal sessions before first hook arrives
- `connectingTimeout` safety net: sessions stuck in CONNECTING transition to idle after 30s for lifecycle-hook CLIs (Claude or Codex), or 3s for other commands

### Animation State Mapping
- Idle/Walking/Running/Waiting/Death/Dance with emotes (Wave, ThumbsUp, Jump, Yes)

### Auto-Idle Timeouts
- `AUTO_IDLE_TIMEOUTS` (config.ts): prompting 30s → waiting, waiting 5min → idle, working 15min → idle, approval/input 10min → idle (safety net). `startAutoIdle` checks every 10s. The `waiting`/`working` timeouts are deliberately lenient: a busy agent can think or run a single long tool for minutes WITHOUT emitting any hook event, and in the Electron app the server never sees the streaming terminal output — short timeouts therefore mislabel a running session as green "Idle". `working → idle` is kept (the queue [chain gate](../frontend/queue-scheduler.md) relies on decayed-`idle` NOT counting as a Stop signal) but made patient.
- `startPendingResumeCleanup` (autoIdleManager.ts) runs every 15s and reverts a session still stuck in `connecting` for >2min back to idle, clearing its `pendingResume` entry (gives slow SessionStart hooks time to arrive).

### Session Object
- 62 fields on the `Session` interface (`src/types/session.ts:136-236`) including sessionId, projectPath, status, animationState, currentPrompt (capped 2 000 chars), promptHistory (last 50 **and** ≤200 000 chars total), toolLog (last 200), responseLog (last 50), events, model, teamId, terminalId, etc.
- `cliSource?: string` records the originating CLI when hooks provide `cli_source` (the Codex and Gemini hooks both emit it) or when a terminal is created from a recognizable startup command (`inferCliSource`). Frontend CLI badges prefer this field before guessing from model/event data, and the floating-popup spawner's `resolveOriginCli` reads it first so a popup inherits the parent's CLI.
- Fork bookkeeping: `isFork: boolean` and `originSessionId?: string` — set in `createTerminalSession` when `config.isFork` is passed (floating spawner, clone/fork endpoints, snapshot restore). `isFork` is the process-isolation marker (kill-guard, hook fork-routing) and does NOT control visibility. `isFloating: boolean` is set separately (floating spawner + snapshot restore only) and marks hidden PiP popups; clone/fork sessions carry `isFork` without `isFloating` and stay visible in the session lists.
- Ops-terminal bookkeeping: `opsTerminalId: string | null` and `hadOpsTerminal: boolean` (sessionStore.ts:1047-1048) — written via `reconnectOpsTerminal` (sessionStore.ts:1385) so a session can carry a separate "ops shell" alongside the AI CLI's PTY.
- External-session marker: `isExternal?: boolean` — flags a session the dashboard did NOT launch (a real Claude/Gemini/Codex CLI running in an external terminal, or started before hooks were installed), so it never bound to a dashboard PTY (`terminalId` stays `null`). Terminal actions (open / reconnect / kill-via-PTY) do not apply. See *External Sessions (discovered / hook-only)* below for the two producers. `sessionMatcher` clears the flag (`isExternal = false`) when such a session is later adopted onto a dashboard terminal.

### External Sessions (discovered / hook-only)
Two independent producers set `isExternal: true`; neither implies a dashboard terminal.
- **(a) Hook-backed external (`sessionMatcher` Priority 5)** — a hook event that matched no terminal by any higher priority. Previously dropped ("SSH-only mode"); now surfaced as an external card via `createDefaultSession` with the **real `sessionId`**, full transcript/`transcriptPath`/`permissionMode`, keyed by that sessionId. Gated to **interactive** sessions only: skipped for subagent events (`parent_session_id`/`agent_name`), `SessionEnd`, and any hook lacking `tty_path` (headless `claude -p`, CI, MCP-spawned). See [Session Matching](./session-matching.md).
- **(b) Process-scan discovered (`registerDiscoveredSession`)** — a live `claude` CLI found by the OS scan that fires no hooks (started before hooks installed). Produces a **thin card**: `source: 'terminal'`, `isExternal: true`, `cachedPid: proc.pid`, `terminalId: null`, `model` from `proc.model`, `title` from `proc.name || projectName`, and a single `SessionDiscovered` event (`detail: "External session detected (pid …)"`). No transcript, no `promptHistory`.

**`registerDiscoveredSession(proc: DiscoveredProcess)`** (exported) — creates the thin card keyed `external-<pid>`. `DiscoveredProcess` (from `processMonitor.ts`) carries `{ pid, tty, ppid, cwd, name, model }`. Dedup / replace guards, in order:
0. **Ownership check (runs before everything else).** If `getTerminalByPtyPid(proc.ppid)` resolves to one of our own PTYs, this agent was launched *by the dashboard* — it simply hasn't fired a hook yet because it is sitting at a login/trust prompt or idling. `reconcileOwnedPid(pid, terminalId)` then binds the pid onto that terminal's session, drops any `external-<pid>` card an earlier pass minted for it, and returns **without creating a card**. See [Process Monitor → Ownership](./process-monitor.md) for why `ppid` is the only exact signal and why cwd cannot be used to bind.
1. Return if `pidToSession.has(proc.pid)` (PID already tracked, hook-bound or a prior pass).
2. Return if any `session.cachedPid === proc.pid` (already covered under another key).
3. Return if `proc.cwd` is empty/unresolvable — without a cwd the launch-race guard can't run and a cwd-less card is near-useless; the next scan retries.
4. Return if a `CONNECTING` session already exists for that cwd (a dashboard launch is mid-flight and its own hook will bind the PID — creating a card now would race into a duplicate).
5. If an `external-<pid>` card already exists: **return** when it is still live, but **`sessions.delete(id)` + recreate** when it is `ENDED` (OS reused the PID after the old external process died; ended cards linger because sessions are never auto-deleted).

On create it does `sessions.set(id, session)`, `pidToSession.set(proc.pid, id)`, `invalidateSessionsCache()`, and broadcasts `SESSION_UPDATE` (`broadcastSessionUpdate`).

**Wiring** — the module-init block calls `startExternalDiscovery(sessions, pidToSession, registerDiscoveredSession, reconcileDiscoveredSessions)` right after `startMonitoring`. The scan interval is `EXTERNAL_DISCOVERY_INTERVAL_MS = 20_000` (20s) in [processMonitor](./process-monitor.md).

**`reconcileDiscoveredSessions(): number`** (exported) — post-pass cleanup for duplicates that the ownership check can no longer reach, run on the same 20s tick *after* the scan so it sees the bindings the scan just made. Returns the number of cards dropped.

An `external-<pid>` card heals itself: its pid is excluded from the scan's `tracked` set, so every pass re-evaluates it and the ownership check drops it once the PTY is identifiable. What cannot heal is a card that Priority 1.5 already **promoted** to a real session id — it no longer carries the `external-` prefix, while the terminal's own card was re-keyed separately (see [session-matching](./session-matching.md) Priority 4.5). Both then live on as one agent with two cards.

The reap rule requires the card to carry provably zero unique information: **no `terminalId`, no `promptHistory`, no `totalToolCalls`, no `toolLog`, and a `cachedPid` that `pidToSession` registers to a *different* live session.** That last clause is what separates a duplicate from a legitimately terminal-less card — a lone discovered card owns its own pid registration and is left alone. `ENDED` cards are skipped entirely. Dropping goes through `dropDuplicateCard`, which releases the pid only if this card actually held the registration, then broadcasts `SESSION_REMOVED` so browsers drop the row too.

This is a deliberate, narrow exception to *"sessions are never auto-deleted"*: discovered cards are already excluded from the snapshot and are re-created within one scan interval if genuinely external, and a card meeting the rule above has no transcript, prompts, tools, or terminal to lose.

**Upgrade in place** — if a hook later fires for a discovered PID, `sessionMatcher` Priority 1.5 (cached-PID re-key) upgrades the `external-<pid>` card onto its real `sessionId` on the **first** real hook (any event type, not just `SessionStart`) so Priority 5 doesn't create a duplicate.

**Auto-end lifecycle** — a discovered card has a `cachedPid` and no terminal, so the existing process-liveness loop (`startMonitoring` in processMonitor) auto-ends it when the process dies — no dedicated teardown path.

### Workspace Metadata at Creation
- `createTerminalSession` applies `pinned`, `muted`, `alerted`, `accentColor`, `characterModel` from `config` at creation time (sessionStore.ts:1067-1071), plus `effortLevel` and `model` (1074-1075) so floating popups can inherit them before any hook sets `model`. Without this, metadata set via separate PUTs after creation would be missing from the first broadcast and a paired auto-save could overwrite the snapshot with stale values.
- Electron registers a PTY asynchronously after spawning it. If its hook wins that race, `createTerminalSession()` finds the existing session by `terminalId`, registers the terminal ID as an alias of the hook UUID, enriches it with SSH config/title/CLI metadata, clears `isExternal`, and broadcasts the updated canonical card with `replacesId: terminalId` instead of inserting a second `pty-*` card. That migration moves frontend selection and room membership off the temporary PTY ID.

### Session aliases
- `registerSessionAlias(oldId, newId)` records ID migrations. Workspace restore can form a chain such as saved `term-*` → newly spawned `term-*` → hook UUID.
- `resolveSessionId()` follows the complete chain through `followSessionAlias()` with a cycle guard. `getSession`, kill/archive/delete/source detection, and process lookup resolve to the canonical Map key before acting, so a stale card cannot target a dead key while leaving the real session alive.

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
- **Process-scan discovered sessions are excluded from the snapshot.** `saveSnapshot` skips every session whose key `startsWith('external-')` (sessionStore.ts:135) **and** their `pidToSession` entries (sessionStore.ts:146). These thin cards are pid-bound and ephemeral; persisting them would resurrect a phantom on restart (the PID is dead or OS-reused). The 20s discovery scan re-creates any still alive. **Hook-backed external sessions (Priority 5, real `sessionId`) are NOT excluded and DO persist** — only the `external-<pid>`-keyed cards are dropped.

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
- registerDiscoveredSession(proc) (sessionStore.ts:1465) — creates a thin `external-<pid>` card for an OS-scan-discovered external Claude CLI; called by `startExternalDiscovery`. See *External Sessions (discovered / hook-only)*
- findActiveSessionByConfig() — deduplicates by config (host, workDir, command, sessionTitle)
- getSessionByTerminalId() (sessionStore.ts:957) — resolves a session from its `terminalId`; used for fork parent resolution (`floatingSessionSpawner.ts:165`)
- clearAllSessions() — removes all sessions, captures terminal output buffers for replay; returns `{ removed: number, savedOutputs: SavedTerminalOutput[] }` (sessionStore.ts:1183-1223) where each `savedOutputs` entry is keyed by `title\0workDir` (the raw `sshConfig.workingDir`, falling back to `projectPath`) for replay after workspace import
- detectSessionSource(sessionId) (sessionStore.ts:1397) — classifies a session's spawn source (returns `session.source`, defaulting to `'ssh'`; `'unknown'` when the session is not found); used by kill flow
- findClaudeProcess(sessionId, projectPath) (sessionStore.ts:1404) — wrapper around processMonitor's resolver; passes internal `sessions` + `pidToSession` state
- killSession() / deleteSessionFromMemory() — end or remove sessions. `killSession()` closes **both** `session.terminalId` and `session.opsTerminalId` (nulling the latter) before flipping the card to `ENDED`, then releases/transfers the cached PID. The ops shell close is not optional bookkeeping: it is a bare login shell that outlives the agent, so skipping it orphans a live PTY that keeps holding terminal budget (see [Terminal/SSH](terminal-ssh.md) → Limits).
- resumeSession() / reconnectSessionTerminal() / reconnectOpsTerminal() — resume/reconnect workflows
- setSessionTitle / setSessionPinned / setSessionMuted / setSessionAlerted / setSessionAccentColor / setSessionCharacterModel — session metadata setters. `setSessionTitle` mutates the in-memory session **and** persists to SQLite via `dbUpdateTitle` (it does not broadcast on its own; the title rides the next `SESSION_UPDATE`, and the originating browser updates optimistically).
- archiveSession() / setSummary() — persistence helpers
- linkTerminalToSession() / updateQueueCount() — terminal/queue integration
- registerSessionAlias() — maps old session IDs to new ones
- resolveSessionId() — follows multi-hop aliases to the current Map key
- getSessionsForRespawn() — returns sessions eligible for workspace respawn
- pushEvent() / getEventsSince() / getEventSeq() — event ring buffer API
- saveSnapshot() / loadSnapshot() — periodic persistence to `SNAPSHOT_DIR` (see Snapshot Persistence)
- startPeriodicSave() / stopPeriodicSave() — snapshot interval management

### Ended Session Retention
- Kept in memory, broadcast to browsers, persisted to IndexedDB

## Dependencies & Connections

### Depends On
- [Hook System](./hook-system.md) — receives processed hook events
- [Session Matching](./session-matching.md) — delegates hook-to-session linking; Priority 5 marks hook-only external sessions (`isExternal`), Priority 1.5 upgrades `external-<pid>` discovered cards in place on first hook
- [Approval Detection](./approval-detection.md) — manages approval state transitions
- [Team & Subagent Tracking](./team-subagent.md) — manages team/subagent relationships
- [Process Monitor](./process-monitor.md) — monitors PID liveness (auto-ends discovered external cards) and runs the external-session discovery scan (`startExternalDiscovery`, feeding `registerDiscoveredSession`)

### Depended On By
- [WebSocket Manager](./websocket-manager.md) — broadcasts session state changes
- [API Endpoints](./api-endpoints.md) — reads/writes session data
- [Database](./database.md) — persists session state on key events
- [Floating Session Spawner](./floating-session-spawner.md) — calls `createTerminalSession` (with `isFork`/`isFloating`/`originSessionId`) to spawn floating sessions

### Shared Resources
- sessions Map
- eventBuffer ring
- snapshot file

### In-memory text caps (`server/sessionTrim.ts`)

Entry-count caps alone never bounded memory — the *contents* were unbounded. Measured on a live instance: 49 sessions serialized to 1.74 MB, but a single session was **1,120,984 bytes**, of which `promptHistory` was 1,062,567 across 50 entries (~21 KB per prompt, from pasting files into prompts). Applying the caps to that same live data: **1,935,655 → 683,546 bytes (−65%)**; the worst session **1,120,984 → 271,085 (−76%)**.

- `MAX_PROMPT_CHARS = 16_000` — per-entry cap; longer text is truncated with `TRUNCATION_MARKER`.
- `MAX_PROMPT_HISTORY_CHARS = 200_000` — total budget for `promptHistory`; oldest entries drop first. The newest prompt is never dropped.
- `MAX_CURRENT_PROMPT_CHARS = 2_000` — `currentPrompt` is display-only (the 3D robot bubble truncates to 60 chars) but rides on **every** session broadcast, so an unbounded copy cost WebSocket bandwidth too.
- `toArchivedSession(session)` builds `previousSessions` entries carrying only `sessionId`, `startedAt`, `endedAt`, `promptHistory` — see [Archived sessions](#archived-sessions) below.

**Truncation is recoverable, and the ordering is what makes it so.** `db.insertFullPrompt()` writes the FULL prompt to SQLite *before* the trimmed entry is pushed. `upsertSession` later re-inserts prompts from the capped in-memory copy, and `insertPrompt` is `INSERT OR IGNORE` against `UNIQUE(session_id, timestamp)` — so the full row written first wins and the truncated re-insert is discarded. Both writes must use the **same timestamp** or the dedup key misses and you store two rows. ConversationView independently prefers the Claude Code JSONL transcript for untruncated fidelity.

The DB-restore path (`dbGetPrompts` on SessionStart) replays through `pushPrompt` rather than assigning `slice(-50)` directly — DB rows are full length and would otherwise reintroduce exactly the history the caps exist to bound.

### Archived sessions

`ArchivedSession` (`src/types/session.ts`) carries **only** `sessionId`, `startedAt`, `endedAt`, `promptHistory`. It previously also deep-copied `toolLog`, `responseLog`, `events`, `toolUsage` and `totalToolCalls` — written at three call sites (`resumeSession`, `reconnectSessionTerminal`, `reKeyResumedSession`) and read at **none**: ~46 KB of the ~65 KB measured per archived entry, kept five deep per session. The only consumers are ConversationView's `PrevSessionSection` (renders `startedAt`/`endedAt`/`promptHistory`) and `workspaceSnapshot` (reads `sessionId`).

All three sites go through `toArchivedSession()`. Note the re-key site overrides `sessionId` with the OLD id, since the session's own `sessionId` has not been rewritten yet.

## Change Risks
- **Adding a field to `ArchivedSession` without adding a consumer reintroduces the bloat** it was slimmed to remove. Same for anything stored per-prompt: cap it in `sessionTrim.ts`.
- **`db.insertFullPrompt()` must stay ahead of `pushPrompt()`** and share its timestamp. Reorder them and SQLite silently keeps the *truncated* text, making the truncation unrecoverable.
- This is the most critical module
- Changes to state transitions affect 3D animations, sound system, and approval detection
- Modifying the session object schema affects ALL consumers (frontend stores, DB persistence, WebSocket protocol)
- Breaking snapshot persistence means sessions lost on restart
- **Fork-aware kill cascade** — the API skips fallback process lookup for forks because forks share the origin session's `projectPath`; cwd matching could target the origin. Forks instead rely on exact managed-PTY teardown, whose server and Electron implementations reap the PTY shell's child process groups before killing the shell. Preserve this branch when modifying kill behavior.
- **Ops-shell teardown parity** — `killSession()`, `DELETE /api/sessions/:id` and `clearAllSessions()` must all close `opsTerminalId`. A new teardown path that closes only `terminalId` leaks one live shell per session, which surfaces much later as a premature "Session limit reached" on session creation rather than as an obvious failure.
- **Shared Codex PID isolation** — several independent Codex thread cards may carry one host PID. A per-card kill must never signal that PID when siblings are live: close the card's exact managed terminal, or reject the operation when no managed terminal exists.
- Alias-aware mutations must resolve once to the canonical Map key. One-hop reads are insufficient after workspace restore because saved and fresh terminal IDs can form a two-hop chain before the hook UUID.
- **Never persist `external-<pid>` discovered cards** — `saveSnapshot`'s `startsWith('external-')` skip (both the sessions loop and the `pidToSession` loop) is load-bearing: these cards are pid-bound, so restoring one resurrects a phantom against a dead or OS-reused PID. If you change the discovered-card key prefix or the snapshot filter, keep them in sync, and do NOT extend the skip to hook-backed external sessions (real `sessionId`), which must persist.
- **Clone/fork auto-rename vs title-based dedup** — once a clone/fork is re-titled from its first prompt (see *Session Title Generation*), `session.title` no longer equals the `sessionTitle` baked into its workspace-snapshot config. `findActiveSessionByConfig` deduplicates partly by `sessionTitle`, so a server-restart workspace reload that relies on the title branch could create a duplicate card. This is mitigated because the `originalSessionId` match path is preferred and title-independent; keep that path intact if you touch dedup.
