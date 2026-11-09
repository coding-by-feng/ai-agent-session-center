// notifyHandlers.ts — `app:notify` (Nov 8 2026): the main window asks for a system notification about one
// session (src/hooks/useProceedNotifications.ts: its answer asks the user to reply "proceed"). Only the main
// window may ask; the text is flattened and clipped here again. A click restores and focuses that window and
// sends it `app:open-session` with the session id. Shown from the main process, so a click can raise a hidden
// window (a renderer `new Notification()` can't on macOS).
import { ipcMain, Notification, type BrowserWindow } from 'electron'

const SESSION_ID = /^[A-Za-z0-9_-]{1,64}$/
const TITLE_MAX = 80
const BODY_MAX = 120

function clean(raw: unknown, max: number): string | null {
  if (typeof raw !== 'string') return null
  const flat = raw.replace(/[\x00-\x1F\x7F-\x9F]+/g, ' ').replace(/\s+/g, ' ').trim()
  if (!flat) return null
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat
}

/** Shown notifications, held so they aren't collected before a click (a collected one loses its handler). Capped:
 *  macOS doesn't always report one dismissed from Notification Centre. */
const live = new Set<Notification>()
const LIVE_MAX = 30

export function registerNotifyHandlers(getMainWindow: () => BrowserWindow | null): void {
  ipcMain.handle('app:notify', (event, input: unknown) => {
    const win = getMainWindow()
    if (!win || win.isDestroyed() || event.sender !== win.webContents) return { ok: false }
    if (!input || typeof input !== 'object') return { ok: false }
    const { sessionId, title, body } = input as Record<string, unknown>
    const cleanTitle = clean(title, TITLE_MAX)
    const cleanBody = clean(body, BODY_MAX)
    if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId) || !cleanTitle || !cleanBody) return { ok: false }
    if (!Notification.isSupported()) return { ok: false }

    const notification = new Notification({ title: cleanTitle, body: cleanBody })
    live.add(notification)
    if (live.size > LIVE_MAX) live.delete(live.values().next().value as Notification)
    const forget = () => { live.delete(notification) }
    notification.on('click', () => {
      forget()
      const target = getMainWindow()
      if (!target || target.isDestroyed()) return
      if (target.isMinimized()) target.restore()
      target.show()
      target.focus()
      target.webContents.send('app:open-session', sessionId)
    })
    notification.on('close', forget)
    notification.show()
    return { ok: true }
  })
}
