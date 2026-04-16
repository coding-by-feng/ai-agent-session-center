# VS Code-style PTY Host

## Function
Manages node-pty terminal processes directly in Electron main process with IPC relay to renderer, output buffering, and shell-ready detection.

## Purpose
Provides ~10x lower latency than WebSocket terminal relay (~0.1ms IPC vs ~1-5ms WS), no auth needed, and reliable lifecycle management tied to the app process.

## Source Files
| File | Role |
|------|------|
| `electron/ptyHost.ts` | PTY creation, output buffering (128KB ring), shell-ready detection, server registration, cleanup |

## Implementation

### PtyInstance Structure

```
PtyInstance {
  id: "pty-{Date.now()}-{random6}"
  process: IPty
  config: PtyCreateConfig
  outputBuffer: Buffer (128KB ring)
  disposables: IDisposable[]
  shellReady: Promise<boolean>
}
```

### Creation Flow

1. Generate `terminalId` (`pty-{Date.now()}-{random6}`)
2. Resolve shell (`$SHELL` or `/bin/bash` fallback)
3. Build environment: `process.env` + `AGENT_MANAGER_TERMINAL_ID` + CLI-specific API key, strip `CLAUDECODE` env var (prevents nested-session detection)
4. Spawn PTY via `pty.spawn(shell, ['-l'], ...)` with xterm-256color, 120x40, cwd, env
5. Subscribe output: append to ring buffer + send `pty:data` (base64) to all renderer windows
6. Subscribe exit: send `pty:exit` (exitCode, signal) + cleanup
7. `detectShellReady()` -- wait for shell prompt (concurrent with steps 8-9)
8. Register with Express server: `POST /api/terminals/register` (async, best effort)
9. After shell ready: write launch command + `\r` (e.g. `"claude -n \"agent-manager #1\"\r"`)
10. If `config.model` or `config.effortLevel` are set and the command is `claude`, auto-apply `/model <model>` and `/effort <level>` slash commands after Claude Code starts (detected via a brief delay post-launch)

### Session Name Flag (`-n`)
- Claude commands get `-n "title"` appended automatically
- If `config.sessionTitle` is provided, uses that; otherwise auto-generates `projectName #N`
- Auto-name counter is per-project via `ptyProjectCounters` map (e.g. "agent-manager #1", "thesis #2")
- `autoSessionName()` helper derives the project name from the working directory basename and increments the per-project counter
- Only for commands starting with `claude`; skips if `-n` or `--name` already present
- `appendSessionName()` and `autoSessionName()` helpers defined locally in ptyHost.ts
10. Return `terminalId` (synchronous -- caller wraps in `{ok, terminalId}`)

### Shell-Ready Detection

- Buffer output up to 4096 bytes
- Strip ANSI escape sequences: `/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g`
- After 50ms of silence, check if last line matches `/[#$%>]\s*$/`
- Timeout: 2000ms (local terminals)

### Output Buffer

128KB ring buffer (`OUTPUT_BUFFER_MAX = 128 * 1024`). On `pty:subscribe`, the full buffer is returned for instant replay of terminal history.

### Server Registration

`POST http://localhost:{port}/api/terminals/register` with payload:

```json
{
  "terminalId": "pty-...",
  "host": "localhost",
  "workingDir": "/path/to/project",
  "command": "claude",
  "label": "Session Label",
  "sessionTitle": "Title",
  "source": "electron-pty"
}
```

This creates a CONNECTING session card and registers a pending link for session matcher Priority 2.

### API Key Injection

The PTY host injects CLI-specific API keys into the spawned shell environment:
- Commands starting with `codex` -> `OPENAI_API_KEY`
- Commands starting with `gemini` -> `GEMINI_API_KEY`
- All others -> `ANTHROPIC_API_KEY`

### API

| Method | Description |
|--------|-------------|
| `createPty(config)` | Create PTY, returns terminalId |
| `writePty(id, data)` | Write data to PTY stdin (strips terminal response sequences like focus events and Device Attributes via `TERMINAL_RESPONSE_RE` regex) |
| `resizePty(id, cols, rows)` | Resize PTY dimensions |
| `killPty(id)` | Kill PTY process and clean up |
| `getOutputBuffer(id)` | Get ring buffer contents (string or null) |
| `hasPty(id)` | Check if PTY exists |
| `listPtys()` | List all active PTY IDs |
| `disposeAll()` | Kill all PTYs and clean subscriptions |

### PtyCreateConfig

```typescript
{
  workingDir?: string
  command?: string
  label?: string
  sessionTitle?: string
  apiKey?: string
  enableOpsTerminal?: boolean
  effortLevel?: string
  model?: string
}
```

### Cleanup

`app.before-quit` -> `disposeAll()` (imported as `disposePtyHost` in main.ts) kills all PTY processes and cleans up all subscriptions.

## Dependencies & Connections

### Depends On
- [Server Terminal/SSH](../server/terminal-ssh.md) -- POST /api/terminals/register for session store integration
- [Server Session Matching](../server/session-matching.md) -- pending link registered for Priority 2 matching
- [App Lifecycle](./app-lifecycle.md) -- disposePtyHost() called on app quit

### Depended On By
- [IPC Transport](./ipc-transport.md) -- terminalHandlers bridge renderer to ptyHost
- [Frontend Terminal UI](../frontend/terminal-ui.md) -- IPC transport for terminal I/O

### Shared Resources
- node-pty processes
- Output ring buffers per terminal

## Change Risks
- Stripping `CLAUDECODE` env vars is critical -- without it, Claude thinks it is a nested session and behaves differently.
- Shell-ready detection regex must handle diverse prompt formats (bash, zsh, fish). A narrow regex will cause timeouts on uncommon shells.
- Output buffer overflow causes data loss on replay -- old data is silently overwritten in the ring buffer.
- Missing server registration means the session will not appear in the dashboard, breaking the session matching pipeline.
- The 50ms silence threshold for shell-ready detection is a heuristic -- slow shells or shells with complex prompts may need more time.
- Changing the ring buffer size affects memory usage proportionally to the number of active terminals.
