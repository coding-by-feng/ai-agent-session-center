# Claude Code Hooks System

## Overview

The dashboard monitors AI coding agents by registering **hook scripts** into Claude Code's settings. Claude Code fires these hooks at key lifecycle events, passing JSON via stdin. The hook script enriches the JSON with process/environment info and delivers it to the dashboard server.

## Architecture

```
Claude Code (fires hook event)
        │
        │  JSON via stdin
        ▼
~/.claude/hooks/dashboard-hook.sh
        │
        │  1. Read stdin (synchronous)
        │  2. Background subshell (non-blocking)
        │  3. TTY detection (cached per PID)
        │  4. jq enrichment (single pass, ~2-5ms)
        │  5. Tab title update (state-changing events only)
        │  6. Deliver to server
        │
        ├──► /tmp/claude-session-center/queue.jsonl  (primary: file-based MQ)
        │         │
        │         ▼
        │    mqReader.js (fs.watch + 10ms debounce)
        │         │
        │         ▼
        │    hookProcessor.js
        │
        └──► POST http://localhost:3333/api/hooks  (fallback: HTTP)
                  │
                  ▼
             hookRouter.js → hookProcessor.js
```

## Hook Registration

### Where Hooks Are Registered

| CLI | Config File | Format |
|-----|-------------|--------|
| Claude Code | `~/.claude/settings.json` | JSON `hooks` object |
| Gemini CLI | `~/.gemini/settings.json` | JSON `hooks` object |
| Codex | `~/.codex/config.toml` | TOML `notify` array |

### Registration Format (`~/.claude/settings.json`)

```json
{
  "hooks": {
    "SessionStart": [
      {
        "_source": "ai-agent-session-center",
        "hooks": [
          {
            "type": "command",
            "command": "~/.claude/hooks/dashboard-hook.sh",
            "async": true
          }
        ]
      }
    ],
    "PreToolUse": [ ... ],
    "PostToolUse": [ ... ]
  }
}
```

Key properties:
- `_source`: Marker to identify dashboard hooks (for clean uninstall)
- `type`: Always `"command"` (shell command)
- `command`: Path to the hook script
- `async`: `true` — hook runs asynchronously so it doesn't block Claude

### Two Registration Paths

1. **Manual CLI** (`npm run install-hooks` → `hooks/install-hooks.js`)
   - Interactive 6-step wizard with colored output
   - Checks dependencies (jq, curl, bash)
   - Supports `--density`, `--clis`, `--uninstall` flags
   - Deploys hook scripts + registers in settings

2. **Auto on server startup** (`server/hookInstaller.js` → `ensureHooksInstalled()`)
   - Silent, runs every time server starts
   - Only adds missing hooks (idempotent)
   - Syncs hook script file if content changed
   - Uses atomic writes (temp file + rename) to prevent corruption

### Atomic Settings Write

Both paths use atomic JSON writes to prevent corrupting `~/.claude/settings.json`:

```js
function atomicWriteJSON(filePath, data) {
  const tmpPath = filePath + '.tmp.' + randomBytes(4).toString('hex');
  writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n');
  renameSync(tmpPath, filePath);  // atomic on same filesystem
}
```

## All 14 Claude Code Hook Events

| # | Event | Fired When | Density |
|---|-------|-----------|---------|
| 1 | `SessionStart` | Claude Code process starts | low, medium, high |
| 2 | `UserPromptSubmit` | User submits a prompt | low, medium, high |
| 3 | `PreToolUse` | Before a tool executes | medium, high |
| 4 | `PostToolUse` | After a tool completes successfully | medium, high |
| 5 | `PostToolUseFailure` | After a tool fails | medium, high |
| 6 | `PermissionRequest` | Claude needs user approval for a tool | low, medium, high |
| 7 | `Stop` | Claude finishes its response turn | low, medium, high |
| 8 | `Notification` | Claude sends a notification | medium, high |
| 9 | `SubagentStart` | A subagent (Task tool) is spawned | medium, high |
| 10 | `SubagentStop` | A subagent finishes | medium, high |
| 11 | `TeammateIdle` | A teammate agent goes idle | high only |
| 12 | `TaskCompleted` | A task is completed | medium, high |
| 13 | `PreCompact` | Context window compaction starting | high only |
| 14 | `SessionEnd` | Claude Code process exits | low, medium, high |

### Density Levels

| Level | Events | Excluded | Use Case |
|-------|--------|----------|----------|
| **high** | All 14 | none | Full monitoring, complete visibility |
| **medium** | 12 | `TeammateIdle`, `PreCompact` | Default, good balance |
| **low** | 5 | `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `Notification`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, `PreCompact` | Minimal overhead, basic status only |

## Hook Script Logic (`dashboard-hook.sh`)

### Execution Flow

```bash
#!/bin/bash

# 1. Capture timestamp and stdin (synchronous — must complete before hook returns)
SENT_AT=$(date +%s)
INPUT=$(cat)

# 2. Everything below runs in background subshell — hook returns instantly
{
  # ... all processing ...
} &>/dev/null &
disown
exit 0
```

The `disown` + background subshell ensures the hook returns in <1ms to Claude Code while processing happens asynchronously.

### Step 1: TTY Detection (Cached)

```bash
# Lookup TTY for Claude's parent PID
# Cached in /tmp/claude-tty-cache/$PPID to avoid `ps` on every event
TTY_CACHE="/tmp/claude-tty-cache"
TTY_CACHE_FILE="$TTY_CACHE/$PPID"
if [ -f "$TTY_CACHE_FILE" ]; then
  HOOK_TTY=$(cat "$TTY_CACHE_FILE")           # cache hit
else
  RAW_TTY=$(ps -o tty= -p "$PPID")           # cache miss — lookup
  HOOK_TTY="/dev/${RAW_TTY}"
  echo "$HOOK_TTY" > "$TTY_CACHE_FILE"        # cache for next time
fi
```

### Step 2: JSON Enrichment (Single `jq` Pass)

The hook script adds **27 fields** to the original hook JSON in a single `jq` invocation:

| Field | Source | Purpose |
|-------|--------|---------|
| `claude_pid` | `$PPID` | Claude process PID for liveness checks |
| `hook_sent_at` | `date +%s` | Timestamp for delivery latency measurement |
| `tty_path` | TTY cache / `ps` | Terminal device path |
| `term_program` | `$TERM_PROGRAM` | Terminal app (iTerm2, Apple_Terminal, etc.) |
| `term_program_version` | `$TERM_PROGRAM_VERSION` | Terminal version |
| `vscode_pid` | `$VSCODE_PID` | VS Code process PID (if running in VS Code) |
| `term` | `$TERM` | Terminal type (xterm-256color, etc.) |
| `tab_id` | Various env vars | Unique tab/pane identifier |
| `window_id` | `$WINDOWID` | X11 window ID |
| `tmux` | `$TMUX`, `$TMUX_PANE` | Tmux session and pane info |
| `is_ghostty` | `$GHOSTTY_RESOURCES_DIR` | Ghostty terminal detection |
| `kitty_pid` | `$KITTY_PID` | Kitty terminal PID |
| `agent_terminal_id` | `$AGENT_MANAGER_TERMINAL_ID` | Dashboard-created terminal ID |
| `claude_project_dir` | `$CLAUDE_PROJECT_DIR` | Claude project directory |
| `parent_session_id` | `$CLAUDE_CODE_PARENT_SESSION_ID` | Parent session (for subagents) |
| `team_name` | `$CLAUDE_CODE_TEAM_NAME` | Team name (multi-agent) |
| `agent_name` | `$CLAUDE_CODE_AGENT_NAME` | Agent name in team |
| `agent_type` | `$CLAUDE_CODE_AGENT_TYPE` | Agent type (e.g., "general-purpose") |
| `agent_id` | `$CLAUDE_CODE_AGENT_ID` | Agent unique ID |
| `agent_color` | `$CLAUDE_CODE_AGENT_COLOR` | Agent color for UI |

The `tab_id` is derived from the first available terminal-specific env var:

```
iTerm2     → $ITERM_SESSION_ID
Kitty      → "kitty:" + $KITTY_WINDOW_ID
Warp       → "warp:" + $WARP_SESSION_ID
WezTerm    → "wezterm:" + $WEZTERM_PANE
Other      → $TERM_SESSION_ID
```

### Step 3: Tab Title Management

Only updates on **state-changing events** (not rapid PreToolUse/PostToolUse):

| Event | Tab Title Action |
|-------|-----------------|
| `SessionStart` | Set to `Claude: <project_name>` (cached in `/tmp/claude-tab-titles/`) |
| `SessionEnd` | Remove cache file |
| `UserPromptSubmit`, `PermissionRequest`, `Stop`, `Notification` | Refresh from cache |
| `PreToolUse`, `PostToolUse`, etc. | Skip (too rapid) |

### Step 4: Delivery

```bash
MQ_DIR="/tmp/claude-session-center"
MQ_FILE="$MQ_DIR/queue.jsonl"

if [ -d "$MQ_DIR" ]; then
  # Primary: atomic file append (~0.1ms)
  # POSIX guarantees atomicity for writes < PIPE_BUF (4096 bytes)
  echo "$ENRICHED" >> "$MQ_FILE"
else
  # Fallback: HTTP POST when server hasn't started yet
  echo "$ENRICHED" | curl -s --connect-timeout 1 -m 3 -X POST \
    -H "Content-Type: application/json" \
    --data-binary @- \
    http://localhost:3333/api/hooks
fi
```

## Server-Side Processing

### Transport: File-based MQ (`mqReader.js`)

```
fs.watch() on queue.jsonl
    │
    ▼ (10ms debounce)
Read new bytes from last offset
    │
    ▼
Split on newlines, parse JSON
    │
    ▼
processHookEvent() for each line
    │
    ▼ (at 1MB threshold)
Truncate file, reset offset
```

### Transport: HTTP (`hookRouter.js`)

```
POST /api/hooks
    │
    ▼
Parse JSON body
    │
    ▼
processHookEvent()
```

### Processing Pipeline (`hookProcessor.js`)

```
1. Validate payload
   - session_id: required, string, max 256 chars
   - hook_event_name: required, must be known event
   - claude_pid: if present, positive integer
   - timestamp: if present, valid number

2. handleEvent() (sessionStore.js)
   - Match session (5-priority matcher)
   - Auto-revive ended sessions if process survived restart
   - Process event (switch on hook_event_name)
   - Persist to SQLite on key events

3. Record stats
   - Delivery latency (hook_sent_at → receivedAt)
   - Processing time (handleEvent duration)

4. Broadcast to WebSocket clients
   - session_update message
   - team_update if team involved
   - hook_stats update
```

### Event Processing Logic (`sessionStore.js` `handleEvent()`)

| Event | Status Change | Animation | Actions |
|-------|--------------|-----------|---------|
| `SessionStart` | → `idle` | Idle | Set model, transcript path, permission mode. Update SSH projectPath from hook cwd. Team linking via `parent_session_id` or path-based matching. |
| `UserPromptSubmit` | → `prompting` | Walking + Wave | Store prompt in history (last 50). Auto-generate title from project name + prompt. |
| `PreToolUse` | → `working` | Running | Increment tool usage counter. Push to tool log (last 200). Start approval detection timer. |
| `PostToolUse` | → `working` | Running | Cancel approval timer. Mark tool completed. |
| `PostToolUseFailure` | → `working` | Running | Cancel approval timer. Mark last tool log entry as failed with error. |
| `PermissionRequest` | → `approval` | Waiting | Cancel approval timer (reliable signal replaces heuristic). Set `waitingDetail` with tool name + input summary. |
| `Stop` | → `waiting` | Dance (heavy) / Waiting + ThumbsUp (light) | Store response excerpt (last 50). Reset tool call counter. Heavy = >10 tool calls. |
| `SubagentStart` | (no change) | Jump emote | Increment subagent count. Track pending subagent for team auto-detection. |
| `SubagentStop` | (no change) | - | Decrement subagent count. |
| `TeammateIdle` | (no change) | - | Log teammate idle info. |
| `TaskCompleted` | (no change) | ThumbsUp emote | Log task completion. |
| `PreCompact` | (no change) | - | Log context compaction. |
| `Notification` | (no change) | - | Log notification message. |
| `SessionEnd` | → `ended` | Death | Release PID cache. Team cleanup. SSH sessions: mark historical, preserve terminal ref. Non-SSH: delete after 10s. |

### Approval Detection Heuristic

When `PreToolUse` fires, a timer starts based on tool category:

| Category | Tools | Timeout | Resulting Status |
|----------|-------|---------|-----------------|
| **fast** | Read, Write, Edit, Grep, Glob, NotebookEdit | 3s | `approval` |
| **userInput** | AskUserQuestion, EnterPlanMode, ExitPlanMode | 3s | `input` |
| **medium** | WebFetch, WebSearch | 15s | `approval` |
| **slow** | Bash, Task | 8s | `approval` |

If `PostToolUse` arrives before the timeout → timer cancelled, tool was auto-approved.
If timeout fires → session transitions to `approval` or `input`.
If `PermissionRequest` arrives → timer cancelled, immediate `approval` (reliable signal).

For **slow** tools (Bash, Task): a `hasChildProcesses` check via `pgrep -P` determines if the tool is still running vs waiting for approval.

## Hook Payload Examples

### Original (from Claude Code)

```json
{
  "session_id": "abc123-def456",
  "hook_event_name": "PreToolUse",
  "cwd": "/Users/kason/my-project",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "model": "claude-sonnet-4-6"
}
```

### Enriched (after `dashboard-hook.sh`)

```json
{
  "session_id": "abc123-def456",
  "hook_event_name": "PreToolUse",
  "cwd": "/Users/kason/my-project",
  "tool_name": "Bash",
  "tool_input": { "command": "npm test" },
  "model": "claude-sonnet-4-6",
  "claude_pid": 12345,
  "hook_sent_at": 1708300000000,
  "tty_path": "/dev/ttys004",
  "term_program": "iTerm.app",
  "term_program_version": "3.5.0",
  "vscode_pid": null,
  "term": "xterm-256color",
  "tab_id": "w0t0p0:12345678-ABCD",
  "window_id": null,
  "tmux": null,
  "is_ghostty": null,
  "kitty_pid": null,
  "agent_terminal_id": "term-1708300000-abc123",
  "claude_project_dir": "/Users/kason/my-project",
  "parent_session_id": null,
  "team_name": null,
  "agent_name": null,
  "agent_type": null,
  "agent_id": null,
  "agent_color": null
}
```

## CLI Commands

```bash
# Install hooks (interactive wizard)
npm run install-hooks

# Install with specific density
npm run install-hooks -- --density high

# Install for multiple CLIs
npm run install-hooks -- --clis claude,gemini,codex

# Uninstall all dashboard hooks
npm run uninstall-hooks

# Reset everything (hooks + config + backup)
npm run reset
```

## File Locations

| File | Purpose |
|------|---------|
| `hooks/dashboard-hook.sh` | Source hook script (in project) |
| `~/.claude/hooks/dashboard-hook.sh` | Deployed hook script (copied on install) |
| `~/.claude/settings.json` | Claude Code hook registration |
| `/tmp/claude-session-center/queue.jsonl` | File-based message queue |
| `/tmp/claude-tty-cache/` | TTY lookup cache (per PID) |
| `/tmp/claude-tab-titles/` | Tab title cache (per session) |
| `server/hookInstaller.js` | Auto-install on server startup |
| `server/hookProcessor.js` | Shared validation + processing pipeline |
| `server/mqReader.js` | File-based MQ reader |
| `server/hookRouter.js` | HTTP POST `/api/hooks` endpoint |
| `hooks/install-hooks.js` | CLI install wizard |

## Latency Budget

| Stage | Typical | Notes |
|-------|---------|-------|
| Hook script return | <1ms | Background subshell + disown |
| jq enrichment | 2-5ms | Single jq invocation |
| File append | ~0.1ms | POSIX atomic for <4096 bytes |
| fs.watch + debounce | 0-10ms | Instant on macOS/Linux |
| Server processing | ~0.5ms | handleEvent + broadcast |
| **Total end-to-end** | **3-17ms** | Hook fired → browser updated |
