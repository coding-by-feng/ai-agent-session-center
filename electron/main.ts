process.env.ELECTRON = '1'

import { app, BrowserWindow, shell } from 'electron'
import path from 'path'
import { existsSync } from 'fs'
import { setupTray } from './tray.js'
import { registerSetupHandlers } from './ipc/setupHandlers.js'
import { registerAppHandlers } from './ipc/appHandlers.js'

const isDev = !app.isPackaged
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
    resizable: !firstRun,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
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

  const port = process.env.SERVER_PORT ?? (isDev ? '3332' : '3333')
  await win.loadURL(`http://localhost:${port}`)

  return win
}

app.whenReady().then(async () => {
  // Register IPC handlers first so renderer can call them on load
  registerSetupHandlers()
  registerAppHandlers()

  if (!isFirstRun()) {
    // Normal launch: start Express server in-process, then open window
    // Use require() to avoid TypeScript following ESM server files during CJS compilation
    const serverPath = path.join(PROJECT_ROOT, 'server', 'index.js')
    const { startServer } = require(serverPath) as { startServer: (port?: number) => Promise<number> }
    const port = await startServer()
    process.env.SERVER_PORT = String(port)
  }

  const win = await createWindow()
  setupTray(win)
})

app.on('window-all-closed', () => {
  // Do nothing — tray keeps app alive.
  // Actual quit comes from tray "Quit" menu item only.
})
