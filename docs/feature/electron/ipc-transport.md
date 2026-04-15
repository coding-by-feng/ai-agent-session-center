# IPC Handlers & Context Bridge

## Function
Bridges Electron renderer process to main process PTY host, setup wizard, and app lifecycle via typed IPC channels and preload contextBridge.

## Purpose
Secure communication between React renderer and node-pty/Electron APIs. The preload script exposes a typed API without exposing Node.js internals to the web context.

## Source Files
| File | Role |
|------|------|
| `electron/ipc/terminalHandlers.ts` | PTY terminal IPC bridge (create, write, resize, kill, subscribe, has, list) |
| `electron/ipc/setupHandlers.ts` | Setup wizard IPC (check-deps, install-hooks, get/save-config) |
| `electron/ipc/appHandlers.ts` | App lifecycle IPC (get-port, open-browser, get-version, quit) |
| `electron/preload.ts` | contextBridge exposing electronAPI to renderer |

## Implementation

### Terminal IPC Channels

| Channel | Direction | Pattern | Description |
|---------|-----------|---------|-------------|
| `pty:create` | Renderer -> Main | invoke (request/response) | Creates PTY via ptyHost.createPty, returns `{ok, terminalId, error}` |
| `pty:write` | Renderer -> Main | on (fire-and-forget) | Writes data to PTY stdin via ptyHost.writePty |
| `pty:resize` | Renderer -> Main | on (fire-and-forget) | Resizes PTY via ptyHost.resizePty |
| `pty:kill` | Renderer -> Main | invoke (request/response) | Kills PTY via ptyHost.killPty, returns `{ok}` |
| `pty:subscribe` | Renderer -> Main | invoke (request/response) | Gets output buffer via ptyHost.getOutputBuffer, returns `{ok, buffer}` |
| `pty:has` | Renderer -> Main | invoke (request/response) | Checks PTY existence via ptyHost.hasPty, returns boolean |
| `pty:list` | Renderer -> Main | invoke (request/response) | Lists PTY IDs via ptyHost.listPtys, returns string[] |
| `pty:data` | Main -> Renderer | push (webContents.send) | Base64 encoded terminal output |
| `pty:exit` | Main -> Renderer | push (webContents.send) | PTY exit with exitCode and signal |

### Fire-and-Forget vs Request/Response

The distinction between `on` (fire-and-forget) and `invoke` (request/response) is intentional:

- **`pty:write` and `pty:resize` use `on`** -- these are high-frequency operations where waiting for a response adds unnecessary latency
- **`pty:create`, `pty:kill`, `pty:subscribe`, `pty:has`, `pty:list` use `invoke`** -- these need confirmation or return data

### ElectronAPI Interface

The preload exposes a comprehensive API surface with three groups. PTY methods are checked at runtime (`window.electronAPI?.createPty`) to determine IPC vs WebSocket transport:

```typescript
interface ElectronAPI {
  platform: 'darwin' | 'win32'

  // Setup wizard
  isSetup: () => Promise<boolean>
  checkDeps: () => Promise<Record<string, {ok: boolean, version?: string, hint?: string}>>
  saveConfig: (cfg: unknown) => Promise<{ok: boolean, error?: string}>
  installHooks: (cfg: unknown) => Promise<{ok: boolean, error?: string}>
  completeSetup: () => Promise<{ok: boolean, port?: number}>
  onInstallLog: (cb: (line: string) => void) => () => void

  // Dashboard / lifecycle
  getPort: () => Promise<number>
  openInBrowser: () => void
  rerunSetup: () => void
  onBeforeClose: (cb: () => Promise<void>) => () => void
  closeReady: () => void
  quitApp: () => void

  // PTY terminal (optional — checked at runtime for transport selection)
  createPty: (config: PtyCreateConfig) => Promise<{ok: boolean, terminalId?: string, error?: string}>
  writePty: (id: string, data: string) => void
  resizePty: (id: string, cols: number, rows: number) => void
  killPty: (id: string) => Promise<{ok: boolean}>
  subscribePty: (id: string) => Promise<{ok: boolean, buffer?: string | null}>
  hasPty: (id: string) => Promise<boolean>
  onPtyData: (cb: (terminalId: string, base64Data: string) => void) => () => void
  onPtyExit: (cb: (terminalId: string, exitCode: number, signal: number) => void) => () => void
}
```

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
| `app:rerun-setup` | Renderer -> Main | invoke | Deletes setup flag, relaunches app |
| `app:quit` | Renderer -> Main | invoke | Triggers graceful shutdown sequence |
| `app:before-close` | Main -> Renderer | push | Notifies renderer to save workspace before quit |
| `app:close-ready` | Renderer -> Main | send (fire-and-forget) | Renderer signals workspace save complete |
| `app:trigger-rerun-setup` | Main -> Renderer | push | Sent from tray "Re-run Setup Wizard" menu item |

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
