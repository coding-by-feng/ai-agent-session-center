/**
 * singleInstance.ts — one running copy per data folder. Full and Lite share a folder (edition.ts),
 * so this one lock covers both: opening the second brings the first forward instead of starting a
 * second server on the same sessions.db, which would also kill the first through its port.
 */
export interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean
  on(event: 'second-instance', listener: () => void): unknown
}

/** False when another copy holds the lock: this one must exit without starting anything. */
export function claimSingleInstance(app: SingleInstanceApp, showRunningWindow: () => void): boolean {
  if (!app.requestSingleInstanceLock()) return false
  app.on('second-instance', showRunningWindow)
  return true
}
