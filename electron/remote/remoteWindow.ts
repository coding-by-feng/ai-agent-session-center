/**
 * A remote computer's own AASC UI in its own window (Remote computers, Oct 28 2026).
 *
 * The page comes from another machine, so it is treated like a website, not like our
 * renderer: NO preload (it must never reach `electronAPI`, which drives local PTYs),
 * sandboxed, context-isolated, and in its own persistent partition per remote so its
 * cookie and storage never mix with the local dashboard's or another remote's. This is
 * the one deliberate exception to "every window uses PRELOAD_PATH + attachWindowOpenPolicy"
 * (docs/feature/electron/app-lifecycle.md): the policy below is the remote-origin version.
 *
 * The security decisions are the pure helpers at the top, tested without Electron in
 * test/remoteWindow.test.ts.
 */
import { BrowserWindow, session, shell, type Session, type WebPreferences } from 'electron'

/** One partition per remote: its sign-in cookie and storage stay there. */
export function remotePartition(id: string): string {
  return `persist:aasc-remote-${id}`
}

/** A remote page's preferences: no preload, no Node, sandboxed and isolated. */
export function remoteWindowWebPreferences(id: string): WebPreferences {
  return {
    partition: remotePartition(id),
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    nodeIntegrationInSubFrames: false,
    webviewTag: false,
    webSecurity: true,
    allowRunningInsecureContent: false,
  }
}

export type RemoteUrlClass = 'same-origin' | 'external' | 'drop'

/**
 * Where a link or `window.open` from a remote page goes: the remote's own origin
 * (scheme, host AND port) stays in the app; any other http(s) URL goes to the system
 * browser; everything else (javascript:, file:, data:, blob:, custom schemes,
 * malformed) is dropped.
 */
export function classifyRemoteUrl(url: string, origin: string): RemoteUrlClass {
  let parsed: URL
  let home: URL
  try {
    parsed = new URL(url)
    home = new URL(origin)
  } catch {
    return 'drop'
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return 'drop'
  return parsed.origin === home.origin ? 'same-origin' : 'external'
}

/** Only writing to the clipboard (the UI's copy buttons); no camera, mic, notifications, location… */
export function remotePermissionAllowed(permission: string): boolean {
  return permission === 'clipboard-sanitized-write'
}

/** The keys `isPasteShortcut` reads off Electron's `before-input-event` input. */
export interface PasteKeyInput {
  type: string
  key: string
  meta: boolean
  control: boolean
  shift: boolean
  alt: boolean
}

/**
 * ⌘V (macOS) / Ctrl+V (elsewhere). A remote's terminal up to 2.10.64 cancels the native paste and reads the
 * async Clipboard API, which a remote's plain-http page lacks and this window refuses (`clipboard-read`), so
 * the window turns the key into a native paste itself: the page gets a paste event it may always read.
 */
export function isPasteShortcut(input: PasteKeyInput, platform: string = process.platform): boolean {
  if (input.type !== 'keyDown' || input.key.toLowerCase() !== 'v' || input.shift || input.alt) return false
  return platform === 'darwin' ? input.meta && !input.control : input.control && !input.meta
}

/**
 * Is an IPC call from this app's own dashboard (http on this machine's loopback)? The
 * remote windows load no preload, so they can't call at all; this also refuses a
 * preload window that somehow ended up on another origin.
 */
export function isLocalAppSenderUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && (u.hostname === 'localhost' || u.hostname === '127.0.0.1' || u.hostname === '[::1]')
  } catch {
    return false
  }
}

/** At most this many windows per remote (its main window and its pop-outs): a page can't flood the screen. */
export const MAX_REMOTE_WINDOWS = 6
/** At most one hand-off to the system browser per remote in this long: a page can't spray tabs. */
export const EXTERNAL_OPEN_GAP_MS = 2000

/** May a remote page open one more window, with `open` already open for that remote? */
export function mayOpenRemoteWindow(open: number): boolean {
  return open < MAX_REMOTE_WINDOWS
}

/** May a remote page hand a link to the system browser now, the last hand-off having been at `lastAt`? */
export function mayOpenExternal(lastAt: number | undefined, now: number): boolean {
  return lastAt === undefined || now - lastAt >= EXTERNAL_OPEN_GAP_MS
}

// ── Electron side ───────────────────────────────────────────────────────────

const remoteWindows = new Map<string, BrowserWindow>()
const preparedSessions = new WeakSet<Session>()
const lastExternalAt = new Map<string, number>()

function prepareSession(ses: Session): void {
  if (preparedSessions.has(ses)) return
  preparedSessions.add(ses)
  ses.setPermissionRequestHandler((_wc, permission, callback) => callback(remotePermissionAllowed(permission)))
  ses.setPermissionCheckHandler((_wc, permission) => remotePermissionAllowed(permission))
  // No USB, HID, serial or Bluetooth device, ever. Unhandled, Electron picks the first one found.
  ses.setDevicePermissionHandler(() => false)
  ses.on('select-hid-device', (event, _details, callback) => { event.preventDefault(); callback() })
  ses.on('select-serial-port', (event, _ports, _wc, callback) => { event.preventDefault(); callback('') })
  ses.on('select-usb-device', (event, _details, callback) => { event.preventDefault(); callback() })
}

function windowsOf(id: string): BrowserWindow[] {
  const ses = session.fromPartition(remotePartition(id))
  return BrowserWindow.getAllWindows().filter((w) => !w.isDestroyed() && w.webContents.session === ses)
}

/** Hand a link to the system browser, at most once per EXTERNAL_OPEN_GAP_MS per remote. */
function openExternalFor(id: string, url: string): void {
  const now = Date.now()
  if (!mayOpenExternal(lastExternalAt.get(id), now)) return
  lastExternalAt.set(id, now)
  void shell.openExternal(url)
}

/** The part of `WebContents` the paste shortcut needs. */
export interface PasteTarget {
  on(event: 'before-input-event', listener: (event: { preventDefault(): void }, input: PasteKeyInput) => void): unknown
  paste(): void
}

/**
 * ⌘V / Ctrl+V becomes a native paste (`isPasteShortcut`). The page never sees that keydown, auto-repeat
 * included, only the paste it makes: a remote UI that listened for the keydown itself would hear nothing.
 * Only real input comes through `before-input-event`; a page's synthetic KeyboardEvent never does.
 */
export function attachPasteShortcut(wc: PasteTarget): void {
  wc.on('before-input-event', (event, input) => {
    if (!isPasteShortcut(input)) return
    event.preventDefault()
    wc.paste()
  })
}

/** Keep `win` on `origin`: same-origin pop-ups open as more remote windows, the rest leave or vanish. */
function attachRemotePolicy(win: BrowserWindow, id: string, origin: string, title: string): void {
  win.webContents.setWindowOpenHandler(({ url }) => {
    const kind = classifyRemoteUrl(url, origin)
    if (kind === 'same-origin') openChildWindow(id, origin, title, url)
    else if (kind === 'external') openExternalFor(id, url)
    return { action: 'deny' }
  })
  win.webContents.on('will-navigate', (event, url) => {
    const kind = classifyRemoteUrl(url, origin)
    if (kind === 'same-origin') return
    event.preventDefault()
    if (kind === 'external') openExternalFor(id, url)
  })
  // A server redirect off the remote's origin is stopped, never handed to the browser:
  // it can fire for a sub-frame the person never clicked.
  win.webContents.on('will-redirect', (event, url) => {
    if (classifyRemoteUrl(url, origin) !== 'same-origin') event.preventDefault()
  })
  win.webContents.on('will-attach-webview', (event) => event.preventDefault())
  attachPasteShortcut(win.webContents)
  win.webContents.on('select-bluetooth-device', (event, _devices, callback) => { event.preventDefault(); callback('') })
  // The page names itself "AASC"; the window says which computer it is.
  win.on('page-title-updated', (event) => event.preventDefault())
}

function newRemoteWindow(id: string, origin: string, title: string): BrowserWindow {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 800,
    minHeight: 600,
    title,
    backgroundColor: '#0a0a1a',
    webPreferences: remoteWindowWebPreferences(id),
  })
  attachRemotePolicy(win, id, origin, title)
  return win
}

function openChildWindow(id: string, origin: string, title: string, url: string): void {
  if (!mayOpenRemoteWindow(windowsOf(id).length)) return
  const child = newRemoteWindow(id, origin, title)
  void child.loadURL(url)
}

/** Is a window for this remote open? Focuses it if so. */
export function focusRemoteWindow(id: string): boolean {
  const win = remoteWindows.get(id)
  if (!win || win.isDestroyed()) return false
  if (win.isMinimized()) win.restore()
  win.focus()
  return true
}

export interface OpenRemoteOptions {
  id: string
  name: string
  origin: string
  token: string
  expiresIn: number
  now?: () => number
}

/**
 * Open the remote's UI, signed in: the session token goes in as the same httpOnly
 * `auth_token` cookie the remote's own /session sets, on that remote's partition
 * only, before the first request.
 */
export async function openRemoteWindow(opts: OpenRemoteOptions): Promise<void> {
  if (focusRemoteWindow(opts.id)) return
  const ses = session.fromPartition(remotePartition(opts.id))
  prepareSession(ses)
  const now = opts.now ?? Date.now
  await ses.cookies.set({
    url: `${opts.origin}/`,
    name: 'auth_token',
    value: opts.token,
    path: '/',
    httpOnly: true,
    secure: false,
    sameSite: 'strict',
    expirationDate: Math.floor(now() / 1000) + opts.expiresIn,
  })
  const title = `${opts.name} — AASC`
  const win = newRemoteWindow(opts.id, opts.origin, title)
  remoteWindows.set(opts.id, win)
  win.on('closed', () => {
    if (remoteWindows.get(opts.id) === win) remoteWindows.delete(opts.id)
  })
  await win.loadURL(`${opts.origin}/`)
}

/** Forget a remote here: close its windows and wipe its partition (cookie, storage, cache). */
export async function forgetRemoteWindow(id: string): Promise<void> {
  const partition = remotePartition(id)
  for (const win of windowsOf(id)) win.close()
  remoteWindows.delete(id)
  lastExternalAt.delete(id)
  try {
    await session.fromPartition(partition).clearStorageData()
  } catch {
    // nothing stored, or already gone
  }
}
