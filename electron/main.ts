process.env.ELECTRON = '1'

import { app, BrowserWindow, shell, Menu, ipcMain } from 'electron'
import path from 'path'
import { existsSync } from 'fs'
import { setupTray } from './tray.js'
import { registerSetupHandlers } from './ipc/setupHandlers.js'
import { registerAppHandlers } from './ipc/appHandlers.js'

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

  // Create window immediately — shows loading screen in production
  const win = await createWindow()
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
