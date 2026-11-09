/**
 * autoUpdate.ts — background updates for the packaged Mac app (Full and Lite), from GitHub releases.
 *
 * The update downloads in the background and installs when the person next quits. The app never
 * restarts on its own: a restart ends every agent terminal, so "Restart Now" asks first and saves the
 * workspace before quitting. Squirrel.Mac checks that the new app is signed by the same Developer ID
 * team before swapping it in. Decisions live in autoUpdateRules.ts; this file only wires Electron.
 */
import { app, BrowserWindow, dialog, ipcMain, Notification } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import path from 'path'
import { logMainError } from './crashLogger.js'
import type { DesktopEdition } from './edition.js'
import {
  CHECK_INTERVAL_MS,
  FIRST_CHECK_DELAY_MS,
  UPDATE_REPO,
  parseUpdatePrefs,
  readyNotice,
  restartPrompt,
  serializeUpdatePrefs,
  testFeedUrl,
  updateChannel,
  updateConfigYaml,
  updatePrefsFile,
  updaterSupported,
  type UpdateState,
} from './autoUpdateRules.js'

interface StartOptions {
  edition: DesktopEdition
  appName: string
  /** Saves the workspace and stops the server and terminals, as a normal quit does. */
  shutdown: () => Promise<void>
  /** Called whenever the state changes, e.g. to rebuild the app menu. */
  onChange: () => void
  /** Shows and focuses the main window (it may be hidden in the tray) so a dialog on it can be seen. */
  showMainWindow: () => BrowserWindow | null
}

type Updater = typeof import('electron-updater').autoUpdater

let updater: Updater | null = null
let options: StartOptions | null = null
let state: UpdateState = { status: 'idle', autoCheck: true }
let timer: NodeJS.Timeout | null = null
/** Set while a check started from the menu runs, so its result is shown in a dialog. */
let manualCheck = false
/** Set once Restart Now is confirmed: a second confirmation must not run the install twice. */
let installing = false

const prefsPath = (): string => path.join(app.getPath('userData'), updatePrefsFile(options?.edition ?? 'full'))

function readPrefs() {
  try {
    return parseUpdatePrefs(existsSync(prefsPath()) ? readFileSync(prefsPath(), 'utf8') : null)
  } catch {
    return parseUpdatePrefs(null)
  }
}

function setState(next: Partial<UpdateState>): void {
  state = { ...state, ...next }
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send('update:state', state)
  }
  options?.onChange()
}

/** The window to attach a dialog to, shown first: a dialog on a window hidden in the tray can't be answered. */
function dialogWindow(): BrowserWindow | null {
  const win = options?.showMainWindow() ?? null
  return win && !win.isDestroyed() && win.isVisible() ? win : null
}

async function showMessage(message: string, detail?: string, type: 'info' | 'error' = 'info'): Promise<void> {
  const win = dialogWindow()
  const box = { type, message, detail, buttons: ['OK'] }
  await (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function getUpdateState(): UpdateState {
  return state
}

export function isUpdaterRunning(): boolean {
  return updater !== null
}

/** Check now. From the menu (`manual`) the outcome is always shown; background checks stay silent. */
export async function checkForUpdates(manual: boolean): Promise<void> {
  if (!updater) {
    if (manual) await showMessage('Updates are only available in the installed Mac app.')
    return
  }
  if (state.status === 'checking' || state.status === 'downloading') return
  if (state.status === 'ready') {
    if (manual) await restartToUpdate()
    return
  }
  manualCheck = manual
  try {
    // The download runs on after the check resolves; its failure is reported by the 'error' listener.
    const result = await updater.checkForUpdates()
    result?.downloadPromise?.catch(() => {})
  } catch (err) {
    // The 'error' listener reports it.
    logMainError(`[update] check failed: ${errorText(err)}`)
  }
}

/** Ask, save the workspace, then quit and install. "Later" leaves the update to install on the next quit. */
export async function restartToUpdate(): Promise<void> {
  if (!updater || !options || installing || state.status !== 'ready' || !state.version) return
  const { message, detail } = restartPrompt(options.appName, state.version)
  const win = dialogWindow()
  const box = { type: 'question' as const, message, detail, buttons: ['Restart Now', 'Later'], defaultId: 0, cancelId: 1 }
  const { response } = await (win ? dialog.showMessageBox(win, box) : dialog.showMessageBox(box))
  if (response !== 0 || installing) return
  installing = true
  await options.shutdown()
  try {
    updater.quitAndInstall()
  } catch (err) {
    // The server and terminals are already stopped: quit rather than sit in the tray with nothing behind it.
    logMainError(`[update] install failed: ${errorText(err)}`)
    app.quit()
  }
}

function setAutoCheck(autoCheck: boolean): void {
  try {
    writeFileSync(prefsPath(), serializeUpdatePrefs({ autoCheck }))
  } catch (err) {
    logMainError(`[update] could not save the update setting: ${errorText(err)}`)
  }
  setState({ autoCheck })
  scheduleChecks()
}

function scheduleChecks(): void {
  if (timer) clearInterval(timer)
  timer = null
  if (!updater || !state.autoCheck) return
  timer = setInterval(() => { void checkForUpdates(false) }, CHECK_INTERVAL_MS)
}

/** The items for the app menu, below About. Shown in both editions so Lite can turn checks off. */
export function updateMenuItems(): MenuItemConstructorOptions[] {
  if (!updater) return []
  const busy = state.status === 'checking' || state.status === 'downloading'
  const label =
    state.status === 'ready' && state.version ? `Restart to Install ${state.version}…`
      : state.status === 'downloading' ? `Downloading ${state.version ?? 'Update'}${state.percent ? ` (${state.percent}%)` : ''}…`
        : state.status === 'checking' ? 'Checking for Updates…'
          : 'Check for Updates…'
  return [
    { label, enabled: !busy, click: () => { void checkForUpdates(true) } },
    {
      label: 'Check for Updates Automatically',
      type: 'checkbox',
      checked: state.autoCheck,
      click: (item) => setAutoCheck(item.checked),
    },
  ]
}

function registerIpc(): void {
  ipcMain.handle('update:get-state', () => state)
  ipcMain.handle('update:check', () => checkForUpdates(true))
  ipcMain.handle('update:install', () => restartToUpdate())
}

function attachListeners(u: Updater, appName: string): void {
  u.on('checking-for-update', () => setState({ status: 'checking', error: undefined }))
  u.on('update-not-available', () => {
    setState({ status: 'idle', version: undefined, percent: undefined })
    if (manualCheck) void showMessage(`${appName} is up to date.`, `You have version ${app.getVersion()}.`)
    manualCheck = false
  })
  u.on('update-available', (info) => {
    setState({ status: 'downloading', version: info.version, percent: 0 })
    if (manualCheck) {
      void showMessage(`Downloading ${appName} ${info.version}.`, 'It downloads in the background. You will be told when it is ready to install.')
    }
    manualCheck = false
  })
  u.on('download-progress', (progress) => {
    const percent = Math.floor(progress.percent)
    if (percent !== state.percent) setState({ percent })
  })
  u.on('error', (err) => {
    logMainError(`[update] ${errorText(err)}`)
    if (installing) {
      // Squirrel refused the install after the shutdown (e.g. a signature mismatch): don't leave a dead app.
      app.quit()
      return
    }
    setState({ status: 'error', error: errorText(err), percent: undefined })
    if (manualCheck) void showMessage('Couldn’t check for updates.', errorText(err), 'error')
    manualCheck = false
  })

  // electron-updater reports the download before Squirrel.Mac has staged it. Only once Squirrel has
  // it can a quit install it, so "ready" waits for Electron's own event.
  const { autoUpdater: nativeUpdater } = require('electron') as typeof import('electron')
  nativeUpdater.on('update-downloaded', () => {
    const version = state.version
    setState({ status: 'ready', percent: undefined })
    if (version && Notification.isSupported()) {
      const notice = readyNotice(appName, version)
      const note = new Notification({ title: notice.title, body: notice.body })
      note.on('click', () => { void restartToUpdate() })
      note.show()
    }
  })
}

/** Start checking for updates. Does nothing outside a packaged Mac app. */
export function startAutoUpdate(opts: StartOptions): void {
  options = opts
  state = { status: 'idle', autoCheck: readPrefs().autoCheck }
  // Registered everywhere so the window's update banner gets an answer (always idle) in dev and off-Mac.
  registerIpc()
  if (!updaterSupported(app.isPackaged, process.platform, process.arch)) return

  try {
    const { autoUpdater } = require('electron-updater') as typeof import('electron-updater')
    updater = autoUpdater
  } catch (err) {
    logMainError(`[update] electron-updater failed to load: ${errorText(err)}`)
    return
  }
  const u = updater
  u.logger = {
    info: () => {},
    debug: () => {},
    warn: (m: unknown) => logMainError(`[update] ${String(m)}`),
    error: (m: unknown) => logMainError(`[update] ${String(m)}`),
  }
  // electron-builder's app-update.yml names one cache folder for both editions (they share the package
  // name); point each edition at its own config so neither empties the other's download.
  try {
    const configPath = path.join(app.getPath('userData'), `app-update-${opts.edition}.yml`)
    writeFileSync(configPath, updateConfigYaml(opts.edition))
    u.updateConfigPath = configPath
  } catch (err) {
    logMainError(`[update] could not write the update config: ${errorText(err)}`)
  }
  const feed = testFeedUrl(process.env)
  const channel = updateChannel(opts.edition)
  u.setFeedURL(feed ? { provider: 'generic', url: feed, channel } : { provider: 'github', ...UPDATE_REPO, channel })
  u.channel = channel
  // Setting a channel turns downgrades on in electron-updater; an older release must never replace a newer app.
  u.allowDowngrade = false
  u.allowPrerelease = false
  u.autoDownload = true
  u.autoInstallOnAppQuit = true

  attachListeners(u, opts.appName)
  setTimeout(() => {
    if (state.autoCheck) void checkForUpdates(false)
    scheduleChecks()
  }, FIRST_CHECK_DELAY_MS)
}
