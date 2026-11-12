/**
 * clientMain.ts — the main process of the two Client editions, which only ever show another computer's AASC.
 *
 * There is no server, PTY host, hook install, setup wizard or tray here, and main.ts never loads. One window is this
 * app's own: the home page, which asks for a pairing link and lists the paired computers. Every other window is a
 * remote's (remote/remoteWindow.ts), showing the UI this Client carries (remote/clientUi.ts).
 *
 * Home hides once a computer opens and comes back when the last remote window closes, so there is always a way back to
 * the list. Only the first home of a launch may open a computer by itself, or closing a dashboard would reopen it.
 */
import { app, BrowserWindow, Menu, protocol, session, type MenuItemConstructorOptions } from 'electron'
import { readFile } from 'fs/promises'
import path from 'path'
import { CLIENT_DATA_FOLDER, clientAppName, readClientEdition } from './clientEdition.js'
import { initCrashLogger } from './crashLogger.js'
import { keepOpenWindowsSignedIn, registerRemoteHandlers } from './ipc/remoteHandlers.js'
import { CLIENT_HOME_SCHEME, CLIENT_HOME_URL, createHomeHandler, isClientHomeSenderUrl, serveBundledUi } from './remote/clientUi.js'
import { claimSingleInstance, revealRunningWindow } from './singleInstance.js'

// Before anything reads it. The packaged name already says this; an unpackaged run would otherwise take the repo's
// `ai-agent-session-center`, a running AASC's real data folder. `--user-data-dir` keeps a test away from the real one.
if (!app.commandLine.hasSwitch('user-data-dir')) {
  app.setPath('userData', path.join(app.getPath('appData'), CLIENT_DATA_FOLDER))
}

const appName = clientAppName(readClientEdition(app.getAppPath()))
const UI_ROOT = path.join(__dirname, '..', 'client')
const HOME_ROOT = path.join(__dirname, '..', 'client-home')
// cjsRename.mjs emits .cjs; any other name silently loads no preload (test/electronPreloadPath.test.ts).
const PRELOAD_PATH = path.join(__dirname, 'preloadClient.cjs')
/**
 * How often an open dashboard's session is checked, which is the longest a dead one shows its password form. It asks the
 * remote one small question and spends no session.
 */
const KEEP_SIGNED_IN_EVERY_MS = 10_000

protocol.registerSchemesAsPrivileged([
  { scheme: CLIENT_HOME_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
])

let homeWindow: BrowserWindow | null = null
let homeCreatedThisLaunch = false
let quitting = false

const isSecondInstance = !claimSingleInstance(app, revealOnSecondLaunch)
if (isSecondInstance) app.exit(0)

initCrashLogger()

function showHome(): void {
  if (homeWindow && !homeWindow.isDestroyed()) {
    homeWindow.show()
    homeWindow.focus()
    homeWindow.webContents.send('client:home-shown')
    return
  }
  const url = homeCreatedThisLaunch ? CLIENT_HOME_URL : `${CLIENT_HOME_URL}?start=1`
  homeCreatedThisLaunch = true
  const win = new BrowserWindow({
    width: 640,
    height: 640,
    minWidth: 480,
    minHeight: 480,
    title: appName,
    backgroundColor: '#ece9d8', // Matches the page's theme, or every open flashes dark first.
    webPreferences: {
      preload: PRELOAD_PATH,
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webviewTag: false,
    },
  })
  homeWindow = win
  win.on('page-title-updated', (event) => event.preventDefault())
  win.on('closed', () => {
    if (homeWindow === win) homeWindow = null
  })
  // This page has no links, so anything that tries to leave it is refused.
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  void win.loadURL(url)
}

/** A Dock click (`activate`): bring the dashboard forward, or the list. */
function showRunningWindow(): void {
  const remote = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== homeWindow)
  if (!remote) {
    if (app.isReady()) showHome()
    return
  }
  if (remote.isMinimized()) remote.restore()
  remote.show()
  remote.focus()
}

/** Another launch found this app running: show it without taking the keyboard (revealRunningWindow). */
function revealOnSecondLaunch(): void {
  const remote = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed() && w !== homeWindow)
  const target = remote ?? (homeWindow && !homeWindow.isDestroyed() ? homeWindow : null)
  if (target) revealRunningWindow(target, process.platform, () => { app.dock?.bounce('informational') })
  else if (app.isReady()) showHome()
}

function buildMenu(): void {
  const isMac = process.platform === 'darwin'
  const focused = () => BrowserWindow.getFocusedWindow()
  const zoom = (delta: number) => {
    const wc = focused()?.webContents
    if (wc) wc.setZoomLevel(wc.getZoomLevel() + delta)
  }
  // No accelerator on Computers… or Reload: a dashboard's terminal and its shortcuts own the keyboard.
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: appName,
      submenu: [
        { role: 'about' as const },
        { type: 'separator' as const },
        { role: 'hide' as const },
        { role: 'hideOthers' as const },
        { role: 'unhide' as const },
        { type: 'separator' as const },
        { role: 'quit' as const },
      ],
    }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Computers…', click: showHome },
        { type: 'separator' },
        { role: 'close' },
        ...(isMac ? [] : [{ role: 'quit' as const }]),
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', click: () => focused()?.webContents.reload() },
        { type: 'separator' },
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: () => zoom(0.5) },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: () => zoom(-0.5) },
        { label: 'Reset Zoom', accelerator: 'CmdOrCtrl+0', click: () => focused()?.webContents.setZoomLevel(0) },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

app.on('browser-window-created', (_event, win) => {
  win.once('closed', () => {
    if (quitting || win === homeWindow) return
    const remoteLeft = BrowserWindow.getAllWindows().some((w) => !w.isDestroyed() && w !== homeWindow)
    if (!remoteLeft) showHome()
  })
})

app.on('before-quit', () => {
  quitting = true
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

// macOS's own answer, not isVisible(): Electron says a window covered by another app isn't visible, so clicking the Dock
// icon would have put the list over a dashboard that was only behind something.
app.on('activate', (_event, hasVisibleWindows) => {
  if (app.isReady() && !hasVisibleWindows) showRunningWindow()
})

/** The next round starts only after this one ends, however long a computer takes to not answer. */
function keepSigningIn(): void {
  setTimeout(() => {
    void keepOpenWindowsSignedIn().finally(keepSigningIn)
  }, KEEP_SIGNED_IN_EVERY_MS)
}

app.whenReady().then(() => {
  if (isSecondInstance) return
  // Only this app's own page can ask for anything; a remote's partition has its own rules (remoteWindow.ts).
  session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  protocol.handle(CLIENT_HOME_SCHEME, createHomeHandler({ root: HOME_ROOT, read: (file) => readFile(file) }))
  registerRemoteHandlers({
    isAppSender: isClientHomeSenderUrl,
    beforeLoad: (ses, origin) => serveBundledUi(ses, origin, UI_ROOT, () => BrowserWindow.getAllWindows()),
    onOpened: () => homeWindow?.hide(),
    keepSignedIn: true,
  })
  buildMenu()
  showHome()
  keepSigningIn()
})
