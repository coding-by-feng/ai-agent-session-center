# IPC Handlers & Context Bridge

## Function
Bridges Electron renderer process to main process PTY host, setup wizard, and app lifecycle via typed IPC channels and preload contextBridge.

## Purpose
Secure communication between React renderer and node-pty/Electron APIs. The preload script exposes a typed API without exposing Node.js internals to the web context.

## Source Files
| File | Role |
|------|------|
| `electron/ipc/terminalHandlers.ts` | PTY terminal IPC bridge (create, write, resize, kill, subscribe, unsubscribe, has, **list** — registered but not exposed via preload, currently orphan; **set-replay-buffer**) |
| `electron/ipc/setupHandlers.ts` | Setup wizard IPC (is-complete, check-deps, save-config, install-hooks, complete) |
| `electron/ipc/appHandlers.ts` | App lifecycle IPC (app:get-port, app:open-browser, app:rerun-setup, app:quit) |
| `electron/preload.ts` | contextBridge exposing electronAPI to renderer |
| `src/types/electron.d.ts` | Canonical `ElectronAPI` contract + payload/result types (`PtyCreateConfig`, `PtyCreateResult`, `PtySubscribeResult`, `SetupConfig`, etc.) |

Note: the `window:open-terminal` / `window:open-project` / `dialog:select-directory` / `popout:closed` channels are *registered* in `electron/main.ts` (not in `terminalHandlers.ts` or `appHandlers.ts`) but bridged through `preload.ts`; they are documented here because they ride the same `electronAPI` surface.

## Implementation

### Terminal IPC Channels

| Channel | Direction | Pattern | Description |
|---------|-----------|---------|-------------|
| `pty:create` | Renderer -> Main | invoke (request/response) | Creates PTY via ptyHost.createPty, returns `{ok, terminalId, error}`. Payload (`PtyCreateConfig`, electron.d.ts:25-38) now includes optional `effortLevel?: string`, `model?: string`, and `remoteControlName?: string` fields used by ptyHost auto-apply (see [PTY Host](./pty-host.md)). |
| `pty:write` | Renderer -> Main | on (fire-and-forget) | Writes data to PTY stdin via ptyHost.writePty |
| `pty:resize` | Renderer -> Main | on (fire-and-forget) | Resizes PTY via ptyHost.resizePty |
| `pty:kill` | Renderer -> Main | invoke (request/response) | Kills PTY via ptyHost.killPty, returns `{ok}` |
| `pty:subscribe` | Renderer -> Main | invoke (request/response) | Registers caller's `WebContents` as a subscriber AND returns output buffer via ptyHost.getOutputBuffer, returns `{ok, buffer}`. Caller also receives subsequent `pty:data` pushes until unsubscribed. |
| `pty:unsubscribe` | Renderer -> Main | on (fire-and-forget) | Removes caller's `WebContents` from the PTY's subscriber set. PTY keeps running; caller stops receiving `pty:data` pushes. Used on session switch. |
| `pty:has` | Renderer -> Main | invoke (request/response) | Checks PTY existence via ptyHost.hasPty, returns boolean |
| `pty:data` | Main -> Renderer | push (webContents.send) | Base64 encoded terminal output. **Gated**: only sent to `WebContents` in the PTY's subscriber set. |
| `pty:exit` | Main -> Renderer | push (webContents.send) | PTY exit with exitCode and signal. Broadcast to all windows (rare event). |
| `pty:list` | Renderer -> Main | invoke (request/response) | Returns ptyHost.listPtys(). **Registered in terminalHandlers but NOT exposed via preload** — currently orphan (no `electronAPI` method). |
| `pty:set-replay-buffer` | Renderer -> Main | on (fire-and-forget) | Sets the scrollback replay buffer size (bytes) for newly created PTYs via `ptyHost.setReplayBufferBytes` (clamped 0.25–32 MB). Pushed from the renderer when the `terminalReplayBufferBytes` setting loads/changes (see [Settings System](../frontend/settings-system.md)). Bridged as `electronAPI.setPtyReplayBuffer(bytes)`. |
| `window:open-terminal` | Renderer -> Main | invoke (request/response) | Pops a floating terminal out into its own native `BrowserWindow` (draggable to another monitor). Registered in `electron/main.ts`. Payload `{ terminalId, originSessionId?, label? }`, returns `{ ok }`. |
| `window:open-project` | Renderer -> Main | invoke (request/response) | Opens the PROJECT tab in its own native `BrowserWindow` (draggable to another monitor) on the standalone project-browser route. Registered in `electron/main.ts`. Payload `{ path, file?, label? }`, returns `{ ok }`. De-duped by `path` — a second open focuses the existing window. Called from `DetailTabs.tsx:437`. |
| `popout:closed` | Main -> Renderer | push (webContents.send) | Fires in the **main** window when a popped-out terminal window is closed, so the in-app float can re-dock. Carries `terminalId`. Terminal pop-outs only — closing a project window pushes nothing. |

### Fire-and-Forget vs Request/Response

The distinction between `on` (fire-and-forget) and `invoke` (request/response) is intentional:

- **`pty:write`, `pty:resize`, `pty:unsubscribe`, `pty:set-replay-buffer` use `on`** -- these are high-frequency or best-effort operations where waiting for a response adds unnecessary latency
- **`pty:create`, `pty:kill`, `pty:subscribe`, `pty:has` use `invoke`** -- these need confirmation or return data

### ElectronAPI Interface

The preload exposes a comprehensive API surface, grouped by concern (setup wizard, dashboard/lifecycle, native folder picker, PTY terminal, pop-out windows). PTY methods are checked at runtime (`window.electronAPI?.createPty`) to determine IPC vs WebSocket transport:

Canonical source: `src/types/electron.d.ts`. The shape below mirrors that file — keep them in sync.

```typescript
interface ElectronAPI {
  platform: 'darwin' | 'win32'

  // Setup wizard
  isSetup: () => Promise<boolean>
  checkDeps: () => Promise<Record<string, DepCheckResult>>
  saveConfig: (cfg: SetupConfig) => Promise<{ ok: boolean }>
  installHooks: (cfg: Pick<SetupConfig, 'hookDensity' | 'enabledClis'>) => Promise<InstallResult>
  completeSetup: () => Promise<{ ok: boolean; port: number }>
  onInstallLog: (cb: (line: string) => void) => () => void

  // Dashboard / lifecycle
  getPort: () => Promise<number>
  openInBrowser: () => void
  rerunSetup: () => void
  onBeforeClose: (cb: () => Promise<void>) => () => void
  closeReady: () => void
  quitApp: () => void

  // Native OS folder picker (optional — Electron only; the browser sandbox
  // can't return an absolute path, so this is undefined there)
  selectDirectory?: (opts?: { defaultPath?: string }) => Promise<string | null>

  // PTY terminal (all optional — checked at runtime for transport selection)
  createPty?: (config: PtyCreateConfig) => Promise<PtyCreateResult>
  writePty?: (id: string, data: string) => void
  resizePty?: (id: string, cols: number, rows: number) => void
  killPty?: (id: string) => Promise<{ ok: boolean }>
  subscribePty?: (id: string) => Promise<PtySubscribeResult>
  unsubscribePty?: (id: string) => void
  hasPty?: (id: string) => Promise<boolean>
  setPtyReplayBuffer?: (bytes: number) => void
  onPtyData?: (cb: (terminalId: string, base64Data: string) => void) => () => void
  onPtyExit?: (cb: (terminalId: string, exitCode: number, signal: number) => void) => () => void

  // Pop-out floating terminal / project windows (optional — Electron only)
  openTerminalWindow?: (opts: { terminalId: string; originSessionId?: string; label?: string }) => Promise<{ ok: boolean }>
  openProjectWindow?: (opts: { path: string; file?: string; label?: string }) => Promise<{ ok: boolean }>
  onPopoutClosed?: (cb: (terminalId: string) => void) => () => void
}
```

Notes:
- `installHooks` receives only `Pick<SetupConfig, 'hookDensity' | 'enabledClis'>` — not the full config (electron.d.ts:59).
- `completeSetup` returns `{ ok: boolean; port: number }` — `port` is required, not optional (electron.d.ts:60).
- `PtyCreateConfig`, `PtyCreateResult`, `PtySubscribeResult` are named types in electron.d.ts (lines 25, 40, 46) — refer by name rather than inlining shapes that drift.
- `PtyCreateConfig` carries terminal-launch options consumed by ptyHost auto-apply: `workingDir?`, `command?`, `label?`, `sessionTitle?`, `apiKey?`, `enableOpsTerminal?`, `effortLevel?` (low/medium/high/xhigh/max/ultracode), `model?` (opus/sonnet/haiku), and `remoteControlName?` (runs `/remote-control <name>`).
- Floating-fork / translate sessions reuse the same `pty:*` channels as regular sessions — the channels are surface-agnostic (no separate "floating" IPC namespace). See [Floating Terminal Fork](../frontend/floating-terminal-fork.md).
- `openTerminalWindow?` / `openProjectWindow?` / `onPopoutClosed?` / `selectDirectory?` are optional, Electron-only methods. Their handlers live in `electron/main.ts`, not in `terminalHandlers.ts` / `appHandlers.ts`.
- `openProjectWindow?` (electron.d.ts:92, preload.ts:82) opens the PROJECT tab in its own native window — the live replacement for the retired in-app floating PROJECT overlay. See [App Lifecycle → Pop-out PROJECT Windows](./app-lifecycle.md).

### Preload Context Bridge

`contextBridge.exposeInMainWorld('electronAPI', {...})` creates a secure, typed API surface on `window.electronAPI`. This is the only way the renderer can access main process capabilities.

### Setup IPC Channels

| Channel | Direction | Pattern | Action |
|---------|-----------|---------|--------|
| `setup:is-complete` | Renderer -> Main | invoke | Returns boolean: whether setup flag exists |
| `setup:check-deps` | Renderer -> Main | invoke | Checks jq, curl (macOS/Linux) or PowerShell policy (Windows) |
| `setup:save-config` | Renderer -> Main | invoke | Validates + atomic-writes server config to userData |
| `setup:install-hooks` | Renderer -> Main | invoke | Runs hook installer, streams progress via `setup:install-log` |
| `setup:complete` | Renderer -> Main | invoke | Marks setup done, starts server, resizes window |

### App IPC Channels

| Channel | Direction | Pattern | Action |
|---------|-----------|---------|--------|
| `app:get-port` | Renderer -> Main | invoke | Returns resolved server port (Number) |
| `app:open-browser` | Renderer -> Main | invoke | Opens `http://localhost:{port}` via `shell.openExternal` |
| `dialog:select-directory` | Renderer -> Main | invoke | **(registered in `electron/main.ts`, not `appHandlers.ts`)** Opens the native OS folder picker (`dialog.showOpenDialog`, `['openDirectory','createDirectory']`); resolves the chosen absolute path or `null` if cancelled. Backs `electronAPI.selectDirectory` (the session-creation "Browse…" button) |
| `app:rerun-setup` | Renderer -> Main | invoke | Deletes setup flag, relaunches app |
| `app:quit` | Renderer -> Main | invoke | Triggers graceful shutdown sequence |
| `app:before-close` | Main -> Renderer | push | Notifies renderer to save workspace before quit |
| `app:close-ready` | Renderer -> Main | send (fire-and-forget) | Renderer signals workspace save complete |
| `app:trigger-rerun-setup` | Main -> Renderer | push | Sent from tray "Re-run Setup Wizard" menu item. **No preload bridge and no renderer listener** — currently orphan (`tray.ts:53` is its only occurrence across `src/` and `electron/`), so nothing receives it. The working re-run path is `app:rerun-setup`. |

### Lifecycle Push Channels

| Channel | Direction | Description |
|---------|-----------|-------------|
| `setup:install-log` | Main -> Renderer | Streams hook install progress lines during setup wizard |

### Transport Selection

In `useTerminal`, transport is selected at runtime per-terminal:

- `isPtyHostTerminal(terminalId)` checks `terminalId.startsWith('pty-') && !!window.electronAPI?.writePty`
- If true: **IPC transport** (no chunking needed -- no WS frame limit, no JSON overhead, no auth required)
- If false: **WebSocket transport** (browser fallback, chunks large pastes at 4096 bytes)

### QuickSessionModal Branching

- `window.electronAPI?.createPty` exists -> IPC path (direct PTY creation)
- Otherwise -> HTTP `POST /api/terminals` (server-side terminal creation)

## Dependencies & Connections

### Depends On
- [PTY Host](./pty-host.md) -- terminalHandlers delegate all PTY operations to ptyHost
- [App Lifecycle](./app-lifecycle.md) -- appHandlers delegate to Electron app APIs

### Depended On By
- [Frontend Terminal UI](../frontend/terminal-ui.md) -- useTerminal selects IPC transport when available
- [Frontend Settings System](../frontend/settings-system.md) -- setup wizard uses setup IPC channels
- [Floating Terminal Fork](../frontend/floating-terminal-fork.md) -- FloatingTerminalPanel/FloatingTerminalRoot use `openTerminalWindow` / `onPopoutClosed` for native pop-out windows

### Shared Resources
- Electron IPC main/renderer channels
- `window.electronAPI` global object

## Change Risks
- All PTY methods must remain optional (`?`) -- removing optionality breaks browser mode where `window.electronAPI` is undefined.
- Changing IPC channel names requires coordinated changes across three locations: preload script, handler registration, and renderer code. Missing any one causes silent failures.
- Base64 encoding for `pty:data` is required -- raw binary breaks the IPC serialization layer.
- Using `invoke` instead of `on` for `pty:write` would add round-trip latency on every keystroke, degrading terminal responsiveness.
- The preload script runs in a sandboxed context -- importing Node.js modules directly in preload will fail. Only `contextBridge` and `ipcRenderer` are available.
- Adding new IPC channels requires updates to both the handler registration (main process) and the preload bridge (contextBridge) -- forgetting either side results in undefined methods.
