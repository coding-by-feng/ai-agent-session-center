process.env.ELECTRON = '1'

import { app, BrowserWindow, shell, Menu } from 'electron'
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
    resizable: true,
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

  if (!isFirstRun() && !isDev) {
    // Production launch: start Express server in-process, then open window
    // In dev mode, the server is already running via `tsx watch server/index.ts`
    // Set APP_USER_DATA so the server reads config from the writable userData dir
    process.env.APP_USER_DATA = app.getPath('userData')
    // Use require() to avoid TypeScript following ESM server files during CJS compilation
    const serverPath = path.join(PROJECT_ROOT, 'server', 'index.js')
    const { startServer } = require(serverPath) as { startServer: (port?: number) => Promise<number> }
    const port = await startServer()
    process.env.SERVER_PORT = String(port)
  }

  const win = await createWindow()
  setupTray(win)
  buildAppMenu(win)
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
      label: 'View',
      submenu: [
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

app.on('window-all-closed', () => {
  // Do nothing — tray keeps app alive.
  // Actual quit comes from tray "Quit" menu item only.
})
