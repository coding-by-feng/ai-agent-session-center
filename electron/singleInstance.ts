/**
 * singleInstance.ts — one running copy per data folder. Full and Lite share a folder (edition.ts),
 * so this one lock covers both: opening the second brings the first forward instead of starting a
 * second server on the same sessions.db, which would also kill the first through its port.
 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  on(event: 'second-instance', listener: () => void): unknown
}

/** The part of a BrowserWindow that revealRunningWindow uses. */
export interface RevealableWindow {
  isDestroyed(): boolean
  isMinimized(): boolean
  isVisible(): boolean
  restore(): void
  show(): void
  showInactive(): void
  focus(): void
}

/**
 * Bring the running copy's window back after a second launch. On macOS that launch is never the user opening the
 * app (the Dock, Finder or Spotlight only activate a running app): it is a script, another session testing a build,
 * or a second copy. So it must not take the keyboard from the app the user is typing in (Nov 10 2026: it stole
 * focus with app.focus({ steal: true }) and the keys went into a session's terminal). A hidden window comes back
 * behind the current app and the Dock icon bounces once; a click on it brings the app forward as usual.
 * Windows and Linux keep bringing it forward: the system there flashes the taskbar rather than moving focus.
 */
export function revealRunningWindow(win: RevealableWindow, platform: NodeJS.Platform, bounce: () => void): void {
  if (win.isDestroyed()) return
  if (platform === 'darwin') {
    if (!win.isMinimized() && !win.isVisible()) win.showInactive()
    bounce()
    return
  }
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

/** False when another copy holds the lock: this one must exit without starting anything. */
export function claimSingleInstance(app: SingleInstanceApp, showRunningWindow: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', showRunningWindow)
  return true
}
