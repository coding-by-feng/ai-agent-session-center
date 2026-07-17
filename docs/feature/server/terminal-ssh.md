# SSH/PTY Terminal Management

## Function
Creates and manages PTY terminal processes for SSH connections, local shells, and tmux sessions.

## Purpose
Enables the dashboard to create interactive terminal sessions that connect to AI CLI processes. This is how users launch and monitor Claude/Gemini/Codex.

## Source Files
| File | Role |
|------|------|
| `server/sshManager.ts` (~1100 lines) | PTY creation, shell-ready detection, output ring buffer, pending links, slash-command injection |
| `server/config.ts` | Provides `appendSessionName` (injects `-n "title"`) and `applyClaudeLaunchFlags` (appends `--model`/`--effort`) — called as one nested expression at sshManager.ts:371-372, with `applyClaudeLaunchFlags` wrapping `appendSessionName`; also `CLAUDE_TUI_ENV_DEFAULTS` / `withClaudeTuiEnvDefaults` (classic-renderer env defaults for spawned PTYs; unit-tested in `test/claudeTuiEnv.test.ts`) |
| `src/types/terminal.ts` | Shared `Terminal` / `TerminalConfig` / `TerminalInfo` / `TmuxSessionInfo` / `SshKeyInfo` types (PTY, wsClient, output ring fields); also the replay-buffer constants `DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES` / `MIN_…` / `MAX_…` and `clampReplayBufferBytes()` |

## Implementation

### Terminal Modes
- 4 terminal modes: local direct (node-pty + $SHELL), remote SSH (ssh -t -i keyfile user@host), tmux attach, tmux new

### PTY Spawn
- xterm-256color, 120x40
- env includes AGENT_MANAGER_TERMINAL_ID + optional API keys + `withClaudeTuiEnvDefaults` (see Environment)

### Terminal ID Format
- Standard: term-{Date.now()}-{random6}
- Tmux: term-tmux-{Date.now()}-{random6}

### Shell-Ready Detection
- `detectShellReady(ptyProcess, terminalId, timeoutMs)` buffers output (cap 4096 bytes, tail-trimmed), strips ANSI (`ANSI_ESC_RE`)
- After 50ms silence (settle timer) check if last non-empty line matches `SHELL_PROMPT_RE` = `/[#$%>]\s*$/` and is < 200 chars
- Timeouts (fallback timer): local 2000ms, remote SSH 10000ms
- On timeout or early PTY exit, resolves `false`; the launch command is still written with a warning
- The resolved `shellReady` promise is stored on the `Terminal` and awaited by `writeWhenReady`

### Output Ring Buffer
- **Configurable size, pre-allocated** per terminal: `Buffer.alloc(replayBufferBytes)`, where `replayBufferBytes` is a module-level variable (default `DEFAULT_TERMINAL_REPLAY_BUFFER_BYTES = 2 * 1024 * 1024` = 2 MB, raised from the former hard-coded 128 KB). The default + clamp constants live in `src/types/terminal.ts` (`MIN_TERMINAL_REPLAY_BUFFER_BYTES = 256 * 1024`, `MAX_TERMINAL_REPLAY_BUFFER_BYTES = 32 * 1024 * 1024`, `clampReplayBufferBytes()`).
- `setReplayBufferBytes(bytes)` (exported) updates the module variable, clamped to `[0.25 MB, 32 MB]`; it is driven by `POST /api/config/terminal-buffer` (see [API Endpoints](./api-endpoints.md)), which the browser pushes from the `terminalReplayBufferBytes` setting (Settings ▸ ADVANCED ▸ Terminal, see [Settings System](../frontend/settings-system.md)). The ring is allocated **once at create time**, so a changed setting applies only to terminals created afterward.
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
- tmuxSession max 128, regex `/^[a-zA-Z0-9_.\-]+$/` — alphanumerics plus underscore, dot, hyphen (`TMUX_SESSION_RE`, sshManager.ts:36)
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
- For remote SSH connections (`!local && config.password`), a watcher buffers PTY output (cap 4096 bytes, tail-trimmed), strips ANSI (`ANSI_ESC_RE`), and lowercases it to match `password:` / `password for`. On match it writes the stored password + `\r` after a 100ms delay, then resets the buffer so the same prompt can't re-trigger.
- Capped at `maxAttempts = 2` — a 3rd prompt logs an error (`SSH password rejected after 2 attempts`) and disposes the watcher.
- Self-disposes once auth succeeds (`last login` in output, or the last non-empty line matches `SHELL_PROMPT_RE`), and unconditionally after a 30s safety timeout (sshManager.ts:434-468).

### Folder-Trust Auto-Confirm
- For every terminal (including `deferredLaunch` ones), a watcher buffers PTY output (cap 8192 bytes), strips ANSI, and collapses whitespace/punctuation to robustly match Claude Code's "Yes, I trust this folder" prompt (`yesitrustthisfolder`). On match it writes `\r` to auto-accept. Watcher self-disposes after 60s.

### Auto-Apply Model/Effort
- **Standard model + effort are applied as launch flags**, not slash commands. `applyClaudeLaunchFlags(command, model, effortLevel)` (server/config.ts) appends `--model <model>` and `--effort <level>` to the `claude` command before it runs, so the flags take effect deterministically before the first prompt (fixes the prior race where `/effort` keystrokes were dropped behind the `/model` re-render, leaving effort at `high`).
- **Model values are sanitized before they reach the unquoted `--model` flag** (`--model <model>` is interpolated without quotes). `sanitizeModelId` cleans the model argument; `sanitizeModelInCommand` additionally rewrites a `--model` token **already baked into a reused command** (clone via `buildResumeCommand`-style flow, resume, fork — all funnel through `applyClaudeLaunchFlags`). This fixes a class of spawn failures where an older/restored session stored a model polluted with a stripped ANSI bold escape (e.g. `claude-opus-4-8[1m]`): unsanitized, zsh treated `[1m]` as a glob → `no matches found: claude-opus-4-8[1m]` → clone/popup/reconnect never launched. The contaminated value is recovered (`claude-opus-4-8`) or the flag dropped. `startupCommand` is also scrubbed at its entry points (hook store in `sessionStore.ts`, workspace-import in `apiRouter.ts`) so the raw-reuse paths (reconnect, snapshot startup-launch) stay clean.
- Flag-eligible effort levels (`config.ts` `FLAG_EFFORT_LEVELS`): `low`/`medium`/`high`/`xhigh`/`max`. `ultracode` is not in that set (the raw `--effort` flag rejects it) — instead it launches as `--effort xhigh` (its valid base level) and is then upgraded to true ultracode via the post-startup `/effort ultracode` slash injection.
- The `POST /api/terminals` Zod `effortLevel` enum accepts `low/medium/high/xhigh/max/ultracode`; an out-of-set value falls back to "no effort override" (`.catch(undefined)`). `model` is **not** an enum: it is a free-form string, max 100, charset-restricted via `/^[a-zA-Z0-9._-]+$/` (apiRouter.ts:236-240) — so it accepts an alias (`fable`/`opus`/`sonnet`/`haiku`) or a full model ID (e.g. `claude-opus-4-8`). The regex mirrors `SAFE_MODEL_RE` (config.ts:202) precisely because the value is interpolated unquoted into `--model`.

### Post-Startup Slash Injection (ultracode / remote-control)
- After the launch command is written, if `effortLevel === 'ultracode'` or `remoteControlName` is set (and the base command starts with `claude`), an inline watcher waits for the string `Claude Code` in PTY output, settles 2500ms, then writes `/effort ultracode` and/or `/remote-control <name>` sequentially with 800ms gaps. Self-disposes after 30s.
- `injectClaudeCommandsWhenReady(terminalId, cmds)` is the exported version of this same logic (2.5s settle + 800ms gaps). It is used by the floating-session spawner, which writes its own launch command and so bypasses `createTerminal`'s inline injection.

### Environment
- `CLAUDECODE` env var is stripped from the spawned PTY environment to avoid conflicts
- **`CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` is set by default** on every spawned PTY (local and tmux-attach paths via `withClaudeTuiEnvDefaults` from `server/config.ts`; remote SSH paths via `export CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN="${CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN:-1}"` in the launch command). Claude Code ≥ 2.1.150 defaults to its fullscreen alt-screen renderer, which enables xterm mouse tracking (DECSET 1000/1002/1003/1006) — inside the dashboard's xterm.js terminals that captures every drag, killing text selection (and with it the select-to-translate/explain AI popup) and degrading scrollback-based features. The env var is Claude Code's official opt-out and takes precedence over the user's `tui` setting. A pre-existing value always wins (`key in env` guard / `${VAR:-1}` on SSH), so exporting `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=0` in the shell profile opts a machine back into fullscreen (⌥-drag then remains the only way to select text — see [Terminal UI](../frontend/terminal-ui.md))

### Local Address Detection
- Detects local addresses via hostname, `.local` suffix, and network interface addresses to distinguish local vs remote connections

### Security
- API keys passed via env object, never interpolated into shell command strings

### Additional Exports
- registerTerminalExitCallback(cb) — register callback for terminal exit events; sessionStore registers one to null `session.terminalId` when the PTY dies
- listSshKeys() — enumerate `~/.ssh/` key files (excludes `.pub`, `known_hosts`, `config`, `authorized_keys`, dotfiles); consumed by `GET /api/ssh-keys`
- listTmuxSessions(config) — list tmux sessions on a local or remote host; consumed by `POST /api/tmux-sessions`
- attachToTmuxPane(tmuxPaneId, wsClient) — attach to an existing tmux pane (`%N` format); consumed by `POST /api/teams/:teamId/members/:sessionId/terminal`
- writeWhenReady(terminalId, data) (sshManager.ts:801) — await the `shellReady` promise, then write to PTY
- injectClaudeCommandsWhenReady(terminalId, cmds) (sshManager.ts:818) — watch for Claude Code readiness then inject slash commands (2.5s settle + 800ms gaps); used by floatingSessionSpawner
- writeToTerminal(terminalId, data) (sshManager.ts:788) — direct write to PTY, stripping `TERMINAL_RESPONSE_RE`; consumed by `POST /api/terminals/:id/write` and wsManager terminal relay
- resizeTerminal(terminalId, cols, rows) (sshManager.ts:850) — returns error string on failure for wsManager relay
- closeTerminal(terminalId) (sshManager.ts:865) — sends per-PTY `pty.kill` (group SIGHUP); used by fork/clone close paths to avoid touching the origin's claude PID
- consumePendingLink(workDir, terminalId?) (sshManager.ts:923) — remove a specific pendingLink entry (or the front entry); called after Priority-0 resume match
- tryLinkByWorkDir(workDir, sessionId) (sshManager.ts:899) — FIFO-consume a pendingLink and link the terminal; used by Priority-2 session matcher
- getTerminalForSession(sessionId) — look up terminal for a session; used by processMonitor
- getTerminalByPtyChild(childPid) — find terminal whose PTY is parent of given PID (via `ps -o ppid=`); used by Priority-4 PID-parent matching in sessionMatcher
- getTerminalOutputBuffer(terminalId) (sshManager.ts:993) — get buffered output for replay; consumed by `GET /api/terminals/:id/output` (apiRouter.ts:1432) for the REVIEW tab
- getTerminalOutputTail(terminalId, maxBytes = 2048) (sshManager.ts:1004) — linearize the ring and return only the last `maxBytes` as UTF-8; used by server-side screen-tail heuristics (approval / thinking-spinner detection in `sessionStore.ts:736`) that need the live tail of the screen, not the whole scrollback
- prefillTerminalOutput(terminalId, base64Data) (sshManager.ts:1016) — prepend saved output into the ring buffer; consumed by `POST /api/terminals/:id/prefill-output`
- getTerminals() — list all active terminals with metadata; consumed by `GET /api/terminals`
- linkSession(terminalId, sessionId) — associate a session with a terminal
- setWsClient(terminalId, wsClient) (sshManager.ts:966) — attach a ws client to a terminal, send `terminal_ready`, and replay the ring buffer (used on browser reconnect); returns `false` if the terminal no longer exists
- `__addPendingLinkForTest` / `__resetPendingLinksForTest` / `__getPendingLinksSizeForTest` / `__getPendingLinksForWorkDirForTest` — test-only helpers, no production callers

### Fork / Clone / Floating Sessions
- Fork, clone, and floating-session flows are layered on top of the same `createTerminal` + `createTerminalSession` primitives. The `isFork`/`isFloating` flags flow through `createTerminalSession(config)` (session metadata), not through `createTerminal` (PTY spawn) — sshManager has no fork-specific code path. `isFork` guards the kill flow; `isFloating` (floating popups only) hides the session from the lists.

### Limits
- Max 50 terminals simultaneously (enforced by apiRouter)

## Dependencies & Connections

### Depends On
- [Session Management](./session-management.md) — creates CONNECTING session on terminal creation
- [Session Matching](./session-matching.md) — registers pending links for hook matching
- [WebSocket Manager](./websocket-manager.md) — relays terminal I/O via WebSocket (browser transport)

### Depended On By
- [API Endpoints](./api-endpoints.md) — `POST /api/terminals`, `GET /api/terminals`, `DELETE /api/terminals/:id`, `POST /api/terminals/register`, `GET /api/terminals/:id/output`, `POST /api/terminals/:id/prefill-output`, `POST /api/terminals/:id/write`, `GET /api/ssh-keys`, `POST /api/tmux-sessions`, `POST /api/teams/:teamId/members/:sessionId/terminal`
- [Session Matching](./session-matching.md) — calls `tryLinkByWorkDir`, `getTerminalByPtyChild`, `consumePendingLink`
- [Floating Session Spawner](./floating-session-spawner.md) — reuses `createTerminal` + `writeWhenReady` + `injectClaudeCommandsWhenReady`
- [Process Monitor](./process-monitor.md) — calls `getTerminalForSession`
- [WebSocket Manager](./websocket-manager.md) — calls `writeToTerminal`, `resizeTerminal`, `setWsClient` for the terminal relay
- [Terminal UI](../frontend/terminal-ui.md) — terminal I/O relay (browser transport)
- [PTY Host](../electron/pty-host.md) — `POST /api/terminals/register` for session store integration

### Shared Resources
- PTY processes
- Output ring buffers
- pendingLinks Map (`Map<string, PendingLink[]>` — array-per-workDir so multiple terminals sharing a project path don't overwrite each other; `tryLinkByWorkDir` consumes FIFO from the front, `consumePendingLink(workDir, terminalId?)` removes a specific entry or the front)

## Change Risks
- Breaking shell-ready detection means commands sent before prompt, causing garbled output
- **Removing the `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN` default breaks the AI popup**: Claude Code's fullscreen renderer captures the mouse, so drag-selection in xterm.js stops producing selections and `SelectionPopup` can never open. It also empties xterm scrollback (alt screen), degrading terminal bookmarks, find, and REVIEW-tab output snapshots. Keep the default in sync between `server/config.ts` and its mirror in `electron/ptyHost.ts`
- Changing input validation opens injection vectors
- Modifying pending links breaks session matching for SSH terminals
- Ring buffer size affects reconnect replay quality; it is now user-configurable (default 2 MB). Raising it multiplies resident memory by the live-terminal count (the ring is pre-allocated) and enlarges workspace snapshots (which base64-save the ring) — clamped to 32 MB to bound both. Keep the default + clamp in `src/types/terminal.ts` in sync with the electron copy in `electron/ptyHost.ts` (which does not import that module at runtime).
- The ring buffer is pre-allocated and uses `Buffer.copy` internally — any code path that still reads `term.outputBuffer` will throw (`undefined`). Use `getTerminalOutputBuffer(id)` or `ringSnapshot(term)` instead.
- `prefillTerminalOutput` linearizes existing ring content, prepends the saved data, trims to **this terminal's own ring capacity** (`term.outputRing.length`, which may differ from the current global setting if the buffer size changed after the terminal was created), then `ringReset`s. Workspace-snapshot import relies on this for scrollback restore; breaking linearization drops imported history.
- `createTerminal` falls back to `os.homedir()` for the PTY cwd when the requested `workingDir` no longer exists on disk; without the fallback, `pty.spawn` throws ENOENT and the session card is never created.
