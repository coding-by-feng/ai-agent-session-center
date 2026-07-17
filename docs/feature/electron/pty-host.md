# VS Code-style PTY Host

## Function
Manages node-pty terminal processes directly in Electron main process with IPC relay to renderer, output buffering, and shell-ready detection.

## Purpose
Provides ~10x lower latency than WebSocket terminal relay (~0.1ms IPC vs ~1-5ms WS), no auth needed, and reliable lifecycle management tied to the app process.

## Source Files
| File | Role |
|------|------|
| `electron/ptyHost.ts` | PTY creation, output buffering (configurable ring, default 2MB), shell-ready detection, server registration, cleanup; exports `setReplayBufferBytes()` |

## Implementation

### PtyInstance Structure

```
PtyInstance {
  id: "pty-{Date.now()}-{random6}"
  process: IPty
  config: PtyCreateConfig
  ring: Buffer (pre-allocated, replayBufferBytes; default 2MB)
  ringOffset: number         // next write position
  ringWrapped: boolean       // true once ring is full
  disposables: IDisposable[]
  shellReady: Promise<boolean>
  subscribers: Set<WebContents>  // renderer windows currently viewing this PTY
}
```

### Creation Flow

1. Generate `terminalId` (`pty-{Date.now()}-{random6}`)
2. Resolve shell (`$SHELL` or `/bin/bash` fallback)
3. Build environment: `process.env` + `AGENT_MANAGER_TERMINAL_ID` + CLI-specific API key, strip `CLAUDECODE` env var (prevents nested-session detection), then apply `withClaudeTuiEnvDefaults` — sets `CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1` (unless already defined) so Claude Code ≥ 2.1.150 uses its classic renderer instead of the mouse-capturing fullscreen alt-screen TUI, keeping xterm drag-selection and the AI popup working (mirrors `server/config.ts` `CLAUDE_TUI_ENV_DEFAULTS`; see [Terminal/SSH → Environment](../server/terminal-ssh.md))
4. Spawn PTY via `pty.spawn(shell, ['-l'], ...)` with xterm-256color, 120x40, cwd, env
5. Subscribe output: append to ring buffer via `ringWrite()` (O(1) pre-allocated slab, no `Buffer.concat`) + send `pty:data` (base64) **only to subscribed `WebContents`** (see Subscriber Gating below)
6. Subscribe exit: send `pty:exit` (exitCode, signal) to all windows + cleanup
7. `detectShellReady()` -- wait for shell prompt (concurrent with steps 8-9)
8. Register with Express server: `POST /api/terminals/register` (async, best effort)
9. **Model + standard effort apply as launch flags, not slash injection.** Before spawn, `applyClaudeLaunchFlags()` rewrites a `claude` command to inject `--model <model>` and `--effort <level>` (only when `level ∈ FLAG_EFFORT_LEVELS`), so model/effort apply deterministically at launch. This mirrors `server/config.ts` `applyClaudeLaunchFlags()` (config.ts:277). `ultracode` is not in `FLAG_EFFORT_LEVELS` (the raw `--effort` flag rejects it) but is mapped to `--effort xhigh` at launch, then upgraded to true ultracode via the `/effort ultracode` slash injection (step 11).
10. After shell ready: write launch command + `\r` (e.g. `"claude --model opus --effort high -n \"agent-manager #1\"\r"`)
11. **Slash injection only for `ultracode` effort and remote-control name.** If `config.effortLevel === 'ultracode'` OR `config.remoteControlName` is set and the *base* command starts with `claude`, a temporary `onData` listener accumulates output (capped at 16KB), strips ANSI, and waits for the literal substring `"Claude Code"` to appear (ptyHost.ts:384). On match the listener disposes itself and a `setTimeout(..., 2500)` defers writing the slash commands so the Claude Code prompt is fully interactive. The commands (`/effort ultracode` then `/remote-control <name>`) are staggered 800ms apart (ptyHost.ts:392-400). A 30s safety timeout disposes the listener if `"Claude Code"` is never seen (ptyHost.ts:405-407).

12. Return `terminalId` (synchronous -- caller wraps in `{ok, terminalId}`)

### Session Name Flag (`-n`)
- Claude commands get `-n "title"` appended automatically
- If `config.sessionTitle` is provided, uses that; otherwise auto-generates a name. Special case: if `workDir === os.homedir()` the name is `Home #N`; otherwise `projectName #N` where `projectName` is the working-directory basename (ptyHost.ts:234-241).
- Auto-name counter is per-project via `ptyProjectCounters` map (e.g. "agent-manager #1", "thesis #2", "Home #1")
- `autoSessionName()` helper derives the project name from the working directory basename (with the `Home` special case) and increments the per-project counter
- Only for commands starting with `claude`; skips if `-n` or `--name` already present
- `appendSessionName()` and `autoSessionName()` helpers defined locally in ptyHost.ts

### Shell-Ready Detection

- Buffer output up to 4096 bytes
- Strip ANSI escape sequences: `/\x1b\[[0-9;]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)/g`
- After 50ms of silence, check if the last non-empty line is **shorter than 200 chars** and matches `/[#$%>]\s*$/` (ptyHost.ts:203) — the length cap rejects long wrapped output lines that happen to end in a prompt char
- Timeout: 2000ms (local terminals)

### Output Ring Buffer

**Configurable, pre-allocated** ring buffer. Each PTY owns one `Buffer.alloc(replayBufferBytes)` + a write offset; new chunks are copied in at the offset, wrapping around when the slab is full. This replaces the old `Buffer.concat([old, chunk])` pattern which was O(n) per write and allocated garbage for every PTY data event.

`replayBufferBytes` is a module-level variable, default `DEFAULT_REPLAY_BUFFER_BYTES = 2 * 1024 * 1024` (2 MB, raised from the former hard-coded 128 KB). `setReplayBufferBytes(bytes)` (exported) updates it, clamped to `[MIN_REPLAY_BUFFER_BYTES = 256 * 1024, MAX_REPLAY_BUFFER_BYTES = 32 * 1024 * 1024]`. It is driven by the `pty:set-replay-buffer` IPC channel (see [IPC Transport](./ipc-transport.md)), which the renderer pushes from the `terminalReplayBufferBytes` setting (Settings ▸ ADVANCED ▸ Terminal). **These constants are a deliberate local copy of `src/types/terminal.ts`** — ptyHost runs in the Electron main process and does not import that module at runtime, so keep the two in sync. The ring is allocated **once at create time**, so a changed setting applies only to PTYs created afterward.

Helpers (file-local, not exported):
- `ringWrite(inst, chunk)` — O(1) append; handles wrap around and oversized-chunk (> cap) cases.
- `ringSnapshot(inst)` — linearize the ring into a contiguous `Buffer` (oldest → newest). Used by `getOutputBuffer()` for `pty:subscribe` replay.
- `ringLength(inst)` — current valid byte count (`ringOffset` until wrapped, then `cap`).

On `pty:subscribe`, `ringSnapshot()` is base64-encoded and returned for instant replay of terminal history.

### Subscriber Gating (performance)

Each `PtyInstance` holds a `Set<WebContents>` of renderer windows currently viewing it. `onData` ALWAYS fills the ring buffer, but only emits `pty:data` IPC when the set is non-empty. `pty:exit` remains a broadcast to all windows (rare event).

This eliminates the main-thread cost of decoding/routing output from background PTYs when many Claude sessions are running. Under the previous `sendToAllWindows` fan-out, every byte from every PTY was decoded in the renderer regardless of visibility, which caused typing latency to degrade proportionally to the number of active sessions.

Subscription management (see `terminalHandlers.ts`):
- `subscribePty(terminalId, wc)` — adds `wc` to the set; called from `pty:subscribe` IPC handler.
- `unsubscribePty(terminalId, wc)` — removes it; called from `pty:unsubscribe` IPC handler on session switch.
- `removeSubscriberFromAll(wc)` — called from `WebContents.once('destroyed', ...)` so a closed/crashed renderer is pruned from every PTY's subscriber set.

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
| `getOutputBuffer(id)` | Linearized ring snapshot, base64 or null |
| `subscribePty(id, wc)` | Add `WebContents` to the PTY's subscriber set |
| `unsubscribePty(id, wc)` | Remove `WebContents` from the set (PTY keeps running) |
| `removeSubscriberFromAll(wc)` | Prune a dead `WebContents` from every PTY |
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
  /** Effort level to auto-apply after Claude Code starts (low/medium/high/xhigh/max/ultracode) */
  effortLevel?: string
  /** Model to auto-apply after Claude Code starts (opus/sonnet/haiku) */
  model?: string
  /** Run `/remote-control <name>` automatically after Claude Code starts. */
  remoteControlName?: string
}
```

(Canonical type: `src/types/electron.d.ts:25-38`. Field JSDoc lives in ptyHost.ts:31-37.)

`enableOpsTerminal` is accepted by the type and the IPC payload but is **not read anywhere in `ptyHost.ts`** (the declaration at ptyHost.ts:30 is its only occurrence in that file) — it has no effect on Electron-spawned PTYs.

### Launch Flags vs Slash Injection

`FLAG_EFFORT_LEVELS = Set(['low', 'medium', 'high', 'xhigh', 'max'])` (ptyHost.ts:252) gates which effort values become `--effort` launch flags. `applyClaudeLaunchFlags(command, model, effortLevel)` (ptyHost.ts:260) rewrites a `claude` command, prepending `--model <model>` and/or `--effort <level>` after the `claude` token (skipped if those flags are already present). `ultracode` is intentionally **not** in the set — the raw `--effort` flag rejects it — so it is mapped to `--effort xhigh` at launch and then upgraded to true ultracode post-launch via `/effort ultracode` slash injection.

**This is a *simplified* mirror of `server/config.ts` `applyClaudeLaunchFlags()` (config.ts:277) — the two copies have diverged.** The server copy scrubs the model id first: it runs `sanitizeModelInCommand(command)` (config.ts:241) over any `--model` already baked into the command and `sanitizeModelId(model)` (config.ts:218) over the incoming model, then builds flags from the sanitized values. ptyHost's copy (ptyHost.ts:260-272) has **no sanitization** — it tests and rewrites the raw command with the raw model. Per the server-side rationale, a contaminated model id such as `claude-opus-4-8[1m]` (ANSI/SGR leftovers baked into a reused `startupCommand` by clone/resume/fork) reaches the unquoted `--model` flag, where zsh treats `[1m]` as a glob and the launch fails. That hardening has not been ported to the Electron path.

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
- Changing the ring buffer size affects memory usage proportionally to the number of active terminals. The size is now user-configurable (default 2 MB, clamped 0.25–32 MB) via `setReplayBufferBytes()`; the clamp bounds worst-case resident memory (`size × live PTYs`). The MIN/MAX/DEFAULT constants are duplicated from `src/types/terminal.ts` — changing one without the other diverges Electron-mode from browser-mode terminals.
- **Subscriber gating** assumes renderers always call `pty:unsubscribe` when switching away from a terminal. If they forget, the PTY keeps streaming IPC to that renderer (wasted CPU but not incorrect). Conversely, if `pty:subscribe` is skipped or races, the renderer goes blank until the next output — the ring buffer replay on subscribe is the only way stale content reaches a new subscriber.
- `removeSubscriberFromAll` on `destroyed` is essential — without it, a reloaded/crashed renderer would leak subscriber entries forever.
- `ringWrite` copies with `Buffer.copy`; if ever swapped to `TypedArray.set`, watch for signed-byte coercion (node-pty emits binary).
- **Two `applyClaudeLaunchFlags` / `FLAG_EFFORT_LEVELS` copies** — one in `electron/ptyHost.ts`, one in `server/config.ts` — and **they are currently out of sync**: the server copy sanitizes the model (`sanitizeModelInCommand` / `sanitizeModelId`) before building flags, the ptyHost copy does not. This is a live divergence, not a hypothetical: an Electron-spawned PTY reusing a `startupCommand` with a contaminated `--model` (e.g. `claude-opus-4-8[1m]`) still hits the zsh glob failure the server path was hardened against. Porting the two `sanitize*` helpers into ptyHost (or extracting a shared module — ptyHost can't import `server/config.ts` at runtime) closes it. The `ultracode → --effort xhigh` mapping *is* consistent across both; if the real `--effort` flag ever accepts `ultracode`, add it to both sets and drop both the xhigh mapping and the slash-injection branch.
- Slash injection (ultracode/remote-control) relies on the literal `"Claude Code"` banner substring appearing in PTY output. If the CLI changes its startup banner, detection silently fails after the 30s safety timeout and neither command is sent.
