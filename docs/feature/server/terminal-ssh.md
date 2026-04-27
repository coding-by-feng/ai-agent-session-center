# SSH/PTY Terminal Management

## Function
Creates and manages PTY terminal processes for SSH connections, local shells, and tmux sessions.

## Purpose
Enables the dashboard to create interactive terminal sessions that connect to AI CLI processes. This is how users launch and monitor Claude/Gemini/Codex.

## Source Files
| File | Role |
|------|------|
| `server/sshManager.ts` (~32KB, ~850 lines) | PTY creation, shell-ready detection, output buffering, pending links |
| `src/types/terminal.ts` | Shared `Terminal` interface (PTY, wsClient, output ring fields) |

## Implementation

### Terminal Modes
- 4 terminal modes: local direct (node-pty + $SHELL), remote SSH (ssh -t -i keyfile user@host), tmux attach, tmux new

### PTY Spawn
- xterm-256color, 120x40
- env includes AGENT_MANAGER_TERMINAL_ID + optional API keys

### Terminal ID Format
- Standard: term-{Date.now()}-{random6}
- Tmux: term-tmux-{Date.now()}-{random6}

### Shell-Ready Detection
- Buffer output (max 4096 bytes), strip ANSI
- After 50ms silence (settle timer) check if last line matches [#$%>]\s*$ and < 200 chars
- Timeouts: local 2s, remote SSH 10s
- On timeout, command sent anyway with warning

### Output Ring Buffer
- 128KB **pre-allocated** per terminal (`OUTPUT_BUFFER_MAX = 128 * 1024`).
- The `Terminal` interface stores `outputRing: Buffer`, `outputOffset: number`, `outputWrapped: boolean` — NOT `outputBuffer`. All appends go through the file-local `ringWrite()` helper; snapshots (for `getTerminalOutputBuffer`, `prefillTerminalOutput`, and `setWsClient` replay) go through `ringSnapshot()` which linearizes the ring (oldest → newest).
- This replaces the previous `Buffer.concat([old, chunk])` + `slice(-cap)` pattern, which was O(n) per PTY write and allocated a new Buffer for every onData event. The new path is O(1) per append with zero steady-state allocation.
- Ring helpers (`ringWrite`, `ringSnapshot`, `ringLength`, `ringReset`) are module-local; do not export — callers should use the existing buffer API (`getTerminalOutputBuffer`, `prefillTerminalOutput`).

### Pending Links
- workDir -> {terminalId, host, createdAt}
- Expires 60s (cleaned every 30s)
- Used by session matcher Priority 2

### Input Validation
- Zod + shell metacharacter regex /[;|&$`\\!><()\n\r{}[\]]/
- workingDir max 1024 chars, command max 512
- tmuxSession max 128 (only alnum)
- host max 255, username max 128, port 1-65535

### Session Name Flag (`-n`)
- Claude commands automatically get `-n "title"` appended for session naming
- If user provides a `sessionTitle`, that value is used
- If not, an auto-generated name is used: `projectName #N` (sequence counter per project, e.g. "agent-manager #1", "thesis #2")
- Only applies to commands starting with `claude` (Gemini/Codex ignored)
- Skips if command already contains `-n` or `--name` flag
- `appendSessionName()` helper in `server/config.ts` handles escaping and dedup
- `autoSessionName()` in sshManager.ts manages the per-project counter

### Terminal Response Stripping
- `TERMINAL_RESPONSE_RE` regex strips focus events and Device Attributes responses from terminal input before processing

### SSH Password Auto-Typing
- For remote SSH connections, password is auto-typed when a password prompt is detected

### Auto-Apply Model/Effort
- After Claude Code starts in a terminal, the configured model and effort level are automatically applied

### Environment
- `CLAUDECODE` env var is stripped from the spawned PTY environment to avoid conflicts

### Local Address Detection
- Detects local addresses via hostname, `.local` suffix, and network interface addresses to distinguish local vs remote connections

### Security
- API keys passed via env object, never interpolated into shell command strings

### Additional Exports
- registerTerminalExitCallback(cb) — register callback for terminal exit events
- listSshKeys() — enumerate available SSH key files
- listTmuxSessions(config) — list tmux sessions on a host
- attachToTmuxPane(tmuxPaneId, wsClient) — attach to existing tmux pane
- writeWhenReady(terminalId, data) — write after shell-ready detection completes
- consumePendingLink(workDir) — manually consume a pendingLink entry
- getTerminalForSession(sessionId) — look up terminal for a session
- getTerminalByPtyChild(childPid) — find terminal whose PTY is parent of given PID
- getTerminalOutputBuffer(terminalId) — get buffered output for replay
- prefillTerminalOutput(terminalId, base64Data) — inject saved output into buffer
- getTerminals() — list all active terminals with metadata
- linkSession(terminalId, sessionId) — associate a session with a terminal

### Limits
- Max 50 terminals simultaneously (enforced by apiRouter)

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — creates CONNECTING session on terminal creation
- [Session Matching](./session-matching.md) — registers pending links for hook matching
- [WebSocket Manager](./websocket-manager.md) — relays terminal I/O via WebSocket (browser transport)

### Depended On By
- [API Endpoints](./api-endpoints.md) — POST /api/terminals, DELETE /api/terminals/:id
- Frontend terminal UI — terminal I/O relay (browser transport)
- Electron PTY host — POST /api/terminals/register for session store integration

### Shared Resources
- PTY processes
- Output ring buffers
- pendingLinks Map

## Change Risks
- Breaking shell-ready detection means commands sent before prompt, causing garbled output
- Changing input validation opens injection vectors
- Modifying pending links breaks session matching for SSH terminals
- Ring buffer size affects reconnect replay quality
- The ring buffer is pre-allocated and uses `Buffer.copy` internally — any code path that still reads `term.outputBuffer` will throw (`undefined`). Use `getTerminalOutputBuffer(id)` or `ringSnapshot(term)` instead.
- `prefillTerminalOutput` linearizes existing ring content, prepends the saved data, trims to cap, then `ringReset`s. Workspace-snapshot import relies on this for scrollback restore; breaking linearization drops imported history.
