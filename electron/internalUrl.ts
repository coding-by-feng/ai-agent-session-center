/**
 * Same-origin classification for `window.open` targets in the Electron shell.
 *
 * Why this exists: the main window's `setWindowOpenHandler` used to route EVERY
 * http/https URL to `shell.openExternal`, which cannot tell one of our own
 * in-app routes from a real external site. Any renderer call site that reached
 * for `window.open('/project-browser?path=...')` — the Project tab's right-click
 * "Open in New Tab", and the two standalone fallbacks in ProjectTab — therefore
 * escaped the app entirely and popped the user's default browser open on
 * `http://localhost:<port>/...`. Classifying our own origin here lets the shell
 * open a native BrowserWindow for it instead.
 *
 * Deliberately port-scoped, not a blanket "localhost is internal" rule: the
 * terminal's link handler routes clicked URLs through the same path, and a user
 * clicking their own dev server (`http://localhost:3000`) still expects a real
 * browser. Only OUR port is ours.
 *
 * Kept import-free and side-effect-free so it can be unit-tested without
 * booting Electron (`electron/` cannot import from `server/` — same tsconfig
 * roots constraint as ptyRing.ts).
 */

/** Hostnames that address the machine the app itself is running on. */
const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '::1'])

/**
 * True when `url` points at this app's own embedded server — i.e. an in-app
 * route that must open as a native window rather than in the system browser.
 *
 * @param url  the raw URL string handed to `setWindowOpenHandler`
 * @param port the app's server port, as a string (dev and prod differ)
 */
export function isInternalAppUrl(url: string, port: string): boolean {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false // malformed — never treat as ours
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false
  if (!LOOPBACK_HOSTS.has(parsed.hostname)) return false
  // An explicit port is required: a bare `http://localhost/` (port 80) is not us.
  return parsed.port !== '' && parsed.port === String(port)
}
