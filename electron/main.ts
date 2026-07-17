process.env.ELECTRON = '1'

import { app, BrowserWindow, shell, Menu, ipcMain, screen, dialog } from 'electron'
import path from 'path'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { setupTray } from './tray.js'
import { registerSetupHandlers } from './ipc/setupHandlers.js'
import { registerAppHandlers } from './ipc/appHandlers.js'
import { registerTerminalHandlers } from './ipc/terminalHandlers.js'
import { disposeAll as disposePtyHost } from './ptyHost.js'

// Allow Web Audio to play without requiring a user gesture for each sound.
// Session events arrive via WebSocket (not user clicks), so without this flag
// Chromium's autoplay policy silently blocks AudioContext.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required')

const isDev = !app.isPackaged

// Reference to server shutdown function (set after server starts in production)
let serverShutdown: (() => Promise<void>) | null = null
const SETUP_FLAG = path.join(app.getPath('userData'), 'setup.json')
// __dirname resolves to dist/electron/ after CJS compilation
const PROJECT_ROOT = path.resolve(__dirname, '..', '..')

function isFirstRun(): boolean {
  return !existsSync(SETUP_FLAG)
}

async function createWindow(): Promise<BrowserWindow> {
  const firstRun = isFirstRun()

  const win = new BrowserWindow({
    width:     firstRun ? 640  : 1400,
    height:    firstRun ? 520  : 900,
    minWidth:  firstRun ? 640  : 900,
    minHeight: firstRun ? 520  : 600,
    resizable: true,
    backgroundColor: '#0a0a1a',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })

  // Block Cmd+R / Ctrl+R / F5 to prevent page reload (loses terminal state)
  win.webContents.on('before-input-event', (_event, input) => {
    if (
      (input.key === 'r' && (input.meta || input.control)) ||
      input.key === 'F5'
    ) {
      _event.preventDefault()
    }
  })

  // Only allow http/https links to open externally (blocks ms-msdt:, file:, etc.)
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      const parsed = new URL(url)
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') {
        shell.openExternal(url)
      }
    } catch {
      // malformed URL — ignore
    }
    return { action: 'deny' }
  })

  if (isDev) {
    // Dev: server already running, connect directly
    const port = process.env.SERVER_PORT ?? '3332'
    await win.loadURL(`http://localhost:${port}`)
  } else {
    // Production: show loading screen immediately while server starts
    const loadingPath = path.join(__dirname, 'loading.html')
    await win.loadFile(loadingPath)
  }

  return win
}

// ── Pop-out floating terminal windows (draggable to another monitor) ──
let mainWindowRef: BrowserWindow | null = null
const popoutWindows = new Map<string, BrowserWindow>()

const POPOUT_DEFAULT_SIZE = { width: 820, height: 560 }
// Last-used popout window bounds, persisted so the window re-opens where the
// user last placed it — e.g. dragged onto a second monitor.
const POPOUT_BOUNDS_FILE = path.join(app.getPath('userData'), 'popout-bounds.json')

interface WindowBounds { x: number; y: number; width: number; height: number }

function loadPopoutBounds(): WindowBounds | null {
  try {
    const raw = readFileSync(POPOUT_BOUNDS_FILE, 'utf8')
    const b = JSON.parse(raw) as Partial<WindowBounds>
    if (
      typeof b.x === 'number' && typeof b.y === 'number' &&
      typeof b.width === 'number' && typeof b.height === 'number'
    ) {
      return { x: b.x, y: b.y, width: b.width, height: b.height }
    }
  } catch { /* missing or malformed — fall back to auto-placement */ }
  return null
}

function savePopoutBounds(bounds: WindowBounds): void {
  try { writeFileSync(POPOUT_BOUNDS_FILE, JSON.stringify(bounds)) } catch { /* ignore */ }
}

/** True when the window's center sits inside some currently-connected display.
 *  Guards against restoring onto a monitor that has since been unplugged. */
function boundsOnSomeDisplay(b: WindowBounds): boolean {
  const cx = b.x + b.width / 2
  const cy = b.y + b.height / 2
  return screen.getAllDisplays().some((d) => {
    const { x, y, width, height } = d.bounds
    return cx >= x && cx <= x + width && cy >= y && cy <= y + height
  })
}

/** Where a fresh popout should open: the last-saved bounds when still visible,
 *  otherwise centered on a secondary monitor if one exists, else the display
 *  under the cursor (falls back to primary). */
function computePopoutBounds(): WindowBounds {
  const saved = loadPopoutBounds()
  if (saved && boundsOnSomeDisplay(saved)) return saved

  const displays = screen.getAllDisplays()
  const primary = screen.getPrimaryDisplay()
  const target =
    displays.find((d) => d.id !== primary.id) ??
    screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  const { x, y, width, height } = target.workArea
  const { width: w, height: h } = POPOUT_DEFAULT_SIZE
  return {
    x: Math.round(x + (width - w) / 2),
    y: Math.round(y + (height - h) / 2),
    width: w,
    height: h,
  }
}

function registerPopoutHandler() {
  ipcMain.handle('window:open-terminal', (_e, opts: { terminalId?: string; originSessionId?: string; label?: string }) => {
    const terminalId = opts?.terminalId
    if (!terminalId) return { ok: false }
    // Don't duplicate — focus an existing popout for this terminal.
    const existing = popoutWindows.get(terminalId)
    if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true } }

    const port = process.env.SERVER_PORT ?? '3333'
    const qs = new URLSearchParams({ popout: 'terminal', terminalId })
    if (opts.originSessionId) qs.set('originSessionId', opts.originSessionId)
    if (opts.label) qs.set('label', opts.label)

    const bounds = computePopoutBounds()
    const w = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      minWidth: 480, minHeight: 320,
      backgroundColor: '#0a0a1a',
      title: opts.label || 'Floating terminal',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // Remember where the user leaves it (incl. which monitor) for next time.
    const persistBounds = () => { if (!w.isDestroyed()) savePopoutBounds(w.getBounds()) }
    w.on('moved', persistBounds)
    w.on('resized', persistBounds)
    // Same guards as the main window: no reload (loses terminal), no in-app nav.
    w.webContents.on('before-input-event', (ev, input) => {
      if ((input.key === 'r' && (input.meta || input.control)) || input.key === 'F5') ev.preventDefault()
    })
    w.webContents.setWindowOpenHandler(({ url }) => {
      try { const p = new URL(url); if (p.protocol === 'https:' || p.protocol === 'http:') shell.openExternal(url) } catch { /* ignore */ }
      return { action: 'deny' }
    })
    popoutWindows.set(terminalId, w)
    w.on('closed', () => {
      popoutWindows.delete(terminalId)
      // Tell the main window to re-dock the in-app float.
      if (mainWindowRef && !mainWindowRef.isDestroyed()) {
        mainWindowRef.webContents.send('popout:closed', terminalId)
      }
    })
    void w.loadURL(`http://localhost:${port}/?${qs.toString()}`)
    return { ok: true }
  })
}

/** Register the native OS folder picker used by the "Browse…" button in the
 *  session-creation modals. Returns the chosen absolute directory path, or null
 *  when cancelled. */
function registerDirectoryPickerHandler() {
  ipcMain.handle('dialog:select-directory', async (_e, opts?: { defaultPath?: string }) => {
    const parent = mainWindowRef && !mainWindowRef.isDestroyed() ? mainWindowRef : undefined
    const result = await dialog.showOpenDialog(parent as BrowserWindow, {
      properties: ['openDirectory', 'createDirectory'],
      defaultPath: opts?.defaultPath || app.getPath('home'),
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
}

// Native PROJECT windows, keyed by projectPath. The PROJECT "float" button opens
// the project browser in its own OS window (draggable to another monitor); a DOM
// panel can't leave the app window. De-duped by path — a second open focuses the
// existing window instead of spawning a duplicate.
const projectPopoutWindows = new Map<string, BrowserWindow>()

/** Register the `window:open-project` IPC: open the standalone /project-browser
 *  route in its own native window, placed on a secondary monitor when one exists
 *  (computePopoutBounds) with bounds persisted across opens. */
function registerProjectWindowHandler() {
  ipcMain.handle('window:open-project', (_e, opts: { path?: string; file?: string; label?: string }) => {
    const projectPath = opts?.path
    if (!projectPath) return { ok: false }
    const existing = projectPopoutWindows.get(projectPath)
    if (existing && !existing.isDestroyed()) { existing.focus(); return { ok: true } }

    const port = process.env.SERVER_PORT ?? '3333'
    const qs = new URLSearchParams({ popout: 'project', path: projectPath })
    if (opts.file) qs.set('file', opts.file)

    const bounds = computePopoutBounds()
    const w = new BrowserWindow({
      x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height,
      minWidth: 480, minHeight: 320,
      backgroundColor: '#0a0a1a',
      title: opts.label || 'Project',
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    })

    // Remember where the user leaves it (incl. which monitor) for next time.
    const persistBounds = () => { if (!w.isDestroyed()) savePopoutBounds(w.getBounds()) }
    w.on('moved', persistBounds)
    w.on('resized', persistBounds)
    // Open external links in the system browser; never navigate the window away.
    w.webContents.setWindowOpenHandler(({ url }) => {
      try { const p = new URL(url); if (p.protocol === 'https:' || p.protocol === 'http:') shell.openExternal(url) } catch { /* ignore */ }
      return { action: 'deny' }
    })
    projectPopoutWindows.set(projectPath, w)
    w.on('closed', () => { projectPopoutWindows.delete(projectPath) })
    void w.loadURL(`http://localhost:${port}/?${qs.toString()}`)
    return { ok: true }
  })
}

function js(win: BrowserWindow, expr: string) {
  win.webContents.executeJavaScript(expr).catch(() => {})
}

function sendLoadingUpdate(win: BrowserWindow, progress: number, msg: string) {
  js(win, `window.updateProgress && window.updateProgress(${progress}, ${JSON.stringify(msg)})`)
}

function sendLog(win: BrowserWindow, text: string, isError = false) {
  const lines = text.split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    js(win, `window.addLog && window.addLog(${JSON.stringify(line)}, ${isError})`)
  }
}

/** Intercept process stdout/stderr and mirror every line to the loading screen. */
function captureLogsToLoadingScreen(win: BrowserWindow): () => void {
  const origOut = process.stdout.write.bind(process.stdout)
  const origErr = process.stderr.write.bind(process.stderr)

  ;(process.stdout as NodeJS.WriteStream & { write: (...a: unknown[]) => boolean }).write =
    (chunk: unknown, ...rest: unknown[]) => {
      sendLog(win, String(chunk), false)
      return (origOut as (...a: unknown[]) => boolean)(chunk, ...rest)
    }
  ;(process.stderr as NodeJS.WriteStream & { write: (...a: unknown[]) => boolean }).write =
    (chunk: unknown, ...rest: unknown[]) => {
      sendLog(win, String(chunk), true)
      return (origErr as (...a: unknown[]) => boolean)(chunk, ...rest)
    }

  return () => {
    process.stdout.write = origOut
    process.stderr.write = origErr
  }
}

app.whenReady().then(async () => {
  // Register IPC handlers first so renderer can call them on load
  registerSetupHandlers()
  registerAppHandlers()
  registerTerminalHandlers()
  registerPopoutHandler()
  registerDirectoryPickerHandler()
  registerProjectWindowHandler()

  // Create window immediately — shows loading screen in production
  const win = await createWindow()
  mainWindowRef = win
  setupTray(win)
  buildAppMenu(win)

  if (!isDev) {
    // Production: start Express server in-process, stream logs to loading UI, then navigate
    // In dev mode the server is already running via `tsx watch server/index.ts`
    sendLoadingUpdate(win, 10, 'Starting server')
    process.env.APP_USER_DATA = app.getPath('userData')

    // Mirror all stdout/stderr to the loading screen
    const restoreLogs = captureLogsToLoadingScreen(win)

    try {
      // server-bundle.cjs is a CJS bundle produced by esbuild (npm run build:server)
      const serverPath = path.join(PROJECT_ROOT, 'dist', 'server-bundle.cjs')
      const serverModule = require(serverPath) as {
        startServer: (port?: number) => Promise<number>
        shutdownServer: () => Promise<void>
      }
      serverShutdown = serverModule.shutdownServer
      sendLoadingUpdate(win, 30, 'Starting server')
      const port = await serverModule.startServer()
      process.env.SERVER_PORT = String(port)
      sendLoadingUpdate(win, 95, 'Loading app')
      restoreLogs()
      await win.loadURL(`http://localhost:${port}`)
    } catch (err) {
      restoreLogs()
      const msg = err instanceof Error ? err.message : String(err)
      js(win, `window.showError && window.showError(${JSON.stringify(msg)})`)
    }
  }
})

function buildAppMenu(win: BrowserWindow) {
  const isMac = process.platform === 'darwin'

  const template: Electron.MenuItemConstructorOptions[] = [
    // macOS app menu (required for Cmd+Q, about, etc.)
    ...(isMac ? [{
      label: app.name,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'services' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' as const },
        { role: 'redo' as const },
        { type: 'separator' as const },
        { role: 'cut' as const },
        { role: 'copy' as const },
        { role: 'paste' as const },
        { role: 'pasteAndMatchStyle' as const },
        { role: 'selectAll' as const },
      ],
    },
    {
      label: 'View',
      submenu: [
        {
          label: 'Reload',
          accelerator: isMac ? 'Cmd+R' : 'Ctrl+R',
          click: () => { win.webContents.reload() },
        },
        {
          label: 'Force Reload',
          accelerator: isMac ? 'Cmd+Shift+R' : 'Ctrl+Shift+R',
          click: () => { win.webContents.reloadIgnoringCache() },
        },
        { type: 'separator' },
        {
          label: 'Zoom In',
          accelerator: isMac ? 'Cmd+=' : 'Ctrl+=',
          click: () => { win.webContents.setZoomLevel(win.webContents.getZoomLevel() + 0.5) },
        },
        {
          label: 'Zoom Out',
          accelerator: isMac ? 'Cmd+-' : 'Ctrl+-',
          click: () => { win.webContents.setZoomLevel(win.webContents.getZoomLevel() - 0.5) },
        },
        {
          label: 'Reset Zoom',
          accelerator: isMac ? 'Cmd+0' : 'Ctrl+0',
          click: () => { win.webContents.setZoomLevel(0) },
        },
        { type: 'separator' },
        {
          label: 'Toggle Fullscreen',
          accelerator: isMac ? 'Ctrl+Cmd+F' : 'F11',
          click: () => { win.setFullScreen(!win.isFullScreen()) },
        },
      ],
    },
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

// Graceful shutdown: notify renderer to save workspace, then shut down server.
// This runs BEFORE windows close, so the server is still alive.
let isQuitting = false
app.on('before-quit', async (e) => {
  if (isQuitting) return
  e.preventDefault()
  isQuitting = true

  // Tell renderer to save workspace — wait up to 5s for it to finish
  const windows = BrowserWindow.getAllWindows()
  if (windows.length > 0) {
    const win = windows[0]
    try {
      await Promise.race([
        new Promise<void>((resolve) => {
          ipcMain.once('app:close-ready', () => resolve())
          win.webContents.send('app:before-close')
        }),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ])
    } catch {
      // best effort — don't block quit
    }
  }

  // Kill all PTY host terminals
  disposePtyHost()

  // Shut down server (save SQLite snapshot, close DB)
  if (serverShutdown) {
    const fn = serverShutdown
    serverShutdown = null
    try {
      await fn()
    } catch {
      // best effort
    }
  }
  app.quit()
})

app.on('window-all-closed', () => {
  // Do nothing — tray keeps app alive.
  // Actual quit comes from tray "Quit" menu item only.
})

// macOS: clicking the dock icon should bring the window back into focus.
// The window is hidden (not destroyed) when the user clicks X, so we just show it.
app.on('activate', () => {
  const allWindows = BrowserWindow.getAllWindows()
  if (allWindows.length > 0) {
    allWindows[0].show()
    allWindows[0].focus()
  }
})
