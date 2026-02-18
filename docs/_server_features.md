# AI Agent Session Center — Server Features Reference

---

## 1. Platform Overview

The AI Agent Session Center is a localhost dashboard (default port **3333**) that monitors active AI coding agent sessions in real time. Hook scripts installed into the AI CLI capture lifecycle events, relay them via a file-based message queue, and the server pushes updates to all connected browsers over WebSocket.

### Tech Stack

| Layer | Technology | Version / Notes |
|---|---|---|
| Runtime | Node.js | 18+ (ESM modules) |
| HTTP framework | Express | 5 |
| WebSocket | ws | 8 |
| PTY / terminal | node-pty | native bindings |
| Database | better-sqlite3 | WAL mode |
| Hook delivery | Bash → JSONL queue file | POSIX atomic append |
| Frontend (legacy) | Vanilla JS + CSS | Import maps, no build step |
| Frontend (new) | React 19 + TypeScript + Vite | Served from dist/client |
| Port | 3333 | Configurable |

### Top-Level Architecture

```
AI CLI (Claude / Gemini / Codex)
         │  Hook script fires on each event
         ▼
   dashboard-hook.sh
   ├── Reads stdin JSON
   ├── Enriches with: PID, TTY, TERM_PROGRAM, tab IDs, team env vars
   ├── Single jq pass (~2-5ms)
   └── Appends to /tmp/claude-session-center/queue.jsonl  (~0.1ms)
         │  (HTTP POST fallback if MQ dir absent)
         ▼
   mqReader.js
   ├── fs.watch() + 10ms debounce (instant notification)
   ├── 500ms fallback poll
   ├── 5s health check (detects silent fs.watch failures)
   └── Reads from last byte offset (no re-reading)
         │
         ▼
   hookProcessor.js
   ├── Validates payload (session_id, event type, PID)
   ├── Calls sessionStore.handleEvent()
   ├── Records stats (latency, processing time)
   └── Broadcasts to WebSocket clients
         │
         ▼
   sessionStore.js (coordinator)
   ├── sessionMatcher  → link hook to session (5-priority system)
   ├── approvalDetector → tool approval timeout timers
   ├── teamManager     → subagent team tracking
   ├── processMonitor  → PID liveness checks
   └── autoIdleManager → idle transition timers
         │
         ▼
   wsManager.js
   └── Broadcasts session_update to all connected browsers
         │
         ▼
   Browser (React / Vanilla JS)
   └── IndexedDB + UI rendering
```

### Latency Budget

| Stage | Typical | Notes |
|---|---|---|
| jq enrichment | 2-5 ms | Single jq invocation |
| File append | ~0.1 ms | POSIX atomic for writes < 4096 bytes |
| fs.watch + debounce | 0-10 ms | Instant on macOS/Linux |
| Server processing | ~0.5 ms | handleEvent + broadcast |
| **Total end-to-end** | **3-17 ms** | Hook fired → browser updated |

---

## 2. Hook Delivery Pipeline

### 2.1 Bash Hook Script (`hooks/dashboard-hook.sh`)

The hook script is copied to `~/.claude/hooks/dashboard-hook.sh` and registered in `~/.claude/settings.json`. It runs synchronously to read stdin, then forks a background subshell immediately (`} &>/dev/null &`) so the Claude process is never blocked.

**Execution flow:**

1. Capture `SENT_AT=$(date +%s)` and `INPUT=$(cat)` synchronously
2. Fork background subshell (`{ ... } &>/dev/null &; disown`)
3. In background: TTY detection (cached per PID in `/tmp/claude-tty-cache/$PPID`)
4. Single `jq -c` pass to enrich and extract fields
5. Tab title update (only on state-changing events: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`, `Notification`, `SessionEnd`)
6. Deliver: append to `/tmp/claude-session-center/queue.jsonl` if MQ dir exists; otherwise HTTP POST to `http://localhost:3333/api/hooks`

**Fields enriched by jq:**

| Field | Source | Description |
|---|---|---|
| `claude_pid` | `$PPID` | Claude process PID |
| `hook_sent_at` | `date +%s * 1000` | Timestamp in ms for latency tracking |
| `tty_path` | `ps -o tty= -p $PPID` | Full TTY path (e.g. `/dev/ttys003`) |
| `term_program` | `$TERM_PROGRAM` | Terminal app name |
| `term_program_version` | `$TERM_PROGRAM_VERSION` | Terminal version |
| `vscode_pid` | `$VSCODE_PID` | VS Code extension host PID |
| `term` | `$TERM` | TERM env variable |
| `tab_id` | `$ITERM_SESSION_ID`, `$KITTY_WINDOW_ID`, `$WARP_SESSION_ID`, `$WEZTERM_PANE`, `$TERM_SESSION_ID` | Tab/session identifier |
| `window_id` | `$WINDOWID` | X11 window ID |
| `tmux` | `$TMUX`, `$TMUX_PANE` | `{session, pane}` or null |
| `is_ghostty` | `$GHOSTTY_RESOURCES_DIR` | Boolean flag |
| `kitty_pid` | `$KITTY_PID` | Kitty process PID |
| `agent_terminal_id` | `$AGENT_MANAGER_TERMINAL_ID` | PTY terminal ID injected by sshManager |
| `claude_project_dir` | `$CLAUDE_PROJECT_DIR` | Claude's project directory |
| `parent_session_id` | `$CLAUDE_CODE_PARENT_SESSION_ID` | Parent session for subagent linking |
| `team_name` | `$CLAUDE_CODE_TEAM_NAME` | Team name for multi-agent |
| `agent_name` | `$CLAUDE_CODE_AGENT_NAME` | Agent name (e.g. `backend-engineer`) |
| `agent_type` | `$CLAUDE_CODE_AGENT_TYPE` | Agent type (e.g. `task`) |
| `agent_id` | `$CLAUDE_CODE_AGENT_ID` | Agent UUID |
| `agent_color` | `$CLAUDE_CODE_AGENT_COLOR` | Agent accent color |

**TTY caching:** Cached per PPID in `/tmp/claude-tty-cache/$PPID` to avoid running `ps` on every hook event.

### 2.2 MQ Reader (`server/mqReader.js`)

```
Queue file: /tmp/claude-session-center/queue.jsonl
           (Windows: %TEMP%\claude-session-center\queue.jsonl)
```

| Parameter | Value |
|---|---|
| Poll interval (fallback) | 500 ms |
| fs.watch debounce | 10 ms |
| Health check interval | 5000 ms |
| Truncation threshold | 1 MB |

**Read algorithm:**
1. `fs.watch()` fires → `scheduleRead()` (debounced 10ms)
2. Open file, get `fstat` size
3. If `fileSize < lastByteOffset`: external truncation detected, reset offset to 0
4. `readSync()` from `lastByteOffset` to `fileSize`
5. Split on `\n`, retain partial trailing line in `partialLine` buffer
6. Parse each complete JSON line → `processHookEvent()`
7. Advance `lastByteOffset` by bytes consumed (minus partial)
8. If `lastByteOffset > 1MB` and no partial: truncate file (write remaining partial back, reset offset)

**Snapshot resume:** On startup the reader accepts `resumeOffset` from a saved snapshot to continue from where it left off without reprocessing events.

**Stats tracked:** `linesProcessed`, `linesErrored`, `truncations`, `lastProcessedAt`, `startedAt`, `currentOffset`, `hasPartialLine`.

### 2.3 Hook Validation (`server/hookProcessor.js`)

Every hook (from HTTP or MQ) passes through `validateHookPayload()`:

| Field | Requirement |
|---|---|
| `session_id` | Required, string, max 256 chars |
| `hook_event_name` | Required, must be in `KNOWN_EVENTS` set |
| `claude_pid` | Optional, must be positive integer if present |
| `timestamp` | Optional, must be valid number if present |

Unknown event types are rejected with `"unknown event type: ..."`. Invalid payloads are logged and not processed.

### 2.4 HTTP Fallback (`server/hookRouter.js`)

When the MQ directory does not exist (server not yet started), the hook script falls back to:
```
POST http://localhost:3333/api/hooks
Content-Type: application/json
--connect-timeout 1 -m 3
```

Rate limit: **100 requests/second per IP** (enforced by `hookRateLimitMiddleware`).

---

## 3. Hook Events and Density Levels

### 3.1 Claude Code Events (14 total)

| Event | Constant | When It Fires |
|---|---|---|
| `SessionStart` | `EVENT_TYPES.SESSION_START` | Claude process starts |
| `UserPromptSubmit` | `EVENT_TYPES.USER_PROMPT_SUBMIT` | User submits a prompt |
| `PreToolUse` | `EVENT_TYPES.PRE_TOOL_USE` | Before a tool call executes |
| `PostToolUse` | `EVENT_TYPES.POST_TOOL_USE` | After a tool call succeeds |
| `PostToolUseFailure` | `EVENT_TYPES.POST_TOOL_USE_FAILURE` | After a tool call fails |
| `PermissionRequest` | `EVENT_TYPES.PERMISSION_REQUEST` | Claude needs user approval |
| `Stop` | `EVENT_TYPES.STOP` | Claude finishes its turn |
| `Notification` | `EVENT_TYPES.NOTIFICATION` | System notification |
| `SubagentStart` | `EVENT_TYPES.SUBAGENT_START` | Subagent spawned |
| `SubagentStop` | `EVENT_TYPES.SUBAGENT_STOP` | Subagent finished |
| `TeammateIdle` | `EVENT_TYPES.TEAMMATE_IDLE` | A teammate is idle (high density only) |
| `TaskCompleted` | `EVENT_TYPES.TASK_COMPLETED` | A task was completed |
| `PreCompact` | `EVENT_TYPES.PRE_COMPACT` | Context compaction about to start (high only) |
| `SessionEnd` | `EVENT_TYPES.SESSION_END` | Claude process exits |

### 3.2 Gemini CLI Events (7 total)

| Event | When It Fires |
|---|---|
| `BeforeAgent` | Before agent turn |
| `BeforeTool` | Before tool call |
| `AfterTool` | After tool call |
| `AfterAgent` | After agent turn |
| (plus `SessionStart`, `SessionEnd`, `Notification` from Claude mapping) |

### 3.3 Codex Events (1 event)

| Event | When It Fires |
|---|---|
| `agent-turn-complete` | After Codex completes a turn |

### 3.4 Density Levels

| Level | Claude Events | Gemini Events | Notes |
|---|---|---|---|
| `high` | All 14 | 7 (`SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, `SessionEnd`, `Notification`) | Full monitoring |
| `medium` | 12 (excludes `TeammateIdle`, `PreCompact`) | 5 (`SessionStart`, `BeforeAgent`, `AfterAgent`, `SessionEnd`, `Notification`) | Default — good balance |
| `low` | 5 (`SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`, `SessionEnd`) | 3 (`SessionStart`, `AfterAgent`, `SessionEnd`) | Minimal overhead |

### 3.5 Hook Registration

Hooks are registered in `~/.claude/settings.json` under the `hooks` key. Each event gets a group entry:
```json
{
  "_source": "ai-agent-session-center",
  "hooks": [{ "type": "command", "command": "~/.claude/hooks/dashboard-hook.sh", "async": true }]
}
```

Registration uses **atomic writes** (write to `.tmp.XXXX`, then `rename()`) to prevent corrupting `settings.json`. The installer checks for existing hooks before adding to avoid duplicates. Hooks are re-synced on every server startup if the script content has changed.

---

## 4. Session State Machine

### 4.1 States

| Status | Constant | Animation | Description |
|---|---|---|---|
| `idle` | `SESSION_STATUS.IDLE` | `Idle` | No activity |
| `prompting` | `SESSION_STATUS.PROMPTING` | `Walking` + `Wave` emote | User prompt submitted |
| `working` | `SESSION_STATUS.WORKING` | `Running` | Tool in progress |
| `approval` | `SESSION_STATUS.APPROVAL` | `Waiting` | Needs user approval for a tool |
| `input` | `SESSION_STATUS.INPUT` | `Waiting` | Waiting for user answer (AskUserQuestion etc.) |
| `waiting` | `SESSION_STATUS.WAITING` | `Waiting` + `ThumbsUp` emote | Turn finished, ready for next prompt |
| `ended` | `SESSION_STATUS.ENDED` | `Death` | Session ended |
| `connecting` | `SESSION_STATUS.CONNECTING` | `Walking` + `Wave` emote | SSH terminal connecting |

**Heavy work variant:** If `totalToolCalls > 10` at `Stop` time, the animation switches to `Dance` instead of `Waiting+ThumbsUp`.

### 4.2 State Transitions

```
SessionStart       → idle
UserPromptSubmit   → prompting  (Walking + Wave)
PreToolUse         → working    (Running)
PostToolUse        → working    (stays Running)
[timer expires]    → approval   (Waiting) — tool approval heuristic
PermissionRequest  → approval   (Waiting) — direct signal
[timer expires for userInput tools] → input (Waiting)
Stop               → waiting    (Waiting + ThumbsUp / Dance)
[2 min idle]       → idle       (auto-idle)
SessionEnd         → ended      (Death)
[10s after ended]  → deleted from memory (non-SSH)
```

### 4.3 Auto-Idle Timeouts

| Status | Timeout | Transitions To |
|---|---|---|
| `prompting` | 30,000 ms (30 s) | `waiting` |
| `waiting` | 120,000 ms (2 min) | `idle` |
| `working` | 180,000 ms (3 min) | `idle` |
| `approval` | 600,000 ms (10 min) | `idle` (safety net) |
| `input` | 600,000 ms (10 min) | `idle` (safety net) |

Auto-idle is checked every **10 seconds** by `autoIdleManager.js`.

### 4.4 Session Object Fields

Every session in memory (`Map<string, Session>`) contains:

| Field | Type | Description |
|---|---|---|
| `sessionId` | string | Claude-assigned UUID or terminal ID |
| `projectPath` | string | Working directory (full path) |
| `projectName` | string | Last segment of projectPath |
| `title` | string | Auto-generated or user-set title |
| `status` | string | Current status (see table above) |
| `animationState` | string | `Idle`, `Walking`, `Running`, `Waiting`, `Death`, `Dance` |
| `emote` | string\|null | `Wave`, `ThumbsUp`, `Jump`, `Yes` or null |
| `startedAt` | number | Unix ms timestamp |
| `lastActivityAt` | number | Unix ms timestamp of last event |
| `endedAt` | number\|null | Unix ms timestamp or null |
| `currentPrompt` | string | Current/last prompt text |
| `promptHistory` | array | Last 50 prompts: `{text, timestamp}` |
| `toolUsage` | object | `{toolName: count}` map |
| `totalToolCalls` | number | Total tool calls this turn (reset at `Stop`) |
| `toolLog` | array | Last 200 tool entries: `{tool, input, timestamp, failed?, error?}` |
| `responseLog` | array | Last 50 response excerpts: `{text, timestamp}` (first 2000 chars each) |
| `events` | array | Last 50 lifecycle events: `{type, detail, timestamp}` |
| `model` | string | AI model name (e.g. `claude-opus-4-6`) |
| `subagentCount` | number | Currently active subagents |
| `archived` | number | 0 or 1 |
| `source` | string | `ssh`, `vscode`, `iterm`, `warp`, `terminal`, etc. |
| `pendingTool` | string\|null | Tool awaiting approval |
| `pendingToolDetail` | string\|null | Summary of pending tool input |
| `waitingDetail` | string\|null | Human-readable approval message |
| `cachedPid` | number\|null | Claude process PID |
| `queueCount` | number | Pending prompt queue count |
| `terminalId` | string\|null | Active PTY terminal ID |
| `lastTerminalId` | string\|null | Previous terminal ID (for resume) |
| `sshHost` | string | SSH host |
| `sshCommand` | string | Command run in terminal |
| `sshConfig` | object | `{host, port, username, authMethod, privateKeyPath, workingDir, command}` |
| `transcriptPath` | string | Claude transcript file path |
| `permissionMode` | string\|null | Claude permission mode |
| `teamId` | string\|null | Team this session belongs to |
| `teamRole` | string\|null | `leader` or `member` |
| `agentName` | string\|null | Agent name (multi-agent) |
| `agentType` | string\|null | Agent type |
| `agentColor` | string\|null | Agent accent color |
| `tmuxPaneId` | string\|null | Tmux pane ID (e.g. `%5`) |
| `isHistorical` | boolean | SSH session archived after end |
| `previousSessions` | array | Up to 5 previous session snapshots (for resume history) |
| `replacesId` | string | One-time field set during session re-key |
| `label` | string | User-assigned label |
| `summary` | string | AI-generated summary |
| `accentColor` | string | Custom accent color |
| `characterModel` | string | 3D character model override |

### 4.5 Event Ring Buffer

The server maintains a ring buffer of the last **500 events** for WebSocket reconnect replay:

```js
const EVENT_BUFFER_MAX = 500;
// Each entry: { seq: number, type: string, data: any, timestamp: number }
```

On reconnect, the client sends `{ type: "replay", sinceSeq: N }` and the server replays all events with `seq > N`.

### 4.6 Snapshot Persistence

Sessions are saved to `/tmp/claude-session-center/sessions-snapshot.json` every **10 seconds** using atomic write (tmp file + rename). The snapshot includes:

- All session objects
- `projectSessionCounters` Map
- `pidToSession` Map
- `pendingResume` Map
- `eventSeq` (ring buffer sequence number)
- `mqOffset` (byte offset in queue file)

On startup, the snapshot is loaded and PID liveness is checked. Dead PIDs result in sessions marked `ended`. SSH sessions with orphaned processes (alive but unreachable after server restart) are sent `SIGTERM`. Non-SSH ended sessions are kept for 30 minutes to allow auto-linking on `claude --resume`.

### 4.7 Broadcast Debounce

Session updates are debounced within a **50ms window** to batch rapid state changes. Within a batch, only the latest `session_update` per `sessionId` is sent (deduplication).

---

## 5. Session Matching (5-Priority System)

When a hook event arrives with an unknown `session_id`, the matcher (`server/sessionMatcher.js`) tries the following priorities:

| Priority | Strategy | Match Condition | Risk |
|---|---|---|---|
| 0 | `pendingResume` + terminal ID | `agent_terminal_id` matches a pending resume entry | Low — explicit user action |
| 0 (fallback) | `pendingResume` + workDir | Exactly one pending resume has matching `projectPath` | Medium — ambiguous if multiple |
| 0.5 | Snapshot-restored ended session | One ended session with `ServerRestart` event matches `cwd` (within 30 min) | Low — post-restart linking |
| 1 | `agent_terminal_id` env var | SSH terminal injected `AGENT_MANAGER_TERMINAL_ID` into PTY env | Low — direct match |
| 2 | `tryLinkByWorkDir` | `pendingLinks` Map has entry for the hook's `cwd` | Medium — two sessions in same dir |
| 3 | Path scan (connecting sessions) | Exactly one `connecting` session has matching `projectPath` | Medium — ambiguous if multiple |
| 4 | PID parent check | Claude's PID is a child of a known PTY process (`ps -o ppid=`) | High — unreliable across shells |

If no match is found, a **display-only card** is created with the detected terminal source.

### Session Source Detection

The `detectHookSource()` function maps environment variables to source labels:

| Source | Detection |
|---|---|
| `vscode` | `$VSCODE_PID` present, or `TERM_PROGRAM` contains `vscode`/`code` |
| `jetbrains` | `TERM_PROGRAM` contains `jetbrains`, `intellij`, `idea`, `webstorm`, etc. |
| `iterm` | `TERM_PROGRAM` contains `iterm` |
| `warp` | `TERM_PROGRAM` contains `warp` |
| `kitty` | `TERM_PROGRAM` contains `kitty` |
| `ghostty` | `TERM_PROGRAM` contains `ghostty` or `$GHOSTTY_RESOURCES_DIR` set |
| `alacritty` | `TERM_PROGRAM` contains `alacritty` |
| `wezterm` | `TERM_PROGRAM` contains `wezterm` or `$WEZTERM_PANE` set |
| `hyper` | `TERM_PROGRAM` contains `hyper` |
| `terminal` | `TERM_PROGRAM` is `apple_terminal` |
| `tmux` | `$TMUX` is set |
| `unknown` | No matching env var |

### Session Re-keying

When a resumed session is matched, `reKeyResumedSession()` transfers data from the old session key to the new `session_id`:
- Deletes old Map entry
- Resets `status`, `animationState`, `emote`, `startedAt`, `totalToolCalls`, `toolUsage`, `promptHistory`, `toolLog`, `responseLog`, `events`
- Preserves `previousSessions` array (history chain)
- Sets `replacesId` for DB migration
- Inserts under new `session_id`

---

## 6. Approval Detection

### 6.1 Timeout Heuristic

When `PreToolUse` fires, `startApprovalTimer()` sets a category-based timer:

| Category | Tools | Timeout | Status Set |
|---|---|---|---|
| `fast` | `Read`, `Write`, `Edit`, `Grep`, `Glob`, `NotebookEdit` | 3,000 ms | `approval` |
| `userInput` | `AskUserQuestion`, `EnterPlanMode`, `ExitPlanMode` | 3,000 ms | `input` |
| `medium` | `WebFetch`, `WebSearch` | 15,000 ms | `approval` |
| `slow` | `Bash`, `Task` | 8,000 ms | `approval` |

Tools not in any category get no timer. The timer is cleared immediately when `PostToolUse` or `PostToolUseFailure` arrives.

**Waiting detail labels:**

| Status | Label format |
|---|---|
| `approval` | `"Approve {toolName}: {inputSummary}"` or `"Approve {toolName}"` |
| `input` (`AskUserQuestion`) | `"Waiting for your answer"` |
| `input` (`EnterPlanMode`) | `"Review plan mode request"` |
| `input` (`ExitPlanMode`) | `"Review plan"` |

### 6.2 `hasChildProcesses` Check

For `slow` category tools (Bash, Task), before setting `approval` status, the server checks if the cached PID still has child processes via:
```bash
pgrep -P {pid}
```
If child processes exist, the command is still running (not waiting for approval) and the status transition is skipped.

### 6.3 `PermissionRequest` Direct Signal

When the `PermissionRequest` hook event fires (at medium+ density), the heuristic timer is immediately cleared and the session transitions directly to `approval` status. This is more reliable than the timeout approach.

### 6.4 Timer Management

All pending timers are stored in a `Map<sessionId, timeoutHandle>`. A new timer for the same session replaces any existing one. All timers are cleared on:
- `PostToolUse`
- `PostToolUseFailure`
- `PermissionRequest`
- `Stop`
- `SessionEnd`
- Process liveness check (dead process)

---

## 7. Team and Subagent Tracking

### 7.1 Auto-Detection (Path-Based)

When `SubagentStart` fires on a parent session, `addPendingSubagent()` records `{parentSessionId, parentCwd, agentType, timestamp}`. When a new `SessionStart` arrives within **10 seconds** from a child session whose `cwd` matches (exact or parent/child path relationship), the sessions are linked into a team.

Stale entries older than **30 seconds** are pruned from the pending list.

### 7.2 Direct Linking (Priority 0)

When the `CLAUDE_CODE_PARENT_SESSION_ID` env var is set, `linkByParentSessionId()` directly links the child to its parent without path guessing. This is the preferred mechanism.

### 7.3 Team Object

```js
{
  teamId: "team-{parentSessionId}",
  parentSessionId: string,
  childSessionIds: Set<string>,
  teamName: string,  // "{projectName} Team" or from env var
  createdAt: number
}
```

**Serialized form** (for WebSocket) converts `childSessionIds` Set to array.

### 7.4 Team Config Reader

Team configurations can be stored in `~/.claude/teams/{teamName}/config.json`:
```json
{
  "members": {
    "backend-engineer": {
      "tmuxPaneId": "%3",
      "backendType": "node",
      "color": "#00ff88"
    }
  }
}
```

The team name is sanitized (only `a-zA-Z0-9_-. `) before constructing the file path (path traversal prevention). If the config is found, the member's `tmuxPaneId`, `backendType`, and `agentColor` are applied to the child session.

### 7.5 Team Cleanup

When a team member session ends, `handleTeamMemberEnd()` removes it from the team's `childSessionIds`. If the **parent** ends and all children are also ended, the team is deleted after a **15-second** delay.

---

## 8. SSH/PTY Terminal Management

### 8.1 Terminal Modes

| Mode | How | When |
|---|---|---|
| Local direct | `node-pty` spawns `$SHELL` | `host` is `localhost`/`127.0.0.1`/`::1` |
| Remote SSH | `node-pty` spawns `ssh -t -i keyfile user@host` | Remote host |
| Tmux attach | Shell runs `tmux attach -t '{session}'` | `tmuxSession` parameter provided |
| Tmux new | Shell runs `tmux new-session -s 'claude-{id}' '{command}'` | `useTmux: true` |

### 8.2 PTY Spawn Parameters

```js
pty.spawn(shell, args, {
  name: 'xterm-256color',
  cols: 120,
  rows: 40,
  cwd,            // workDir for local; homedir() for remote
  env: {
    ...process.env,
    AGENT_MANAGER_TERMINAL_ID: terminalId,
    // ANTHROPIC_API_KEY / GEMINI_API_KEY / OPENAI_API_KEY if apiKey provided
  }
})
```

Terminal IDs use the format: `term-{Date.now()}-{random6chars}`
Tmux terminal IDs: `term-tmux-{Date.now()}-{random6chars}`

### 8.3 Shell-Ready Detection

Before sending the launch command, the server waits for the shell to display a prompt. The detection algorithm:

1. Buffer PTY output (capped at 4096 bytes)
2. Strip ANSI escape sequences (`CSI` + `OSC` patterns)
3. After 100ms of silence (settle timer), check if the last non-empty line ends with `[#$%>]\s*$` and is shorter than 200 chars
4. Resolve `true` (prompt detected) or `false` (timeout)

| Timeout | Local | Remote SSH |
|---|---|---|
| Shell-ready wait | 5,000 ms | 15,000 ms |

On timeout, the command is sent anyway with a warning log.

### 8.4 Output Ring Buffer

Each terminal maintains an output ring buffer capped at **128 KB** (128 × 1024 bytes). When a new WebSocket client subscribes, the full buffer is replayed so the client sees previous terminal output.

### 8.5 Pending Links

When `createTerminal()` is called, a `pendingLinks` entry is registered: `workDir → {terminalId, host, createdAt}`. This is used by the session matcher (Priority 2) to link the first `SessionStart` hook from that directory to the correct terminal session.

Pending links expire after **60 seconds** (cleaned up every 30s).

### 8.6 Input Validation

All inputs to `createTerminal()` are validated against injection patterns. The shell metacharacter regex is: `/[;|&$\`\\!><()\n\r{}[\]]/`

| Parameter | Validation |
|---|---|
| `workingDir` | Max 1024 chars, no shell metacharacters (after stripping leading `~`) |
| `command` | Max 512 chars, no shell metacharacters |
| `tmuxSession` | Max 128 chars, only `[a-zA-Z0-9_.\-]` |
| `host` | Max 255 chars, no shell metacharacters |
| `username` | Max 128 chars, only `[a-zA-Z0-9_.\-]` |
| `port` | Integer 1–65535 |

API keys are passed via the PTY `env` object, never interpolated into shell command strings.

### 8.7 Terminal Limits

Maximum **10 terminals** open simultaneously (enforced at `POST /api/terminals` and `POST /api/teams/:id/members/:sessionId/terminal`).

---

## 9. WebSocket Protocol

### 9.1 Connection Lifecycle

1. Client connects to `ws://localhost:3333`
2. If password enabled: token validated via cookie, Authorization header, or `?token=` query param; rejected with code `4001` if invalid
3. Server sends `snapshot` message with all current sessions, teams, and event sequence number
4. Client sends `replay` request if it has a previous sequence number (reconnect case)
5. Heartbeat: server pings every **30 seconds**, terminates unresponsive clients (no pong within **10 seconds**)

### 9.2 Server → Client Messages

| Type | Payload | When Sent |
|---|---|---|
| `snapshot` | `{sessions, teams, seq}` | On initial connection |
| `session_update` | `{session, team?}` | Any session state change |
| `session_removed` | `{sessionId}` | Session deleted via API |
| `team_update` | `{team}` | Team membership change |
| `hook_stats` | `{stats}` | After each hook event (throttled to 1/sec) |
| `terminal_output` | `{terminalId, data: base64}` | PTY output |
| `terminal_ready` | `{terminalId}` | PTY spawned and ready |
| `terminal_closed` | `{terminalId, reason}` | PTY process exited |
| `clearBrowserDb` | — | Full reset requested via API |
| `replay` | event objects | Missed events on reconnect |

### 9.3 Client → Server Messages

| Type | Payload | Action |
|---|---|---|
| `terminal_input` | `{terminalId, data}` | Write to PTY stdin |
| `terminal_resize` | `{terminalId, cols, rows}` | Resize PTY |
| `terminal_disconnect` | `{terminalId}` | Close PTY |
| `terminal_subscribe` | `{terminalId}` | Register WebSocket for terminal output relay + replay buffer |
| `update_queue_count` | `{sessionId, count}` | Update session queue count |
| `replay` | `{sinceSeq}` | Request missed events since sequence number |

### 9.4 Backpressure

For non-critical messages (only `hook_stats`), the server checks `client.bufferedAmount`. If it exceeds **1 MB**, the message is dropped for that client.

### 9.5 Hook Stats Throttle

`hook_stats` broadcasts are throttled to a maximum of **once per second** per client. If a stats update arrives while the throttle window is active, it is stored as `pendingHookStats` and sent when the window expires.

---

## 10. REST API

All endpoints except auth and hook ingestion require authentication when `passwordHash` is configured. The auth middleware checks: cookie `auth_token`, then `Authorization: Bearer {token}`, then `?token=` query param.

### 10.1 Auth Endpoints (No Auth Required)

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/auth/status` | — | Returns `{passwordRequired, authenticated}` |
| `POST` | `/api/auth/login` | `{password}` | Returns `{success, token}`, sets `auth_token` cookie |
| `POST` | `/api/auth/logout` | — | Removes token, clears cookie |

### 10.2 Hook Ingestion (No Auth — Rate Limited)

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/hooks` | Hook JSON | Processes a hook event; rate limit 100/sec per IP |

### 10.3 Session Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/sessions` | — | Returns all in-memory sessions |
| `GET` | `/api/sessions/:id/source` | — | Returns `{source}` (vscode/terminal/etc.) |
| `PUT` | `/api/sessions/:id/title` | `{title}` | Update session title (max 500 chars) |
| `PUT` | `/api/sessions/:id/label` | `{label}` | Update session label |
| `PUT` | `/api/sessions/:id/accent-color` | `{color}` | Update accent color (max 50 chars) |
| `POST` | `/api/sessions/:id/kill` | `{confirm: true}` | Send SIGTERM (SIGKILL after 3s), archive session |
| `DELETE` | `/api/sessions/:id` | — | Permanently delete from memory, broadcast removal |
| `POST` | `/api/sessions/:id/resume` | — | Resume SSH session (`claude --resume {id} \|\| claude --continue`) |
| `POST` | `/api/sessions/:id/summarize` | `{context, promptTemplate?, custom_prompt?}` | Summarize via Claude CLI (`haiku` model), max 2 concurrent |

### 10.4 Terminal Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `POST` | `/api/terminals` | Connection config | Create PTY terminal (max 10 total) |
| `GET` | `/api/terminals` | — | List all active terminals |
| `DELETE` | `/api/terminals/:id` | — | Close and cleanup terminal |

**`POST /api/terminals` body fields:**
`host`, `port` (default 22), `username` (required), `password`, `privateKeyPath`, `authMethod` (default `key`), `workingDir` (default `~`), `command` (default `claude`), `apiKey`, `tmuxSession`, `useTmux`, `sessionTitle`, `label`

### 10.5 SSH Key and Tmux Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/ssh-keys` | — | List private keys from `~/.ssh/` |
| `POST` | `/api/tmux-sessions` | Connection config | List tmux sessions on host |

### 10.6 Team Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/teams/:teamId/config` | — | Read team config from `~/.claude/teams/{name}/config.json` |
| `POST` | `/api/teams/:teamId/members/:sessionId/terminal` | — | Attach to member's tmux pane (requires `tmuxPaneId` on session) |

### 10.7 Hook Management Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/hooks/status` | — | Current density and installed events |
| `POST` | `/api/hooks/install` | `{density}` | Install hooks at specified density |
| `POST` | `/api/hooks/uninstall` | — | Remove all dashboard hooks |

### 10.8 Database / History Endpoints

| Method | Path | Query Params | Description |
|---|---|---|---|
| `GET` | `/api/db/sessions` | `query`, `project`, `status`, `dateFrom`, `dateTo`, `archived`, `sortBy`, `sortDir`, `page`, `pageSize` | Search/list sessions from SQLite |
| `GET` | `/api/db/sessions/:id` | — | Full session detail with prompts, responses, tool_calls, events, notes |
| `DELETE` | `/api/db/sessions/:id` | — | Cascade delete session and all child records |
| `GET` | `/api/db/projects` | — | Distinct projects |
| `GET` | `/api/db/search` | `query`, `type` (`all`/`prompts`/`responses`), `page`, `pageSize` | Full-text search across prompts and responses |
| `GET` | `/api/sessions/history` | `projectPath?` | Legacy endpoint; returns all or project sessions |

### 10.9 Notes Endpoints

| Method | Path | Body | Description |
|---|---|---|---|
| `GET` | `/api/db/sessions/:id/notes` | — | Get notes for session |
| `POST` | `/api/db/sessions/:id/notes` | `{text}` | Add note (max 10,000 chars) |
| `DELETE` | `/api/db/notes/:id` | — | Delete note by ID |

### 10.10 Analytics Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/db/analytics/summary` | Total sessions, active sessions, total prompts, total tool calls, most used tool, busiest project |
| `GET` | `/api/db/analytics/tools` | Tool breakdown with counts and percentages |
| `GET` | `/api/db/analytics/projects` | Active projects with session count and last activity |
| `GET` | `/api/db/analytics/heatmap` | Activity heatmap by `{day_of_week, hour, count}` |

### 10.11 Stats and Admin Endpoints

| Method | Path | Description |
|---|---|---|
| `GET` | `/api/hook-stats` | Hook performance statistics |
| `POST` | `/api/hook-stats/reset` | Reset hook stats |
| `GET` | `/api/mq-stats` | MQ reader stats (offset, linesProcessed, etc.) |
| `POST` | `/api/reset` | Broadcast `clearBrowserDb` to all clients |

### 10.12 Rate Limiting

In-memory sliding-window rate limiter (no external dependencies):

| Endpoint | Limit |
|---|---|
| `/api/hooks` | 100 requests/second per IP |
| `/api/sessions/:id/summarize` | 2 concurrent requests |
| `/api/terminals` (POST) | 10 terminals total |

Stale rate limit buckets are cleaned up every **30 seconds** (entries older than 5s).

---

## 11. Authentication

Authentication is optional. It is enabled when `passwordHash` is set in `data/server-config.json`.

### 11.1 Password Hashing

Uses Node.js `crypto.scryptSync`:

```
salt = randomBytes(16).toString('hex')   // 32 hex chars
hash = scryptSync(password, salt, 64).toString('hex')  // 128 hex chars
stored = "${salt}:${hash}"
```

Verification uses `crypto.timingSafeEqual` to prevent timing attacks. Passwords must be at least 4 characters (enforced by setup wizard).

### 11.2 Token Management

- Tokens are 32 random bytes encoded as hex (64 hex chars)
- TTL: **24 hours** (`TOKEN_TTL_MS = 24 * 60 * 60 * 1000`)
- Stored in-memory: `Map<token, {createdAt: number}>`
- Expired tokens are removed lazily on `validateToken()` check
- Periodic cleanup runs every **1 hour** to sweep all expired tokens

### 11.3 Token Extraction Priority

1. Cookie: `auth_token={token}`
2. HTTP header: `Authorization: Bearer {token}`
3. Query string: `?token={token}` (used for WebSocket connections)

### 11.4 Protected vs Unprotected Routes

| Routes | Auth Required |
|---|---|
| `/api/auth/*` | No |
| `/api/hooks` | No (hooks must work without login) |
| Static files | No (login page is part of SPA) |
| All other `/api/*` | Yes (if password enabled) |
| WebSocket | Yes (if password enabled); rejected with WS code `4001` |

Cookie is set with: `HttpOnly; SameSite=Strict; Path=/; Max-Age=86400`

---

## 12. SQLite Persistence

### 12.1 Database Location

```
data/sessions.db
```

Opened with **WAL mode** (`PRAGMA journal_mode = WAL`) for concurrent reads and writes.

### 12.2 Schema

**Table: `sessions`**

| Column | Type | Notes |
|---|---|---|
| `id` | TEXT PRIMARY KEY | Claude session UUID |
| `project_path` | TEXT | Full working directory |
| `project_name` | TEXT | Project display name |
| `title` | TEXT | Session title |
| `model` | TEXT | AI model name |
| `status` | TEXT | Final status |
| `source` | TEXT DEFAULT 'hook' | `hook`, `ssh`, `vscode`, etc. |
| `label` | TEXT | User-assigned label |
| `summary` | TEXT | AI-generated summary |
| `team_id` | TEXT | Team reference |
| `team_role` | TEXT | `leader` or `member` |
| `character_model` | TEXT | 3D character model override |
| `accent_color` | TEXT | Custom accent color |
| `started_at` | INTEGER | Unix ms |
| `ended_at` | INTEGER | Unix ms or null |
| `last_activity_at` | INTEGER | Unix ms |
| `total_prompts` | INTEGER DEFAULT 0 | |
| `total_tool_calls` | INTEGER DEFAULT 0 | |
| `archived` | INTEGER DEFAULT 0 | 0 or 1 |

**Indexes:** `project_path`, `status`, `started_at`, `last_activity_at`

**Table: `prompts`**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `session_id` | TEXT NOT NULL | FK → sessions.id |
| `text` | TEXT | Prompt text |
| `timestamp` | INTEGER | Unix ms |

**Unique index:** `(session_id, timestamp)` — deduplication on upsert.

**Table: `responses`**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `session_id` | TEXT NOT NULL | FK → sessions.id |
| `text_excerpt` | TEXT | First 2000 chars of response |
| `timestamp` | INTEGER | Unix ms |

**Unique index:** `(session_id, timestamp)`

**Table: `tool_calls`**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `session_id` | TEXT NOT NULL | FK → sessions.id |
| `tool_name` | TEXT | Tool name |
| `tool_input_summary` | TEXT | Summarized input |
| `timestamp` | INTEGER | Unix ms |

**Unique index:** `(session_id, timestamp, tool_name)`
**Additional index:** `tool_name` (for analytics queries)

**Table: `events`**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `session_id` | TEXT NOT NULL | FK → sessions.id |
| `event_type` | TEXT | Hook event name |
| `detail` | TEXT | Human-readable description |
| `timestamp` | INTEGER | Unix ms |

**Table: `notes`**

| Column | Type | Notes |
|---|---|---|
| `id` | INTEGER PK AUTOINCREMENT | |
| `session_id` | TEXT NOT NULL | FK → sessions.id |
| `text` | TEXT | Note content |
| `created_at` | INTEGER | Unix ms |
| `updated_at` | INTEGER | Unix ms |

### 12.3 Upsert Strategy

All child records (prompts, responses, tool_calls) use `INSERT OR IGNORE` with unique indexes for deduplication. The `sessions` table uses `INSERT ... ON CONFLICT(id) DO UPDATE SET ...`, updating all mutable fields. A single `db.transaction()` wraps the full upsert for atomicity.

### 12.4 Persist-on-Events

Only key state transitions trigger a DB write:

| Event | Triggers DB Upsert |
|---|---|
| `SessionStart` | Yes |
| `UserPromptSubmit` | Yes |
| `Stop` | Yes |
| `SessionEnd` | Yes |

Other events (PreToolUse, PostToolUse, etc.) are not persisted to DB individually.

### 12.5 Cascade Delete

`deleteSessionCascade()` is a transaction that deletes from: `prompts`, `responses`, `tool_calls`, `events`, `notes`, then `sessions` — in that order.

### 12.6 Session ID Migration

When a session is re-keyed (resume), `migrateSessionId(oldId, newId)` updates `session_id` in all child tables in a single transaction.

### 12.7 Search

`searchSessions()` supports: text search (via `prompts` subquery with `LIKE`), project filter, status filter, date range, archived filter, sorting by `started_at`/`last_activity_at`/`project_name`/`status`, and pagination.

`fullTextSearch()` searches both `prompts.text` and `responses.text_excerpt` via `LIKE` patterns, merging and sorting results by timestamp.

### 12.8 Analytics Queries

| Query | What It Returns |
|---|---|
| `getSummaryStats()` | Total/active sessions, total prompts, total tool calls, most-used tool, busiest project |
| `getToolBreakdown()` | Per-tool count and percentage of total |
| `getActiveProjects()` | Projects with session count and last activity |
| `getHeatmap()` | Activity grid by `{day_of_week (0=Mon), hour, count}` |

---

## 31. Server Infrastructure

### 31.1 Port Resolution

Port is resolved in order: `--port` CLI flag → `PORT` environment variable → `config.port` → default **3333**.

Port conflict handling: on `EADDRINUSE`, the server calls `killPortProcess(port)` which uses `lsof -ti:{port}` (macOS/Linux) or `netstat -ano | findstr :port` (Windows) to find and SIGTERM the occupying process, then retries binding after **1 second**.

### 31.2 Graceful Shutdown

Signals handled: `SIGTERM`, `SIGINT`

Shutdown sequence:
1. Stop periodic snapshot save
2. Stop WebSocket heartbeat
3. Stop MQ reader (performs final read to flush)
4. Stop auth token cleanup
5. Save final snapshot with current MQ offset
6. Close SQLite database
7. Close HTTP server
8. Exit 0 (forced exit 1 after **5 seconds** if not clean)

### 31.3 Global Error Handlers

| Handler | Behavior |
|---|---|
| `uncaughtException` | Log error; exit 1 if `out of memory` or `ENOMEM` |
| `unhandledRejection` | Log error and stack; continue |

### 31.4 Process Monitor

`processMonitor.js` runs every **15,000 ms** (configurable via `serverConfig.processCheckInterval`) and checks `process.kill(pid, 0)` for each non-ended session with a `cachedPid`. Dead processes trigger:
- Session marked `ended` + `Death` animation
- PID released from `pidToSession` Map
- Approval timer cleared
- Team cleanup
- Broadcast to browsers
- SSH sessions: marked `isHistorical`, terminal link cleared
- Non-SSH sessions: scheduled for deletion after 10 seconds

Sessions with an active PTY terminal are skipped (terminal is the source of truth).

**`findClaudeProcess()` fallback chain:**
1. Cached PID (validated with signal 0)
2. `pgrep -f claude` → match by `cwd` via `lsof -a -d cwd` (macOS) or `/proc/{pid}/cwd` (Linux)
3. TTY fallback: first unclaimed PID with a TTY attached
4. Last resort: first unclaimed PID

### 31.5 Rate Limiting

In-memory sliding-window rate limiter using `Map<key, {count, windowStart}>`. Window is **1 second**. Stale buckets (older than 5s) are cleaned every **30 seconds**.

### 31.6 Logger

Levels:
- `info` — always shown
- `warn` — always shown (yellow `WARN` prefix)
- `error` — always shown (red `ERROR` prefix)
- `debug` — only in debug mode (magenta `DEBUG` prefix)
- `debugJson` — only in debug mode (full JSON.stringify with indent 2)

Format: `[ISO timestamp] [tag] message`

Debug mode is activated by `--debug` CLI flag or `"debug": true` in `data/server-config.json`.

### 31.7 Server Config (`data/server-config.json`)

| Field | Type | Default | Description |
|---|---|---|---|
| `port` | number | `3333` | HTTP/WS listen port |
| `hookDensity` | string | `"medium"` | `high`, `medium`, or `low` |
| `debug` | boolean | `false` | Verbose logging |
| `processCheckInterval` | number | `15000` | PID liveness check interval (ms) |
| `sessionHistoryHours` | number | `24` | History retention (used by setup wizard) |
| `enabledClis` | string[] | `["claude"]` | Which CLIs to install hooks for |
| `passwordHash` | string\|null | `null` | `salt:hash` for dashboard login |

### 31.8 Network Interface Detection

On startup, `getLocalIP()` probes network interfaces in preferred order: `en0`, `en1`, `eth0`, `wlan0`, then falls back to any non-internal IPv4. The LAN IP is displayed in the startup log.

### 31.9 Static File Serving

If `dist/client/` directory exists (Vite build output), it is served from there. Otherwise, `public/` is served. The React SPA fallback (`GET /*`) serves `dist/client/index.html` for client-side routing.

---

## 32. CLI and Setup

### 32.1 npx Entry Point (`bin/cli.js`)

When invoked as `npx ai-agent-session-center` or after global install:

1. Check if `data/server-config.json` exists
2. If missing (`isFirstRun`) or `--setup` flag passed: run `hooks/setup-wizard.js`
3. On wizard exit 0: start `server/index.js` with remaining args
4. On wizard exit non-0: exit with same code
5. If config exists and no `--setup`: start server directly

### 32.2 Setup Wizard (`hooks/setup-wizard.js`)

Interactive 6-step wizard:

| Step | Question | Options |
|---|---|---|
| 1 | Server port | Free-form number (default: `3333`) |
| 2 | AI CLIs to hook | Claude only / Claude+Gemini / Claude+Codex / All three |
| 3 | Hook density | `high` (14 events) / `medium` (12 events, default) / `low` (5 events) |
| 4 | Debug mode | Off (default) / On |
| 5 | Session history retention | 12h / 24h (default) / 48h / 7 days |
| 6 | Dashboard password | No password (default) / Set password (min 4 chars, confirmed) |

Password input uses raw mode TTY (`process.stdin.setRawMode(true)`) with character-by-character echo masking (`*`). Re-running the wizard shows existing config as defaults and allows keeping/changing/removing the password.

After wizard completes:
1. Saves `data/server-config.json`
2. Runs `hooks/install-hooks.js --density {density} --clis {clis}` to install hooks

### 32.3 Auto-Install on Startup

`ensureHooksInstalled(config)` runs on every server startup. It:
1. Reads `data/server-config.json` for `hookDensity` and `enabledClis`
2. For each enabled CLI: copies the hook script to the CLI's hooks directory (if content changed)
3. Reads the CLI's settings file
4. Adds missing event registrations (checks for `dashboard-hook` in existing commands)
5. Writes settings atomically if any changes were made

**Hook registration markers:** Each added entry includes `"_source": "ai-agent-session-center"` so the reset tool can identify and remove them.

### 32.4 Available npm Scripts

| Script | Command | Description |
|---|---|---|
| `npm start` | `node server/index.js` | Start server, auto-open browser |
| `npm run start:no-open` | `node server/index.js --no-open` | Start without opening browser |
| `npm run debug` | `node server/index.js --debug` | Start with verbose logging |
| `npm run setup` | `node hooks/setup-wizard.js` | Interactive setup wizard |
| `npm run install-hooks` | `node hooks/install-hooks.js` | Install hooks into CLI settings |
| `npm run uninstall-hooks` | `node hooks/install-hooks.js --uninstall` | Remove all dashboard hooks |
| `npm run reset` | `node hooks/reset.js` | Remove hooks, clean config, create backup |
| `npm test` | Test suite | Run tests |
| `npm run test:watch` | Test suite watch | Run tests in watch mode |

### 32.5 Hook Performance Stats

`hookStats.js` maintains rolling statistics per event type (last **200 samples**) and globally (last **1 minute** for rate):

| Metric | Description |
|---|---|
| `count` | Total hooks received of this type |
| `rate` | Hooks received in last 60 seconds |
| `latency.avg/min/max/p95` | Delivery latency (hook_sent_at → server received) in ms |
| `processing.avg/min/max/p95` | Server `handleEvent()` duration in ms |
| `totalHooks` | Global total |
| `hooksPerMin` | Global rate (hooks in last 60s) |

Stats are broadcast as `hook_stats` WebSocket messages after each hook event (throttled to 1/sec per client).
