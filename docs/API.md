# API Reference

AI Agent Session Center exposes a REST API, a WebSocket endpoint, and accepts hook events via file-based MQ (primary) or HTTP POST (fallback).

Base URL: `http://localhost:3333`

---

## Table of Contents

- [REST API](#rest-api)
  - [Hook Stats](#get-apihook-stats)
  - [Reset Hook Stats](#post-apihook-statsreset)
  - [Full Reset](#post-apireset)
  - [MQ Stats](#get-apimq-stats)
  - [Hooks Status](#get-apihooksstatus)
  - [Install Hooks](#post-apihooksinstall)
  - [Uninstall Hooks](#post-apihooksuninstall)
  - [Resume Session](#post-apisessionsidresume)
  - [Kill Session](#post-apisessionsidkill)
  - [Delete Session](#delete-apisessionsid)
  - [Session Source](#get-apisessionsidsource)
  - [Update Title](#put-apisessionsidtitle)
  - [Update Label](#put-apisessionsidlabel)
  - [Summarize Session](#post-apisessionsidsummarize)
  - [SSH Keys](#get-apissh-keys)
  - [Tmux Sessions](#post-apitmux-sessions)
  - [Create Terminal](#post-apiterminals)
  - [List Terminals](#get-apiterminals)
  - [Close Terminal](#delete-apiterminalsid)
- [Hook Ingestion](#hook-ingestion)
  - [File-based MQ (Primary)](#file-based-mq-primary)
  - [HTTP POST (Fallback)](#http-post-fallback)
  - [Hook Payload Format](#hook-payload-format)
  - [Event Types](#event-types)
  - [Hook Enrichment Fields](#hook-enrichment-fields)
- [WebSocket Protocol](#websocket-protocol)
  - [Connection](#connection)
  - [Server to Client Messages](#server-to-client-messages)
  - [Client to Server Messages](#client-to-server-messages)
  - [Backpressure and Throttling](#backpressure-and-throttling)
- [Rate Limiting](#rate-limiting)
- [Error Responses](#error-responses)

---

## REST API

All endpoints are prefixed with `/api`. Request and response bodies are JSON.

### GET /api/hook-stats

Returns rolling-window performance statistics for hook processing.

**Response:**

```json
{
  "byEvent": {
    "SessionStart": {
      "count": 12,
      "avgDeliveryLatency": 15.3,
      "avgProcessingTime": 2.1,
      "p95DeliveryLatency": 42,
      "p95ProcessingTime": 5,
      "maxDeliveryLatency": 65,
      "maxProcessingTime": 8
    }
  },
  "totals": {
    "count": 248,
    "avgDeliveryLatency": 18.7,
    "avgProcessingTime": 1.9
  },
  "uptimeMs": 3600000,
  "throughput": {
    "eventsPerSecond": 0.07
  }
}
```

**curl:**

```bash
curl http://localhost:3333/api/hook-stats
```

---

### POST /api/hook-stats/reset

Resets all hook performance statistics to zero.

**Response:**

```json
{ "ok": true }
```

**curl:**

```bash
curl -X POST http://localhost:3333/api/hook-stats/reset
```

---

### POST /api/reset

Broadcasts a signal to all connected browser clients to clear their IndexedDB storage. Useful for a full dashboard reset.

**Response:**

```json
{ "ok": true, "message": "Browser DB clear signal sent" }
```

**curl:**

```bash
curl -X POST http://localhost:3333/api/reset
```

---

### GET /api/mq-stats

Returns statistics for the file-based JSONL message queue reader.

**Response:**

```json
{
  "linesProcessed": 1024,
  "linesErrored": 2,
  "truncations": 1,
  "lastProcessedAt": 1707753600000,
  "startedAt": 1707750000000,
  "queueFile": "/tmp/claude-session-center/queue.jsonl",
  "running": true,
  "currentOffset": 45678,
  "hasPartialLine": false
}
```

**curl:**

```bash
curl http://localhost:3333/api/mq-stats
```

---

### GET /api/hooks/status

Returns the current hook installation status, detected density level, and installed event list.

**Response:**

```json
{
  "installed": true,
  "density": "medium",
  "events": [
    "SessionStart",
    "UserPromptSubmit",
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "PermissionRequest",
    "Stop",
    "Notification",
    "SubagentStart",
    "SubagentStop",
    "TaskCompleted",
    "SessionEnd"
  ]
}
```

Possible `density` values: `"high"`, `"medium"`, `"low"`, `"custom"`, `"off"`.

**curl:**

```bash
curl http://localhost:3333/api/hooks/status
```

---

### POST /api/hooks/install

Installs dashboard hooks into `~/.claude/settings.json` at the specified density level.

**Request body:**

| Field   | Type   | Required | Description                          |
|---------|--------|----------|--------------------------------------|
| density | string | yes      | One of: `"high"`, `"medium"`, `"low"` |

**Response:**

```json
{
  "ok": true,
  "density": "medium",
  "events": ["SessionStart", "UserPromptSubmit", "..."],
  "output": "Hooks installed successfully"
}
```

**Errors:**

| Status | Condition                             |
|--------|---------------------------------------|
| 400    | Missing or invalid density value      |
| 500    | install-hooks.js script failed        |

**curl:**

```bash
curl -X POST http://localhost:3333/api/hooks/install \
  -H 'Content-Type: application/json' \
  -d '{"density": "medium"}'
```

---

### POST /api/hooks/uninstall

Removes all dashboard hooks from `~/.claude/settings.json`.

**Response:**

```json
{
  "ok": true,
  "output": "Hooks uninstalled successfully"
}
```

**curl:**

```bash
curl -X POST http://localhost:3333/api/hooks/uninstall
```

---

### POST /api/sessions/:id/resume

Resumes a disconnected SSH session by sending `claude --resume` to its associated terminal.

**Preconditions:** Session must be in `ended` status with a valid terminal.

**Response (success):**

```json
{ "ok": true, "terminalId": "term-abc123" }
```

**Errors:**

| Status | Condition                          |
|--------|------------------------------------|
| 404    | Session not found                  |
| 400    | Session is not ended               |
| 400    | No terminal associated             |
| 400    | Terminal no longer exists           |

**curl:**

```bash
curl -X POST http://localhost:3333/api/sessions/SESSION_ID/resume
```

---

### POST /api/sessions/:id/kill

Sends SIGTERM to the session's Claude process (followed by SIGKILL after 3s if still alive), marks the session as ended, and closes any associated terminal.

**Request body:**

| Field   | Type    | Required | Description                     |
|---------|---------|----------|---------------------------------|
| confirm | boolean | yes      | Must be `true` to confirm kill  |

**Response:**

```json
{ "ok": true, "pid": 12345, "source": "terminal" }
```

**Errors:**

| Status | Condition                           |
|--------|-------------------------------------|
| 400    | Missing `{confirm: true}`           |
| 404    | Session not found and no process    |
| 500    | Failed to kill process              |

**curl:**

```bash
curl -X POST http://localhost:3333/api/sessions/SESSION_ID/kill \
  -H 'Content-Type: application/json' \
  -d '{"confirm": true}'
```

---

### DELETE /api/sessions/:id

Permanently removes a session from server memory and broadcasts `session_removed` to all connected browsers.

**Response:**

```json
{ "ok": true, "removed": true }
```

**curl:**

```bash
curl -X DELETE http://localhost:3333/api/sessions/SESSION_ID
```

---

### GET /api/sessions/:id/source

Detects the terminal type of a session (vscode, iterm, warp, terminal, ssh, etc.).

**Response:**

```json
{ "source": "vscode" }
```

Possible values: `ssh`, `vscode`, `jetbrains`, `iterm`, `warp`, `kitty`, `ghostty`, `alacritty`, `wezterm`, `hyper`, `terminal`, `tmux`, `unknown`.

**curl:**

```bash
curl http://localhost:3333/api/sessions/SESSION_ID/source
```

---

### PUT /api/sessions/:id/title

Updates a session's display title (in-memory only).

**Request body:**

| Field | Type   | Required | Constraints     |
|-------|--------|----------|-----------------|
| title | string | yes      | Max 500 chars   |

**Response:**

```json
{ "ok": true }
```

**curl:**

```bash
curl -X PUT http://localhost:3333/api/sessions/SESSION_ID/title \
  -H 'Content-Type: application/json' \
  -d '{"title": "My custom title"}'
```

---

### PUT /api/sessions/:id/label

Updates a session's label (e.g., "ONEOFF", "BATCH", custom labels).

**Request body:**

| Field | Type   | Required |
|-------|--------|----------|
| label | string | yes      |

**Response:**

```json
{ "ok": true }
```

**curl:**

```bash
curl -X PUT http://localhost:3333/api/sessions/SESSION_ID/label \
  -H 'Content-Type: application/json' \
  -d '{"label": "ONEOFF"}'
```

---

### POST /api/sessions/:id/summarize

Generates a session summary using `claude -p --model haiku`. The frontend prepares and sends the session transcript from its IndexedDB data.

**Rate limit:** Max 2 concurrent summarize requests.

**Request body:**

| Field          | Type   | Required | Description                                      |
|----------------|--------|----------|--------------------------------------------------|
| context        | string | yes      | Session transcript text (prepared from IndexedDB) |
| promptTemplate | string | no       | Custom prompt template (overrides default)        |
| custom_prompt  | string | no       | Direct prompt override (max 10000 chars)          |

Prompt precedence: `custom_prompt` > `promptTemplate` > default (`"Summarize this Claude Code session in detail."`)

**Response (success):**

```json
{ "ok": true, "summary": "This session focused on..." }
```

**Errors:**

| Status | Condition                           |
|--------|-------------------------------------|
| 400    | Missing or invalid `context`        |
| 400    | `custom_prompt` too long            |
| 429    | Too many concurrent requests (max 2)|
| 500    | Claude CLI execution failed         |

**curl:**

```bash
curl -X POST http://localhost:3333/api/sessions/SESSION_ID/summarize \
  -H 'Content-Type: application/json' \
  -d '{"context": "User: Fix the login bug\nClaude: I will..."}'
```

---

### GET /api/ssh-keys

Lists SSH key filenames from `~/.ssh/`.

**Response:**

```json
{ "keys": ["id_rsa", "id_ed25519", "work_key"] }
```

**curl:**

```bash
curl http://localhost:3333/api/ssh-keys
```

---

### POST /api/tmux-sessions

Lists tmux sessions on a remote host via SSH.

**Request body:**

| Field          | Type   | Required | Default     |
|----------------|--------|----------|-------------|
| host           | string | no       | "localhost" |
| port           | number | no       | 22          |
| username       | string | yes      | -           |
| authMethod     | string | no       | "key"       |
| privateKeyPath | string | no       | -           |
| password       | string | no       | -           |
| passphrase     | string | no       | -           |

**Response:**

```json
{ "sessions": ["main", "dev", "build"] }
```

**curl:**

```bash
curl -X POST http://localhost:3333/api/tmux-sessions \
  -H 'Content-Type: application/json' \
  -d '{"username": "user", "host": "dev-server"}'
```

---

### POST /api/terminals

Creates a new SSH terminal session. Launches node-pty and creates a corresponding session card in the dashboard.

**Rate limit:** Max 10 terminals total.

**Request body:**

| Field          | Type    | Required | Default     | Validation                    |
|----------------|---------|----------|-------------|-------------------------------|
| host           | string  | no       | "localhost" | No shell metacharacters       |
| port           | number  | no       | 22          | 1-65535                       |
| username       | string  | yes      | -           | Alphanumeric, dash, underscore, dot |
| authMethod     | string  | no       | "key"       | -                             |
| privateKeyPath | string  | no       | -           | -                             |
| password       | string  | no       | -           | -                             |
| workingDir     | string  | no       | "~"         | No shell metacharacters       |
| command        | string  | no       | "claude"    | No shell metacharacters (max 512) |
| apiKey         | string  | no       | -           | -                             |
| tmuxSession    | string  | no       | -           | Alphanumeric, dash, underscore, dot |
| useTmux        | boolean | no       | false       | -                             |
| sessionTitle   | string  | no       | -           | Max 500 chars                 |
| label          | string  | no       | -           | -                             |

**Response:**

```json
{ "ok": true, "terminalId": "term-abc123" }
```

**Errors:**

| Status | Condition                            |
|--------|--------------------------------------|
| 400    | Missing username or validation error |
| 429    | Terminal limit reached (max 10)      |
| 500    | Terminal creation failed              |

**curl:**

```bash
curl -X POST http://localhost:3333/api/terminals \
  -H 'Content-Type: application/json' \
  -d '{"username": "user", "host": "dev-server", "command": "claude"}'
```

---

### GET /api/terminals

Lists all active terminal sessions.

**Response:**

```json
{
  "terminals": [
    { "id": "term-abc123", "host": "localhost", "status": "running" }
  ]
}
```

**curl:**

```bash
curl http://localhost:3333/api/terminals
```

---

### DELETE /api/terminals/:id

Closes and removes a terminal session.

**Response:**

```json
{ "ok": true }
```

**curl:**

```bash
curl -X DELETE http://localhost:3333/api/terminals/TERMINAL_ID
```

---

## Hook Ingestion

Hooks deliver Claude Code lifecycle events to the dashboard. There are two transports.

### File-based MQ (Primary)

The preferred transport. The hook script atomically appends a JSON line to a shared file:

- **Queue file:** `/tmp/claude-session-center/queue.jsonl`
- **Write method:** `printf '%s\n' "$json" >> "$QUEUE_FILE"` (POSIX atomic for writes <= PIPE_BUF / 4096 bytes)
- **Reader:** `fs.watch()` with 10ms debounce + 500ms poll fallback + 5s health check
- **Truncation:** File is truncated after reaching 1MB when fully caught up

### HTTP POST (Fallback)

If the MQ write fails, the hook falls back to HTTP:

```
POST /api/hooks
Content-Type: application/json
```

**Request body:** Hook payload JSON (see below).

**Response (success):**

```json
{ "ok": true }
```

**Response (validation error):**

```json
{ "success": false, "error": "missing session_id" }
```

**Rate limit:** 100 requests/sec per IP.

### Hook Payload Format

All hook events share a common base structure. The hook script (`~/.claude/hooks/dashboard-hook.sh`) reads the Claude-provided JSON from stdin and enriches it with environment metadata.

**Base fields (provided by Claude Code):**

| Field            | Type   | Required | Description                                    |
|------------------|--------|----------|------------------------------------------------|
| session_id       | string | yes      | Unique session identifier (max 256 chars)      |
| hook_event_name  | string | yes      | Event type (see Event Types table)             |
| cwd              | string | no       | Working directory of the Claude process        |
| model            | string | no       | Model name (on SessionStart)                   |
| prompt           | string | no       | User prompt text (on UserPromptSubmit)         |
| tool_name        | string | no       | Tool name (on PreToolUse/PostToolUse/PermissionRequest) |
| tool_input       | object | no       | Tool input parameters (on PreToolUse/PermissionRequest) |
| response         | string | no       | Response text (on Stop)                        |
| message          | string | no       | Notification message (on Notification)         |
| reason           | string | no       | End reason (on SessionEnd)                     |
| agent_type       | string | no       | Subagent type (on SubagentStart)               |
| agent_id         | string | no       | Subagent ID (on SubagentStart/SubagentStop)    |
| permission_mode  | string | no       | Permission mode (on SessionStart/PermissionRequest) |
| transcript_path  | string | no       | Path to transcript file (on SessionStart)      |
| source           | string | no       | Session source identifier (on SessionStart)    |

**Enrichment fields (added by dashboard-hook.sh):**

| Field             | Type   | Description                                          |
|-------------------|--------|------------------------------------------------------|
| claude_pid        | number | PID of the Claude process (`$PPID`)                  |
| tty_path          | string | TTY device path (e.g., `/dev/ttys003`)               |
| term_program      | string | Terminal emulator name (from `$TERM_PROGRAM`)        |
| tab_id            | string | Terminal tab identifier                               |
| vscode_pid        | string | VS Code extension host PID (from `$VSCODE_PID`)     |
| agent_terminal_id | string | SSH terminal ID (from `$AGENT_TERMINAL_ID`)          |
| window_id         | string | X11/macOS window ID                                  |
| tmux              | object | Tmux context: `{ session, window, pane }`            |
| hook_sent_at      | number | Unix timestamp in ms when the hook was sent          |

### Event Types

**Claude Code events:**

| Event               | Description                            | Key Fields               |
|----------------------|----------------------------------------|--------------------------|
| SessionStart         | New Claude session started             | model, cwd, source       |
| UserPromptSubmit     | User sent a prompt                     | prompt                   |
| PreToolUse           | Tool call about to execute             | tool_name, tool_input    |
| PostToolUse          | Tool call completed successfully       | tool_name                |
| PostToolUseFailure   | Tool call failed                       | tool_name, error         |
| PermissionRequest    | User approval needed for tool          | tool_name, tool_input    |
| Stop                 | Claude finished its response turn      | response                 |
| Notification         | System notification                    | message, title           |
| SubagentStart        | Subagent spawned                       | agent_type, agent_id     |
| SubagentStop         | Subagent finished                      | agent_id                 |
| TeammateIdle         | Teammate agent is idle                 | agent_name, agent_id     |
| TaskCompleted        | A tracked task completed               | task_id, task_description|
| PreCompact           | Context window compaction starting     | -                        |
| SessionEnd           | Session terminated                     | reason                   |

**Gemini CLI events:**

| Event       | Description                  |
|-------------|------------------------------|
| BeforeAgent | Gemini agent turn starting   |
| BeforeTool  | Gemini tool call starting    |
| AfterTool   | Gemini tool call completed   |
| AfterAgent  | Gemini agent turn completed  |

**Codex events:**

| Event               | Description               |
|----------------------|---------------------------|
| agent-turn-complete  | Codex agent turn finished |

### Hook Density Levels

The number of registered events varies by density:

| Density | Events Count | Description                                              |
|---------|-------------|----------------------------------------------------------|
| high    | 14          | All events including TeammateIdle, PreCompact            |
| medium  | 12          | Excludes TeammateIdle, PreCompact                        |
| low     | 5           | Only SessionStart, UserPromptSubmit, PermissionRequest, Stop, SessionEnd |

---

## WebSocket Protocol

### Connection

```
ws://localhost:3333
```

On connect, the server immediately sends a `snapshot` message containing all current sessions, teams, and the event sequence number.

Heartbeat: server pings every 30s. Clients that fail to respond within 10s are terminated.

### Server to Client Messages

#### snapshot

Sent once on connection. Contains full dashboard state.

```json
{
  "type": "snapshot",
  "sessions": {
    "session-id-1": {
      "sessionId": "session-id-1",
      "projectPath": "/Users/user/project",
      "projectName": "project",
      "status": "working",
      "animationState": "Running",
      "emote": null,
      "model": "claude-sonnet-4-5-20250929",
      "startedAt": 1707750000000,
      "lastActivityAt": 1707753600000,
      "currentPrompt": "Fix the login bug",
      "promptHistory": [{ "text": "Fix the login bug", "timestamp": 1707753600000 }],
      "toolUsage": { "Read": 3, "Edit": 2, "Bash": 1 },
      "totalToolCalls": 6,
      "toolLog": [{ "tool": "Read", "input": "src/auth.js", "timestamp": 1707753601000 }],
      "responseLog": [{ "text": "I have fixed...", "timestamp": 1707753650000 }],
      "events": [{ "type": "PreToolUse", "detail": "Read", "timestamp": 1707753601000 }],
      "label": "",
      "title": "project #1 -- Fix the login bug",
      "source": "vscode",
      "queueCount": 0,
      "subagentCount": 0
    }
  },
  "teams": {
    "team-abc": {
      "teamId": "team-abc",
      "parentSessionId": "session-id-1",
      "children": ["session-id-2", "session-id-3"]
    }
  },
  "seq": 42
}
```

#### session_update

Sent when any session's state changes (new event, status change, etc.).

```json
{
  "type": "session_update",
  "session": { "...session object..." },
  "team": { "...optional team object if session belongs to a team..." }
}
```

If the session includes a `replacesId` field, the client should remove the old session card and replace it with the new one (happens during session resume with re-keying).

#### session_removed

Sent when a session is permanently deleted.

```json
{
  "type": "session_removed",
  "sessionId": "session-id-1"
}
```

#### team_update

Sent when team membership changes (subagent joined or left).

```json
{
  "type": "team_update",
  "team": {
    "teamId": "team-abc",
    "parentSessionId": "session-id-1",
    "children": ["session-id-2"]
  }
}
```

#### hook_stats

Periodic performance statistics for hook processing. Throttled to at most once per second.

```json
{
  "type": "hook_stats",
  "stats": { "...same format as GET /api/hook-stats..." }
}
```

#### terminal_output

Terminal data from a node-pty session (sent only to subscribers).

```json
{
  "type": "terminal_output",
  "terminalId": "term-abc123",
  "data": "$ claude --resume\r\n"
}
```

#### terminal_ready

Sent when a terminal session is ready.

```json
{
  "type": "terminal_ready",
  "terminalId": "term-abc123"
}
```

#### terminal_closed

Sent when a terminal session closes.

```json
{
  "type": "terminal_closed",
  "terminalId": "term-abc123"
}
```

#### clearBrowserDb

Sent in response to `POST /api/reset`. Instructs browsers to wipe IndexedDB.

```json
{
  "type": "clearBrowserDb"
}
```

### Client to Server Messages

#### terminal_input

Send keystrokes to a terminal.

```json
{
  "type": "terminal_input",
  "terminalId": "term-abc123",
  "data": "ls -la\r"
}
```

#### terminal_resize

Resize a terminal.

```json
{
  "type": "terminal_resize",
  "terminalId": "term-abc123",
  "cols": 120,
  "rows": 40
}
```

#### terminal_disconnect

Disconnect from a terminal (closes it server-side).

```json
{
  "type": "terminal_disconnect",
  "terminalId": "term-abc123"
}
```

#### terminal_subscribe

Subscribe to terminal output events. Must be sent before receiving `terminal_output` messages.

```json
{
  "type": "terminal_subscribe",
  "terminalId": "term-abc123"
}
```

#### update_queue_count

Update the prompt queue count displayed on a session card.

```json
{
  "type": "update_queue_count",
  "sessionId": "session-id-1",
  "count": 3
}
```

#### replay

Request missed events since a sequence number (for reconnect catch-up). The server replays events from its 500-event ring buffer.

```json
{
  "type": "replay",
  "sinceSeq": 42
}
```

The server responds by sending individual `session_update` / `team_update` messages for each missed event.

### Backpressure and Throttling

- **hook_stats** broadcasts are throttled to once per second
- Non-critical messages (hook_stats) are dropped if a client's send buffer exceeds 1MB
- Critical messages (session_update, snapshot, session_removed) are never dropped

---

## Rate Limiting

| Endpoint                     | Limit                           |
|------------------------------|---------------------------------|
| POST /api/hooks              | 100 requests/sec per IP         |
| POST /api/sessions/:id/summarize | 2 concurrent requests max  |
| POST /api/terminals          | 10 terminals max total          |

Rate limit buckets are cleaned up every 30 seconds. Exceeding limits returns HTTP 429.

---

## Error Responses

All error responses follow a consistent format:

```json
{
  "success": false,
  "error": "Human-readable error message"
}
```

Or for some endpoints:

```json
{
  "error": "Human-readable error message"
}
```

Common HTTP status codes:

| Status | Meaning                                    |
|--------|--------------------------------------------|
| 200    | Success                                    |
| 400    | Bad request (validation error)             |
| 404    | Resource not found                         |
| 429    | Rate limit exceeded or concurrent cap hit  |
| 500    | Internal server error                      |
