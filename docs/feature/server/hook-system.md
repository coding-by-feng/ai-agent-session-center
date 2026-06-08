# Hook Delivery Pipeline

## Function
Captures AI CLI lifecycle events via bash hook scripts and delivers them to the server through a file-based message queue (JSONL) with HTTP POST fallback.

## Purpose
The bridge between AI CLI processes (Claude, Gemini, Codex) and the dashboard. Without hooks, no session monitoring is possible.

## Source Files
| File | Role |
|------|------|
| `hooks/dashboard-hook.sh` | Claude Code bash hook relay (reads stdin JSON, enriches with PID/TTY/env vars via jq, appends to JSONL queue) |
| `hooks/dashboard-hook-gemini.sh` | Gemini CLI hook relay (event name from `$1`, session/cwd from `GEMINI_SESSION_ID`/`GEMINI_CWD`; prints `{"decision":"allow"}` synchronously since Gemini hooks block, maps Gemini events → dashboard events, tags `source: "gemini"` + `gemini_event`, appends to JSONL queue) |
| `hooks/dashboard-hook-codex.sh` | Codex lifecycle hook relay (reads JSON from stdin with `$1` legacy fallback, normalizes `hook_event_name`/`type` → event, maps `last_assistant_message`/`last-assistant-message` → `response`, tags `cli_source: "codex"` + `codex_event`, appends to JSONL queue) |
| `hooks/install-hooks.js`, `hooks/install-hooks-api.js`, `hooks/install-hooks-api.cjs` | CLI/API installers for Claude, Gemini, and Codex hook registration |
| `hooks/install-hooks-core.js`, `hooks/install-hooks-core.cjs` | Pure install helpers, including Codex TOML lifecycle hook block generation/removal |
| `hooks/reset.js` | Reset/uninstall path that removes dashboard-owned Claude/Gemini config and Codex lifecycle/legacy notify config |
| `server/mqReader.ts` | File-based MQ reader (fs.watch + 10ms debounce, 500ms fallback poll, 5s health check, reads from byte offset, truncates at 1MB) |
| `server/hookProcessor.ts` | Validates payload (session_id, event type, PID, timestamp), calls `handleEvent()`, records stats, broadcasts `session_update` with 250ms throttle (max 4/sec per session), plus `team_update` and `hook_stats` |
| `server/hookRouter.ts` | `POST /api/hooks` HTTP fallback adapter — delegates to `processHookEvent(body, 'http')`, returns `{ ok: true }` or `400 { success: false, error }`; rate limiting is applied externally via `hookRateLimitMiddleware` (from `apiRouter.ts`) mounted in `server/index.ts` |
| `server/hookInstaller.js` | Auto-installs hooks on startup for Claude/Gemini/Codex, atomic writes to settings files |
| `server/hookStats.ts` | Rolling stats per event type (last 200 samples), global rate (last 60s) |
| `server/constants.ts` | Shared hook event sets (`EVENT_TYPES`, `ALL_CLAUDE_HOOK_EVENTS`, `CODEX_HOOK_EVENTS`, `KNOWN_EVENTS`) and density presets (`DENSITY_EVENTS`, `CODEX_DENSITY_EVENTS`) |
| `src/types/hook.ts` | Shared hook payload types, including `cli_source`, `codex_event`, `last_assistant_message`, and `PostCompact` |

## Implementation

### Hook Script (Claude — `dashboard-hook.sh`)
- Synchronous read of stdin, then background subshell (`{ ... } &>/dev/null & disown`) so the CLI is never blocked
- 21 enriched fields via single jq pass (~2-5ms): `claude_pid`, `hook_sent_at`, `tty_path`, `term_program`, `term_program_version`, `vscode_pid`, `term`, `tab_id`, `window_id`, `tmux`, `is_ghostty`, `kitty_pid`, `agent_terminal_id`, `claude_project_dir`, `parent_session_id`, `team_name`, `agent_name`, `agent_type`, `agent_id`, `agent_color`, `startup_command`
- `tab_id` is derived from the first available of `ITERM_SESSION_ID`, `KITTY_WINDOW_ID` (prefixed `kitty:`), `WARP_SESSION_ID` (prefixed `warp:`), `WEZTERM_PANE` (prefixed `wezterm:`), or `TERM_SESSION_ID`
- `hook_sent_at` is `date +%s` × 1000 (ms), used server-side for delivery latency
- TTY caching in `/tmp/claude-tty-cache/$PPID`; on `SessionStart` the resolved session UUID is also written to `$CWD/.claude/last-session-id` for shell-level `claude --resume`
- Delivery: append to `/tmp/claude-session-center/queue.jsonl` if the MQ dir exists, else `curl` POST to `http://localhost:3333/api/hooks` (1s connect / 3s max timeout) as fallback

### Gemini Hook Script (`dashboard-hook-gemini.sh`)
- Gemini hooks are **synchronous/blocking**, so the script prints `{"decision":"allow"}` to stdout immediately, then enriches in the background subshell
- Event name arrives as `$1`; session/cwd come from `GEMINI_SESSION_ID` / `GEMINI_CWD` env vars
- Event mapping → dashboard names: `SessionStart`→`SessionStart`, `BeforeAgent`→`UserPromptSubmit`, `BeforeTool`→`PreToolUse`, `AfterTool`→`PostToolUse`, `AfterAgent`→`Stop`, `SessionEnd`→`SessionEnd`, `Notification`→`Notification` (others pass through)
- Tags `source: "gemini"` + `gemini_event`; maps `prompt`/`llm_request` and `response`/`llm_response`/`prompt_response`; TTY cache in `/tmp/gemini-tty-cache/$PPID`

### Codex Hook Script (`dashboard-hook-codex.sh`)
- Codex command hooks read JSON from stdin; keeps a legacy `$1` fallback only for old `notify` installs
- Normalizes the event: `hook_event_name`, else `type == "agent-turn-complete"` → `Stop`, else default `Stop`; session_id falls back to `thread-id`
- Writes `cli_source: "codex"` plus `codex_event` (the original `hook_event_name`/`type`), maps `last_assistant_message` / `last-assistant-message` → `response`, and `input-messages` (last `.content`) → `prompt`
- TTY cache in `/tmp/codex-tty-cache/$PPID`

### MQ Reader
- fs.watch() -> scheduleRead(10ms debounce) -> async read from lastByteOffset -> split newlines -> parse JSON -> processHookEvent()
- Concurrent read protection (readInProgress flag prevents overlapping reads)
- Snapshot resume: accepts resumeOffset on startup
- Truncation at 1MB to prevent unbounded file growth
- 500ms fallback poll in case fs.watch misses events
- 5s health check for file existence and size

### Hook Validation (`validateHookPayload`)
- `session_id` required, must be string, max 256 chars
- event name (`hook_event_name` or legacy `event`) must be in the `KNOWN_EVENTS` set
- `claude_pid`, if present, must be a positive integer
- `timestamp`, if present, must be a finite number
- Invalid payloads are logged and rejected (`{ error }`); `handleEvent()` throwing is caught and returns `null` (no broadcast)

### Installers & Reset CLI
- `hooks/install-hooks.js` — CLI entry point; parses `--density <high|medium|low>`, `--clis <claude,gemini,codex>`, `--uninstall`, `--quiet`; falls back to `data/server-config.json`; delegates to `installHooks()` in `install-hooks-api.js`/`.cjs`.
- `hooks/install-hooks-core.js`/`.cjs` — pure helpers: `atomicWriteJSON`, `buildHookEntry`, `deployHookScript`, `configureClaudeHooks`, `removeAllClaudeHooks`, `configureCodexHooksToml`, `removeAllCodexHooksToml`.
- `hooks/reset.js` — backs up `~/.claude`/`~/.gemini`/`~/.codex` config + hook scripts, removes dashboard-owned hooks (dual match: `_source` marker preferred, command-pattern fallback), strips Codex lifecycle blocks + legacy `notify` lines, and deletes the copied hook scripts.

### Event Coverage
Densities are resolved in `hookInstaller.ensureHooksInstalled()` per CLI (the live install path); `constants.ts` mirrors the Claude/Codex sets for runtime validation.
- **Claude** (14 events total via `ALL_CLAUDE_HOOK_EVENTS`):
  - high — all 14: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionRequest`, `Stop`, `Notification`, `SubagentStart`, `SubagentStop`, `TeammateIdle`, `TaskCompleted`, `PreCompact`, `SessionEnd`
  - medium — 12 (drops `TeammateIdle` and `PreCompact`)
  - low — 5 core: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`, `SessionEnd`
- **Gemini** (8 events at high):
  - high — `SessionStart`, `BeforeAgent`, `BeforeTool`, `AfterTool`, `AfterAgent`, `PreCompress`, `SessionEnd`, `Notification`
  - medium — 5: `SessionStart`, `BeforeAgent`, `AfterAgent`, `SessionEnd`, `Notification`
  - low — 3: `SessionStart`, `AfterAgent`, `SessionEnd`
- **Codex** (10 lifecycle events at high; Codex has no `SessionEnd` — `Stop` is terminal):
  - high — `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `PreCompact`, `PostCompact`, `SubagentStart`, `SubagentStop`, `Stop`
  - medium — 6: `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PermissionRequest`, `Stop`
  - low — 4: `SessionStart`, `UserPromptSubmit`, `PermissionRequest`, `Stop`

### Hook Registration
- **Claude**: hook copied to `~/.claude/hooks/`, events registered in `~/.claude/settings.json` (atomic write-to-tmp + rename). Each entry is `{ _source: 'ai-agent-session-center', hooks: [{ type: 'command', command, async: true }] }`. Windows uses `dashboard-hook.ps1` invoked via `powershell -NoProfile -ExecutionPolicy Bypass -File`.
- **Gemini**: hook copied to `~/.gemini/hooks/dashboard-hook.sh`, events registered in `~/.gemini/settings.json` with the event name appended to the command (`~/.gemini/hooks/dashboard-hook.sh <Event>`), no `async` flag (Gemini hooks are blocking).
- **Codex**: hook copied to `~/.codex/hooks/dashboard-hook.sh`, configured via `configureCodexHooksToml()` in `~/.codex/config.toml`. Two forms are written together: (1) a top-level `notify = ["~/.codex/hooks/dashboard-hook.sh"]` (placed above any `[section]` so TOML doesn't bind it to the last section) that carries `Stop`/`agent-turn-complete`, and (2) per-event `[[hooks.Event]]` + `[[hooks.Event.hooks]]` + `type = "command"` + `command = "..."` blocks for the rest of the lifecycle. **No `async` key** is written on the TOML hook blocks.
- Codex re-installs first run `removeAllCodexHooksToml()` to strip dashboard-owned legacy `notify = [...]` lines and existing `[[hooks.X]]` blocks before re-writing the selected density; unrelated Codex config and third-party hooks (and third-party hook entries inside shared event blocks) are preserved.
- Content-based sync (`syncHookFile`): hook script only re-copied if content differs from source (byte-compare).
- Tab title update (Claude only, via `\033]0;Claude: <project>\007`) on state-changing events: `SessionStart` (sets/caches project name), `UserPromptSubmit`, `PermissionRequest`, `Stop`, `Notification`; `SessionEnd` clears the cache. Rapid `PreToolUse`/`PostToolUse` are skipped.

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
- `~/.gemini/settings.json`
- `~/.codex/config.toml`

## Change Risks
- Breaking the hook script blocks ALL session monitoring
- Changes to jq enrichment affect [Session Matching](./session-matching.md) (TTY/PID/tab_id/env fields are matcher inputs)
- Changing the JSONL format breaks `mqReader` parsing
- Modifying density levels changes which events are captured (and downstream sound/alarm triggers)
- Per-CLI event sets in `hookInstaller.js` and `constants.ts` must stay in sync — an event registered but not in `KNOWN_EVENTS` is rejected at validation
