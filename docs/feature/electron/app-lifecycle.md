# Electron App Lifecycle & Window Management

## Function
Electron main process managing app lifecycle, BrowserWindow creation, system tray, setup wizard IPC, and embedded Express server.

## Purpose
Packages the dashboard as a native desktop app with window management, tray icon, and native capabilities not available in browsers.

## Source Files
| File | Role |
|------|------|
| `electron/main.ts` | App lifecycle, BrowserWindow, native menu, pop-out terminal + project windows, native folder picker, IPC registration, server embedding, graceful shutdown |
| `electron/tray.ts` | System tray / menu bar icon with dynamic menu; hide-to-tray on window close |
| `electron/ipc/appHandlers.ts` | Dashboard IPC: `app:get-port`, `app:open-browser`, `app:rerun-setup`, `app:quit` |
| `electron/ipc/setupHandlers.ts` | Setup wizard IPC: `setup:is-complete`, `setup:check-deps`, `setup:save-config`, `setup:install-hooks`, `setup:complete` |
| `electron/loading.html` | Loading screen shown during server startup (progress bar, live log area, error banner) |
| `electron-builder.json` | electron-builder packaging config (mac DMG+zip / win NSIS targets, asar, extraResources) |
| `scripts/Open App (Start Here).command` | Guided first-run helper bundled in the macOS DMG (`dmg.contents`); clears the Gatekeeper quarantine flag via native `osascript` step popups |

> The renderer side of the pop-out terminal window flow (`PopoutTerminalView`, `?popout=terminal` detection in `src/main.tsx`) lives in [Floating Terminal Fork](../frontend/floating-terminal-fork.md). The PTY host and terminal-channel IPC live in [PTY Host](./pty-host.md) and [IPC Transport](./ipc-transport.md).

## Implementation

### Process Architecture

```
Electron Main (main.ts + tray + ptyHost + setup/app/terminal/popout IPC + embedded Express server)
  -> Main BrowserWindow (React app: dist/client/ in prod, Vite dev server in dev)
  -> Pop-out terminal BrowserWindow(s) (?popout=terminal&terminalId=…)
  -> Pop-out project BrowserWindow(s) (?popout=project&path=…)
  -> window.electronAPI via preload contextBridge
```

On `app.whenReady()` the registration order is: `registerSetupHandlers()`, `registerAppHandlers()`, `registerTerminalHandlers()`, `registerPopoutHandler()`, `registerDirectoryPickerHandler()`, `registerProjectWindowHandler()` (main.ts:302-307) — IPC handlers are registered **before** `createWindow()` so the renderer can call them as soon as it loads.

### Build Configuration

- Electron `^34.0.0`, electron-builder `^25.0.0` (config in `electron-builder.json`, referenced via `package.json` `build.extends`)
- App id `com.kasonzhan.ai-agent-session-center`, product name "AI Agent Session Center"
- macOS targets: DMG + zip (arm64, hardened runtime, `entitlements.mac.plist`); Windows target: NSIS (x64, non-one-click installer)
- `main` entry is `dist/electron/main.cjs`; `asar: true` with `better-sqlite3` and `node-pty` in `asarUnpack`; `hooks/` copied to `extraResources`
- Separate tsconfig: `tsconfig.electron.json` (compiled to CJS, then `scripts/cjs-rename.sh` renames `.js` → `.cjs`)

#### macOS Gatekeeper / "damaged" first-run helper

The app is **not Apple-notarized**, so a freshly-downloaded copy is quarantined and macOS reports *"AI Agent Session Center is damaged and can't be opened."* on first launch. Because the app can't run while flagged, the fix cannot live in-app — it ships as `scripts/Open App (Start Here).command`, placed in the DMG window via `dmg.contents`. Double-clicking it runs a guided flow of **native `osascript` popups** (Welcome → locate app in `/Applications` → `xattr -cr` unlock → launch), with Cancel and error handling at each step. The `as_escape` helper escapes `\` and `"` before embedding any text in the AppleScript literal (a path wrapped in quotes inside the error dialog would otherwise terminate the string and break the popup). The permanent fix remains Developer ID signing + notarization (see the project README discussion).

### Window Management

- First run: smaller window (640x520, minimum 640x520) for setup wizard; subsequent runs: full-size (1400x900, minimum 900x600)
- Background color `#0a0a1a` to avoid white flash before content loads
- Production: shows `loading.html` immediately, then starts the embedded Express server, mirrors all process stdout/stderr to the loading screen, finally navigates to `http://localhost:{port}`
- Development: `createWindow()` loads `http://localhost:${SERVER_PORT ?? 3332}` directly (the `electron:dev` npm script runs Vite + `tsx watch server/index.ts` concurrently and `wait-on tcp:3333` before launching Electron)
- Loading screen drives progress via `window.updateProgress(pct, msg)`, log lines via `window.addLog(line, isError)`, and fatal errors via `window.showError(msg)`; it auto-advances the bar to ~75% while waiting and strips ANSI escapes from log text
- macOS dock `activate` event shows + focuses the first (hidden, not destroyed) window

### Server Embedding

In production, the Express server runs **in-process** in the main process — there is no child process. On `app.whenReady()` the main process sets `process.env.APP_USER_DATA` to the userData dir (so the server reads config from a writable location), then `require()`s the esbuild bundle `dist/server-bundle.cjs` (built by `npm run build:server` → `scripts/build-server.mjs`), keeping a reference to its `shutdownServer` for graceful quit. It calls `startServer()` (no port arg → server resolves its own port), writes the result to `process.env.SERVER_PORT`, and only then navigates the renderer to `http://localhost:{port}`. Progress is reported at 10% / 30% / 95% via `sendLoadingUpdate`. (On first run the setup wizard's `setup:complete` handler starts the server itself — `require('server/index.js').startServer()` — after writing the setup flag, rather than going through this `whenReady` path.) In development, Electron connects to the already-running `tsx watch` server instead of embedding one.

### System Tray

`setupTray(win)` builds the tray from `electron/icon/tray.png` (or `tray.ico` on Windows), falling back to an empty image if the file is missing or empty.

- App name label "AI Agent Session Center" (disabled, decorative)
- "Hide Window" / "Show Window" toggle — label and behavior reflect `win.isVisible()`; `rebuild()` is called after each toggle to refresh the label
- "Open in Browser" opens `http://localhost:${SERVER_PORT ?? 3333}` via `shell.openExternal`
- "Re-run Setup Wizard" sends `app:trigger-rerun-setup` to the renderer. **Note:** that channel has no preload bridge and no renderer listener (`tray.ts:53` is its only occurrence across `src/` and `electron/`), so the menu item is currently inert. The working re-run path is the `app:rerun-setup` IPC.
- "Quit" calls `app.quit()` to trigger graceful shutdown
- Double-click on the tray icon shows the window (and rebuilds the menu)
- Window close (X button) is intercepted via `win.on('close')`: unless a real quit is in progress (`isQuitting`, set by tray's own `before-quit` listener), it `preventDefault()`s and hides the window instead of destroying it. The window is therefore *hidden, never destroyed* until a real quit.

### Setup Wizard IPC

Registered by `registerSetupHandlers()`. All inputs from the renderer are validated against allow-lists (`VALID_DENSITIES = ['high','medium','low']`, `VALID_CLIS = ['claude','gemini','codex']`, port range `1`–`65535`).

| Channel | Action |
|---------|--------|
| `setup:is-complete` | Returns boolean: whether `setup.json` exists in userData |
| `setup:check-deps` | macOS/Linux: checks `jq` (optional, recommended) and `curl` (required for HTTP fallback). Windows: checks PowerShell execution policy (must be `RemoteSigned`/`Unrestricted`/`Bypass`) |
| `setup:save-config` | Validates and writes `server-config.json` to userData with **atomic write** (temp file with random suffix → `renameSync`). Persisted fields: `port`, `enabledClis`, `hookDensity`, `debug`, `sessionHistoryHours` (1–8760, default 24), optional `passwordHash` (≤256 chars) |
| `setup:install-hooks` | `require()`s `hooks/install-hooks-api.cjs` (from `extraResources` when packaged, else `PROJECT_ROOT`) and runs `installHooks({ density, enabledClis, projectRoot, onLog })`, streaming each line via `setup:install-log` push channel, then a final `DONE` |
| `setup:complete` | Writes `setup.json`, sets `APP_USER_DATA`, starts the server (`require('server/index.js').startServer()`), writes `SERVER_PORT`, resizes window to 1400x900 + centers, navigates to dashboard; returns `{ ok, port }` |

### App IPC

Registered by `registerAppHandlers()`.

| Channel | Action |
|---------|--------|
| `app:get-port` | Returns `Number(process.env.SERVER_PORT ?? 3333)` |
| `app:open-browser` | Validates `SERVER_PORT` (integer 1–65535) then opens `http://localhost:{port}` via `shell.openExternal` |
| `app:rerun-setup` | Deletes `setup.json` flag, then `app.relaunch()` + `app.exit(0)` to restart into the setup wizard |
| `app:quit` | Calls `app.quit()`, which triggers `before-quit` → workspace save → PTY dispose → server shutdown → exit |

### Pop-out Terminal Windows

`registerPopoutHandler()` exposes the `window:open-terminal` IPC handler (called from the renderer as `electronAPI.openTerminalWindow({ terminalId, originSessionId?, label? })`). It opens a separate, draggable BrowserWindow (`POPOUT_DEFAULT_SIZE` = 820x560, min 480x320, same `#0a0a1a` background and security webPreferences as the main window) loading `http://localhost:${SERVER_PORT ?? 3333}/?popout=terminal&terminalId=…` (with optional `originSessionId` / `label` query params). Open windows are tracked in a `popoutWindows` Map keyed by `terminalId` — re-opening an existing terminal focuses its window instead of duplicating. When a pop-out window closes, the main process sends `popout:closed` (with the `terminalId`) to the main window so it can re-dock the in-app float. The same `before-input-event` reload guard (main.ts:177-179) and `setWindowOpenHandler` link restriction (main.ts:180-183) apply to **terminal** pop-out windows — see the project-window section below for the deliberate asymmetry. The renderer side is documented in [Floating Terminal Fork](../frontend/floating-terminal-fork.md).

**Multi-monitor placement & position memory** (`computePopoutBounds()`, uses Electron's `screen` API):
- The window's `x`/`y`/`width`/`height` are computed before creation rather than left to OS defaults, so a fresh pop-out **opens on a second monitor when one exists**.
- Placement order: (1) the **last-saved bounds** if still visible (`boundsOnSomeDisplay()` checks the window center against every connected `screen.getAllDisplays()` display); else (2) **centered on the first non-primary display**'s `workArea`; else (3) centered on the display under the cursor (`getDisplayNearestPoint(getCursorScreenPoint())`, falling back to primary).
- The window's bounds are persisted on every `moved` / `resized` event to `popout-bounds.json` in userData (`savePopoutBounds(w.getBounds())`, guarded by `!w.isDestroyed()`), so the next pop-out re-opens where the user last left it (e.g. dragged onto monitor 2). `loadPopoutBounds()` validates the JSON shape and falls back to auto-placement when missing/malformed or when that monitor is no longer connected.
- Both window families share this one bounds slot — see [Persisted State](#persisted-state--env-vars).

### Pop-out PROJECT Windows

`registerProjectWindowHandler()` (main.ts:221) exposes the `window:open-project` IPC handler (called from the renderer as `electronAPI.openProjectWindow({ path, file?, label? })`, returns `{ ok }`). It opens the standalone project browser in its own native BrowserWindow (same `POPOUT_DEFAULT_SIZE`, min 480x320, `#0a0a1a` background and security `webPreferences` as the terminal pop-out) loading `http://localhost:${SERVER_PORT ?? 3333}/?popout=project&path=…` (plus an optional `file` query param). The renderer routes this via the `popout === 'project'` branch in `src/main.tsx:70`.

- **This is the live replacement for the retired in-app floating PROJECT overlay** — a DOM panel can't leave the app window, so the "float" affordance opens a real OS window instead. It is reached from `openProjectWindow()` in `DetailTabs.tsx:433`.
- Open windows are tracked in a **`projectPopoutWindows` Map keyed by `projectPath`** (main.ts:216) — a second open of the same path focuses the existing window rather than duplicating it.
- Placement reuses the same `computePopoutBounds()` (main.ts:232) and `savePopoutBounds()` on `moved` / `resized` (main.ts:247-249) as the terminal pop-out.
- **Security asymmetry (deliberate):** project windows install **only** the `setWindowOpenHandler` link restriction (main.ts:251-254) — there is **no** `before-input-event` guard, so `Cmd+R` / `Ctrl+R` / `F5` *do* reload a project window. Unlike a terminal, a project browser has no PTY state to lose, so reload stays available.
- Unlike the terminal pop-out, closing a project window sends no `popout:closed` push — it only deletes its Map entry (main.ts:256).

### Native OS Folder Picker

`registerDirectoryPickerHandler()` (main.ts:200) exposes the `dialog:select-directory` IPC (payload `{ defaultPath? }`), backing the "Browse…" button in the session-creation modals. It calls `dialog.showOpenDialog` with `properties: ['openDirectory', 'createDirectory']`, parented to `mainWindowRef` when alive, defaulting to `app.getPath('home')`, and resolves the chosen absolute path or `null` when cancelled. Like the window handlers it lives in `main.ts`, **not** in `appHandlers.ts`. Fuller channel description in [IPC Transport](./ipc-transport.md).

### Graceful Shutdown

`app.on('before-quit')` (guarded by an `isQuitting` flag so it runs once; calls `e.preventDefault()` first, then re-quits at the end):
1. Sends `app:before-close` to the first window for workspace save (waits up to **5s** via `Promise.race` for an `app:close-ready` reply, then proceeds regardless). On receipt the renderer shows a full-screen `SavingOverlay` with a determinate **progress bar** ("Quitting — Saving workspace & config…"): a creep timer ramps the bar toward 90% while `flushSave()` runs, then snaps to 100% when the save resolves and the renderer replies `app:close-ready`.
2. `disposeAll()` (imported as `disposePtyHost` in main.ts) kills all active PTY processes
3. Calls the captured `serverShutdown()` (the bundle's `shutdownServer`) to save the SQLite snapshot and close the DB — nulled first so it can't run twice
4. Calls `app.quit()` to exit

`window-all-closed` is a deliberate no-op — the tray keeps the app alive. Only the tray "Quit" menu item, the native menu Quit / `Cmd+Q`, or the `app:quit` IPC triggers an actual quit.

### Persisted State & Env Vars

| Key | Location / type | Purpose |
|-----|-----------------|---------|
| `setup.json` (`SETUP_FLAG`) | `userData/setup.json` | First-run flag; presence = setup complete (`{ completedAt }`) |
| `server-config.json` (`CONFIG_PATH`) | `userData/server-config.json` | Persisted server config from setup wizard |
| `popout-bounds.json` (`POPOUT_BOUNDS_FILE`) | `userData/popout-bounds.json` | Last-used pop-out window bounds (`{x,y,width,height}`) for second-monitor placement / position memory. **Shared by both terminal and project pop-outs** — a single global slot, not per-window-type, so moving one relocates the next open of the other |
| `APP_USER_DATA` | env var | Points the embedded server at the writable userData dir |
| `SERVER_PORT` | env var | Resolved server port, shared across IPC handlers, tray, and pop-out windows (dev default `3332`, IPC/tray fallback `3333`) |
| `ELECTRON` | env var (`'1'`) | Set at the top of `main.ts` so server code can detect the Electron host |

### Window Security

- `autoplay-policy=no-user-gesture-required` command-line switch enables Web Audio without user gesture (needed for session event sounds arriving via WebSocket)
- `Cmd+R` / `Ctrl+R` / `F5` blocked via `before-input-event` to prevent page reload (loses terminal state)
- External link navigation restricted to `http:` / `https:` protocols only (blocks `ms-msdt:`, `file:`, etc.)
- `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true` for renderer security

### Native App Menu

`buildAppMenu(win)` builds the native application menu:
- **macOS app menu** (only on darwin): about, services, hide / hideOthers / unhide, quit — required so `Cmd+Q` and the about panel work
- **Edit**: undo, redo, cut, copy, paste, pasteAndMatchStyle, selectAll
- **View**: Reload (`Cmd/Ctrl+R`), Force Reload (`Cmd/Ctrl+Shift+R`), Zoom In/Out (`±0.5` level), Reset Zoom, Toggle Fullscreen (`Ctrl+Cmd+F` on mac / `F11`)

> Note: the View menu's Reload items exist as explicit click handlers, but the global `before-input-event` guard still blocks the raw `Cmd/Ctrl+R` and `F5` keystrokes to protect terminal state — reload is therefore only reachable through the menu item, not the keyboard.

### npm Scripts

| Script | Purpose |
|--------|---------|
| `electron:dev` | `tsc -p tsconfig.electron.json` + `cjs-rename.sh`, then `concurrently` runs Vite + `tsx watch server/index.ts` + (`wait-on tcp:3333` →) `electron dist/electron/main.cjs` |
| `electron:build` | `vite build` + `build:server` + `electron:rebuild` + electron tsc + copy `loading.html` + `cjs-rename.sh` + `electron-builder` |
| `electron:build:mac` / `electron:build:win` | Same as `electron:build` with `--mac` / `--win` |
| `electron:rebuild` | `node scripts/rebuild-native.cjs` — rebuilds native modules for Electron's Node ABI |
| `electron:pack` | Unpacked build (`electron-builder --dir`), no installer |
| `build:server` | `node scripts/build-server.mjs` — esbuild CJS bundle `dist/server-bundle.cjs` |

### Native Module Rebuilding

`scripts/rebuild-native.cjs` calls the `@electron/rebuild` (`^3.7.0`) API directly (not the legacy `electron-rebuild` CLI, which has yargs/ESM issues on Node 25+) to rebuild `better-sqlite3` and `node-pty` against Electron's Node version, because Electron uses a different Node ABI than the system Node.js installation.

## Dependencies & Connections

### Depends On
- [PTY Host](./pty-host.md) -- `disposeAll()` called on quit to kill terminals
- [IPC Transport](./ipc-transport.md) -- `registerTerminalHandlers()` and the preload contextBridge
- [Server API](../server/api-endpoints.md) -- Express server (`startServer`/`shutdownServer`) embedded in the main process
- [Setup Wizard](../frontend/setup-wizard.md) -- renderer UI driven by the setup IPC channels
- [Workspace Snapshot](../frontend/workspace-snapshot.md) -- renderer's `flushSave()` / `SavingOverlay` triggered by `app:before-close` on quit

### Depended On By
- [Frontend Terminal UI](../frontend/terminal-ui.md) -- Electron-specific features via `window.electronAPI`
- [Floating Terminal Fork](../frontend/floating-terminal-fork.md) -- `window:open-terminal` IPC opens the pop-out terminal window; `popout:closed` re-docks the in-app float
- [PTY Host](./pty-host.md) -- `disposePtyHost()` called on quit

### Shared Resources
- Main BrowserWindow + pop-out terminal BrowserWindows (`popoutWindows` Map, keyed by `terminalId`) + pop-out project BrowserWindows (`projectPopoutWindows` Map, keyed by `projectPath`)
- `popout-bounds.json` — one bounds slot written by **both** pop-out Maps
- Embedded Express server instance + `SERVER_PORT` env var
- System tray

## Change Risks
- Native module version mismatch (`NODE_MODULE_VERSION` error) requires running `electron:rebuild` (which runs `scripts/rebuild-native.cjs`). This is the most common build failure.
- The production server is loaded from `dist/server-bundle.cjs` — if `build:server` is skipped or the esbuild bundle is stale, the embedded server won't start. `setup:complete` instead requires `server/index.js`, so both entry points must stay in sync.
- Changing server startup order can cause the renderer to load before the server is ready (`startServer()` must resolve and set `SERVER_PORT` before `loadURL`), resulting in connection errors.
- Tray and pop-out code must guard with `win.isDestroyed()` (the main window is hidden, not destroyed, on close) to avoid sending IPC to a dead webContents.
- Missing `loading.html` (it must be copied into `dist/electron/` during `electron:build`) causes a blank screen during server startup.
- The `before-quit` 5s timeout is best-effort: if `flushSave()` exceeds it, the app quits anyway and workspace state may be lost. Don't lengthen it without UX consideration.
- The TS→CJS rename step (`scripts/cjs-rename.sh`) is required because `main` is `main.cjs`; skipping it leaves Electron unable to find its entry point.
- Pop-out window placement depends on `boundsOnSomeDisplay()` to reject saved bounds on a disconnected monitor; weakening that check can strand the window off-screen. The `screen` API is only valid after `app.whenReady()` — `computePopoutBounds()` runs inside the IPC handler (post-ready), so it must not be hoisted to module load.
