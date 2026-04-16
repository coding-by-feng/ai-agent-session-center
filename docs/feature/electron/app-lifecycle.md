# Electron App Lifecycle & Window Management

## Function
Electron main process managing app lifecycle, BrowserWindow creation, system tray, setup wizard IPC, and embedded Express server.

## Purpose
Packages the dashboard as a native desktop app with window management, tray icon, and native capabilities not available in browsers.

## Source Files
| File | Role |
|------|------|
| `electron/main.ts` | App lifecycle, BrowserWindow, IPC registration, server embedding |
| `electron/tray.ts` | System tray / menu bar icon with status indicator and menu |
| `electron/ipc/appHandlers.ts` | Dashboard IPC: app:get-port, app:open-browser, app:rerun-setup, app:quit |
| `electron/ipc/setupHandlers.ts` | Setup wizard IPC: check-deps, install-hooks, get/save-config |
| `electron/loading.html` | Loading screen shown during server startup |

## Implementation

### Process Architecture

```
Electron Main (main.ts + tray + ptyHost + IPC handlers + embedded Express server)
  -> Renderer (React app via dist/client/ or Vite dev server)
  -> window.electronAPI via preload contextBridge
```

### Build Configuration

- Electron 34.0.0, electron-builder 25.0.0
- macOS DMG (arm64), Windows NSIS (x64)
- Separate tsconfig: `tsconfig.electron.json`

### Window Management

- First run: smaller window (640x520) for setup wizard; subsequent runs: full-size (1400x900)
- Production: shows `loading.html` immediately, then starts embedded Express server, streams server stdout/stderr to loading screen, finally navigates to `http://localhost:{port}`
- Development: loads `http://localhost:{SERVER_PORT}` (server port from env, default 3332; Vite dev server is separate)
- Loading screen shows progress bar, real-time server boot logs, and error display
- macOS dock `activate` event restores hidden window

### Server Embedding

In production, the Express server is started directly in the main process. Port is resolved first, then passed to the renderer via IPC. In development, Electron connects to an already-running external dev server instead of embedding one.

### System Tray

- App name label "AI Agent Session Center" (disabled, decorative)
- "Hide/Show Window" toggle (dynamically rebuilds menu on visibility change)
- "Open in Browser" opens `http://localhost:{port}` via `shell.openExternal`
- "Re-run Setup Wizard" sends `app:trigger-rerun-setup` to renderer
- "Quit" calls `app.quit()` to trigger graceful shutdown
- Double-click on tray icon shows window
- Window close (X button) hides to tray instead of destroying (unless a real quit is in progress)

### Setup Wizard IPC

| Channel | Action |
|---------|--------|
| `setup:is-complete` | Returns boolean: whether `setup.json` exists in userData |
| `setup:check-deps` | Checks for jq, curl (macOS/Linux) or PowerShell execution policy (Windows) |
| `setup:save-config` | Validates and writes server config to userData `server-config.json` (atomic write: temp+rename) |
| `setup:install-hooks` | Runs hook installer, streams progress lines via `setup:install-log` push channel |
| `setup:complete` | Marks setup done (writes `setup.json`), starts Express server, resizes window to 1400x900, navigates to dashboard |

### App IPC

| Channel | Action |
|---------|--------|
| `app:get-port` | Returns resolved server port (Number) |
| `app:open-browser` | Opens `http://localhost:{port}` via `shell.openExternal` |
| `app:rerun-setup` | Deletes setup flag, relaunches app to trigger setup wizard |
| `app:quit` | Triggers `before-quit` -> workspace save -> server shutdown -> `app.quit()` |

### Graceful Shutdown

`app.before-quit` triggers (sequential):
1. Sends `app:before-close` to renderer for workspace save (waits up to 5s for `app:close-ready` response)
2. `disposeAll()` (imported as `disposePtyHost` in main.ts) kills all active PTY processes
3. Calls `serverShutdown()` to save SQLite snapshot and close DB
4. Finally calls `app.quit()` to exit

`window-all-closed` is a no-op -- the tray keeps the app alive. Only the tray "Quit" menu item or `app:quit` IPC triggers actual quit.

### Window Security

- `autoplay-policy=no-user-gesture-required` command-line switch enables Web Audio without user gesture (needed for session event sounds arriving via WebSocket)
- `Cmd+R` / `Ctrl+R` / `F5` blocked via `before-input-event` to prevent page reload (loses terminal state)
- External link navigation restricted to `http:` / `https:` protocols only (blocks `ms-msdt:`, `file:`, etc.)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for renderer security

### Native App Menu

`buildAppMenu()` creates the native application menu with Edit (undo, redo, cut, copy, paste, select all) and View (zoom in, zoom out, actual size, toggle fullscreen) menus.

### npm Scripts

| Script | Purpose |
|--------|---------|
| `electron:dev` | Build + launch Electron in dev mode |
| `electron:build` | Build distributable DMG/NSIS |
| `electron:rebuild` | Rebuild native modules for Electron Node ABI |

### Native Module Rebuilding

`electron-rebuild` is required for `node-pty` and `better-sqlite3` because Electron uses a different Node ABI than the system Node.js installation.

## Dependencies & Connections

### Depends On
- [PTY Host](./pty-host.md) -- initialized and managed in main process
- [IPC Transport](./ipc-transport.md) -- registers IPC handlers
- [Server API](../server/api-endpoints.md) -- Express server embedded in main process

### Depended On By
- [Frontend Terminal UI](../frontend/terminal-ui.md) -- Electron-specific features via window.electronAPI
- [PTY Host](./pty-host.md) -- disposePtyHost() called on quit

### Shared Resources
- Electron BrowserWindow instance
- Express server instance
- System tray

## Change Risks
- Native module version mismatch (`NODE_MODULE_VERSION` error) requires running `electron:rebuild`. This is the most common build failure.
- Changing server startup order can cause the renderer to load before the server is ready, resulting in connection errors.
- Tray icon code must handle `window.isDestroyed()` check to avoid crashes when the window is closed but the app is still running.
- Missing `loading.html` causes a blank screen during server startup.
- The port resolution must complete before the renderer URL is constructed -- race conditions here cause the renderer to connect to the wrong port.
