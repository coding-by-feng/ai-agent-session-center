# Hook Delivery Pipeline

## Function
Captures AI CLI lifecycle events via bash hook scripts and delivers them to the server through a file-based message queue (JSONL) with HTTP POST fallback.

## Purpose
The bridge between AI CLI processes (Claude, Gemini, Codex) and the dashboard. Without hooks, no session monitoring is possible.

## Source Files
| File | Role |
|------|------|
| `hooks/dashboard-hook.sh` | Bash hook script (reads stdin JSON, enriches with PID/TTY/env vars via jq, appends to JSONL queue) |
| `server/mqReader.ts` | File-based MQ reader (fs.watch + 10ms debounce, 500ms fallback poll, 5s health check, reads from byte offset, truncates at 1MB) |
| `server/hookProcessor.ts` | Validates payload (session_id, event type, PID, timestamp), calls sessionStore.handleEvent(), records stats, broadcasts to WS with 250ms throttle (max 4/sec per session) |
| `server/hookRouter.ts` | HTTP POST fallback endpoint, rate limited 100/sec per IP |
| `server/hookInstaller.js` | Auto-installs hooks on startup for Claude/Gemini/Codex, atomic writes to settings files |
| `server/hookStats.ts` | Rolling stats per event type (last 200 samples), global rate (last 60s) |

## Implementation

### Hook Script
- Synchronous read of stdin, then background subshell (`& disown`) so Claude is never blocked
- 21 enriched fields via single jq pass (~2-5ms): claude_pid, hook_sent_at, tty_path, term_program, term_program_version, vscode_pid, term, tab_id, window_id, tmux, is_ghostty, kitty_pid, agent_terminal_id, claude_project_dir, parent_session_id, team_name, agent_name, agent_type, agent_id, agent_color, startup_command
- TTY caching in /tmp/claude-tty-cache/$PPID

### MQ Reader
- fs.watch() -> scheduleRead(10ms debounce) -> async read from lastByteOffset -> split newlines -> parse JSON -> processHookEvent()
- Concurrent read protection (readInProgress flag prevents overlapping reads)
- Snapshot resume: accepts resumeOffset on startup
- Truncation at 1MB to prevent unbounded file growth
- 500ms fallback poll in case fs.watch misses events
- 5s health check for file existence and size

### Hook Validation
- session_id required (max 256 chars)
- hook_event_name must be in KNOWN_EVENTS set
- claude_pid must be positive int if present
- timestamp must be valid finite number if present

### Event Coverage
- 14 Claude events, 7 Gemini events (high), 1 Codex event
- Claude density: high (all 14), medium (12, excludes TeammateIdle/PreCompact), low (5 core events)
- Gemini density: high (7), medium (5, excludes BeforeTool/AfterTool), low (3 core events)
- Codex uses TOML config with notify command (no density control)

### Hook Registration
- Claude: hooks copied to ~/.claude/hooks/, events registered in ~/.claude/settings.json (atomic write-to-tmp + rename)
- Gemini: hooks copied to ~/.gemini/hooks/, events registered in ~/.gemini/settings.json
- Codex: hooks copied to ~/.codex/hooks/, notify command appended to ~/.codex/config.toml
- Content-based sync: hook file only updated if content differs from source
- Tab title update on state-changing events (SessionStart, UserPromptSubmit, PermissionRequest, Stop, Notification, SessionEnd)

## Dependencies & Connections

### Depends On
- Nothing (entry point of the pipeline)

### Depended On By
- [Session Management](./session-management.md) — receives processed hook events
- [WebSocket Manager](./websocket-manager.md) — hookProcessor broadcasts via WS after processing
- [Approval Detection](./approval-detection.md) — PreToolUse events trigger approval timers
- [Team & Subagent Tracking](./team-subagent.md) — SubagentStart events trigger team linking

### Shared Resources
- `/tmp/claude-session-center/queue.jsonl` (MQ file)
- `~/.claude/settings.json`

## Change Risks
- Breaking the hook script blocks ALL session monitoring
- Changes to jq enrichment affect session-matching
- Changing JSONL format breaks mqReader parsing
- Modifying density levels changes which events are captured
