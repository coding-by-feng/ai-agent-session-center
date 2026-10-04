/**
 * queuePopout — open one session's QUEUE panel in its own window.
 *
 * Mirrors the PROJECT tab's float button (`DetailTabs.openProjectWindow`): under
 * Electron the session is handed to a native BrowserWindow (`window:open-queue`,
 * bounds remembered per kind, one window per session); a plain browser opens the
 * same view with `window.open`. The docked panel is left alone — the two are live
 * views of the same shared queue.
 *
 * Under Electron there is deliberately NO `window.open` fallback. The shell's
 * window-open policy sends anything it cannot place to the system browser, so a
 * preload that lacks `openQueueWindow` would silently pop Chrome open on
 * localhost. A stale preload is a build problem, not something to paper over by
 * leaving the app — the caller is told (`'unsupported'`) instead.
 *
 * Depends only on the global `window` and the import-free `sessionDisplayTitle`,
 * so it is unit-testable and safe to pull into any component.
 */
import { sessionDisplayTitle, type TitledSession } from '@/lib/sessionDisplayTitle';

/**
 * What happened, so the caller can say the truthful thing:
 *  - `native`      — Electron opened (or focused) the session's queue window
 *  - `browser`     — a browser popup window opened
 *  - `blocked`     — the browser refused the popup
 *  - `unsupported` — Electron without the bridge method, a failed IPC call, or no session id
 */
export type QueuePopoutOutcome = 'native' | 'browser' | 'blocked' | 'unsupported';

/** The size a browser popup opens at — kept equal to electron/popoutBounds.ts' `queue` default. */
const POPUP_WIDTH = 960;
const POPUP_HEIGHT = 720;

/**
 * "Queue — <session name>": the title of the window and of the page inside it.
 * Goes through `sessionDisplayTitle`, never `session.title` alone — that stays
 * empty until the first prompt.
 */
export function queuePopoutTitle(session: TitledSession | null | undefined): string {
  return session ? `Queue — ${sessionDisplayTitle(session)}` : 'Queue';
}

/** The standalone route a queue window loads. */
export function queuePopoutUrl(sessionId: string): string {
  return `/?popout=queue&sessionId=${encodeURIComponent(sessionId)}`;
}

/** One stable window name per session, so a second click reuses the open popup. */
export function queuePopoutWindowName(sessionId: string): string {
  return `aasc-queue-${sessionId.replace(/[^a-zA-Z0-9]/g, '_')}`;
}

/**
 * The popup each session's queue is open in, kept so a second click can FOCUS it.
 * The window name alone does not do that: `window.open(url, name)` on an existing
 * named window navigates it to `url` again, which reloads the popup — dropping the
 * draft being typed in it and any push still waiting out its debounce. Lost on a
 * reload of this window, in which case a click behaves as it always did.
 */
const openPopups = new Map<string, Window>();

/** Test-only: forget the popups opened so far. */
export function _resetQueuePopoutsForTests(): void {
  openPopups.clear();
}

export async function openQueuePopout(opts: { sessionId: string; label?: string }): Promise<QueuePopoutOutcome> {
  const { sessionId, label } = opts;
  if (!sessionId) return 'unsupported';

  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;
  if (api?.openQueueWindow) {
    try {
      const res = await api.openQueueWindow({ sessionId, label });
      return res?.ok ? 'native' : 'unsupported';
    } catch {
      // The main process has no handler (a renderer newer than its shell).
      return 'unsupported';
    }
  }
  // Electron without the bridge method: do nothing (see the file header).
  if (api) return 'unsupported';

  // Already open: bring it forward, never navigate it (see `openPopups`).
  const existing = openPopups.get(sessionId);
  if (existing && !existing.closed) {
    existing.focus();
    return 'browser';
  }
  openPopups.delete(sessionId);

  // A features string with a size is what makes the browser open a real separate
  // WINDOW (draggable to another monitor) instead of a new tab. Centered on the
  // current screen.
  const availW = window.screen.availWidth || POPUP_WIDTH;
  const availH = window.screen.availHeight || POPUP_HEIGHT;
  const w = Math.min(POPUP_WIDTH, availW);
  const h = Math.min(POPUP_HEIGHT, availH);
  const left = Math.round((availW - w) / 2);
  const top = Math.round((availH - h) / 2);
  const features = `popup,noopener=no,width=${w},height=${h},left=${left},top=${top}`;
  const popup = window.open(queuePopoutUrl(sessionId), queuePopoutWindowName(sessionId), features);
  if (!popup) return 'blocked';
  openPopups.set(sessionId, popup);
  return 'browser';
}
