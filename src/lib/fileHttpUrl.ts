/**
 * fileHttpUrl — decides whether a clicked file-path link should bypass the
 * FileOpenChooser popover and open directly in the OS default browser.
 *
 * Motivation: agent transcripts frequently reference absolute paths that live
 * outside any project root (e.g. `/tmp/claude-queue-images/queue-img-*.png`).
 * Those cannot be opened by the in-app viewer — `resolveProjectPath()` on the
 * server strips the leading `/` and resolves against the project root, so the
 * path resolves to `<projectRoot>/tmp/…` and 404s. Rather than surface a
 * popover whose actions all fail, we hand the file to the browser as an
 * `http://` URL served by the local server, which renders images/PDF/AV inline.
 *
 * No server change is required: `GET /api/files/stream` already serves these
 * paths. `isAllowedProjectRoot` (server/apiRouter.ts:1855) accepts any absolute
 * directory with >= 2 path segments that is not an *exact* member of its
 * blocked-roots list, and `/tmp/claude-queue-images` satisfies both. This module
 * therefore adds **zero** new server attack surface — the reachable byte-range
 * of the filesystem is identical before and after.
 *
 * IMPORTANT — this decision must stay PURE and SYNCHRONOUS. Any `await` between
 * the user's click and `window.open()` consumes the transient user-activation
 * window, so the popup is silently blocked in plain-browser mode while still
 * passing in Electron (which has no popup blocker). Never make this async and
 * never give it a server round-trip.
 */

/**
 * Extensions handed to the browser. This is a deliberate SUBSET of the server's
 * `STREAMABLE_EXTENSIONS` (server/apiRouter.ts:1830 — the source of truth; keep
 * in sync). Two categories are intentionally excluded:
 *
 * - `.svg` — the server streams it as `image/svg+xml`. Opening one as a
 *   *top-level document* would place attacker-authored markup in the
 *   dashboard's own origin, where the auth cookie lives, and SVG can execute
 *   script. The in-app viewer renders it inside an `<img>`, which cannot.
 * - `.doc/.docx/.xls/.xlsx` — browsers download rather than render these, so
 *   the existing "Open with default app" chooser action (→ Word/Excel) is
 *   strictly better. These keep today's popover.
 */
export const BROWSER_OPENABLE_EXTENSIONS: ReadonlySet<string> = new Set([
  // Documents the browser renders inline
  '.pdf',
  // Images (note: .svg deliberately absent — see above)
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.bmp', '.ico', '.avif',
  // Video
  '.mp4', '.webm', '.ogg', '.mov',
  // Audio
  '.mp3', '.wav', '.flac', '.aac', '.m4a',
]);

/**
 * Roots the server refuses outright (exact string match), mirrored from
 * `isAllowedProjectRoot` at server/apiRouter.ts:1864. Requesting one of these
 * as `root` yields a 400, so we fall back to the popover instead of opening a
 * tab that renders a JSON error.
 */
export const BLOCKED_ROOTS: readonly string[] = [
  '/', '/etc', '/root', '/tmp', '/var', '/bin', '/sbin', '/usr', '/dev', '/proc', '/sys',
];

/**
 * Whether the server requires a password. Set once from the `/api/auth/status`
 * probe in `useAuth`. Server config is frozen at load (server/serverConfig.ts),
 * so this never goes stale mid-process.
 *
 * When auth is on we must NOT divert: an externally-opened browser has a
 * different cookie jar than the Electron renderer, so the request 401s and the
 * user gets a tab full of JSON. Falling back to the popover is non-regressive.
 * Appending `?token=` would work but writes a full-privilege credential into the
 * OS browser's address bar, history database, and browser sync — never do that.
 */
let passwordAuthEnabled = false;

export function setPasswordAuthEnabled(enabled: boolean): void {
  passwordAuthEnabled = enabled;
}

export function isPasswordAuthEnabled(): boolean {
  return passwordAuthEnabled;
}

/**
 * Build the `http://` URL a qualifying file should open at, or `null` if the
 * click should fall through to the FileOpenChooser popover as before.
 *
 * Takes no `projectPath`: the terminal link provider can fire with an empty
 * project path (useTerminal.ts passes `pp || ''`), and qualification depends
 * only on the path itself, so both entry points behave identically.
 */
export function resolveHttpOpenUrl(filePath: string): string | null {
  if (passwordAuthEnabled) return null;
  if (typeof window === 'undefined') return null;
  // Only absolute paths — a relative path is project-scoped and the in-app
  // viewer handles it correctly today.
  if (!filePath.startsWith('/')) return null;
  // Reject traversal outright rather than relying on the server to normalize.
  if (filePath.split('/').some((seg) => seg === '..')) return null;

  const lastSlash = filePath.lastIndexOf('/');
  const dir = filePath.slice(0, lastSlash);
  const base = filePath.slice(lastSlash + 1);
  if (!base || !dir) return null;

  // Require a real extension; `dotIdx === 0` means a dotfile like `.env`, which
  // has no extension and must never be streamed.
  const dotIdx = base.lastIndexOf('.');
  if (dotIdx <= 0) return null;
  if (!BROWSER_OPENABLE_EXTENSIONS.has(base.slice(dotIdx).toLowerCase())) return null;

  // Mirror the server's root guard so we never open a tab that renders a 400.
  if (dir.split('/').filter(Boolean).length < 2) return null;
  if (BLOCKED_ROOTS.includes(dir)) return null;

  // Absolute URL is required: a relative target may be resolved by Chromium
  // before Electron's setWindowOpenHandler sees it. `window.location.origin` is
  // a real http origin in Electron (dev and prod) and in browser mode alike.
  const root = encodeURIComponent(dir);
  const path = encodeURIComponent(`/${base}`);
  return `${window.location.origin}/api/files/stream?root=${root}&path=${path}`;
}
