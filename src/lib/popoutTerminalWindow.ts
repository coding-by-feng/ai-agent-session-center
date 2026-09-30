/**
 * Browser fallback for popping a terminal out into its own window when
 * `window.electronAPI.openTerminalWindow` isn't available (a plain browser
 * tab has no IPC). Opens the SAME `?popout=terminal` route Electron's
 * `registerPopoutHandler` loads — `PopoutTerminalView` needs no Electron API,
 * so no second renderer is needed. A `popup,width=…,height=…` features
 * string is what forces the browser to open a real detached window
 * (draggable to another monitor) instead of a new tab; a deterministic
 * window `name` (derived from `terminalId`) means a second call focuses the
 * existing popup instead of opening a duplicate, mirroring Electron's own
 * de-dupe-by-id behavior in `registerPopoutHandler`.
 *
 * Shared by FloatingTerminalPanel and DetailPanel's two handlePopOut
 * implementations (main TERMINAL + COMMANDS ops terminal) so the three never
 * drift on sizing/centering.
 */
/** Shared centered/sized `window.open` features string — both the real popup
 *  and the preopened placeholder (below) must use the SAME geometry, or the
 *  placeholder-to-real-window handoff would visibly jump/resize. */
function popupWindowFeatures(): string {
  const w = Math.min(820, window.screen.availWidth);
  const h = Math.min(560, window.screen.availHeight);
  const left = Math.round((window.screen.availWidth - w) / 2);
  const top = Math.round((window.screen.availHeight - h) / 2);
  return `popup,noopener=no,width=${w},height=${h},left=${left},top=${top}`;
}

export function openTerminalPopupFallback(opts: {
  terminalId: string;
  originSessionId?: string;
  label?: string;
}): Window | null {
  const { terminalId, originSessionId, label } = opts;
  const qs = new URLSearchParams({ popout: 'terminal', terminalId });
  if (originSessionId) qs.set('originSessionId', originSessionId);
  if (label) qs.set('label', label);
  const name = `aasc-terminal-${terminalId.replace(/[^a-zA-Z0-9]/g, '_')}`;
  return window.open(`/?${qs.toString()}`, name, popupWindowFeatures());
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * A tiny, self-contained loading page for the window `preopenTerminalPopup`
 * opens. Deliberately a `data:` URL, not `about:blank` or a real app route —
 * a `data:` URL renders instantly with no network round trip, so there is
 * never a flash of true blank-white while the real spawn is still in flight,
 * and unlike a real route it can't itself fail to load.
 */
function loadingPlaceholderUrl(): string {
  const title = escapeHtml('Floating terminal');
  const html = `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>`
    + `<style>html,body{height:100%;margin:0;background:#ece9d8;`
    + `font-family:'JetBrains Mono','Fira Code',monospace;color:#666;`
    + `display:flex;align-items:center;justify-content:center}`
    + `.msg{font-size:13px;letter-spacing:.02em}</style></head>`
    + `<body><div class="msg">Starting session…</div></body></html>`;
  return `data:text/html,${encodeURIComponent(html)}`;
}

/**
 * Opens a placeholder popup window SYNCHRONOUSLY — call this as the very
 * first thing inside a click handler's call chain, before any `await`.
 *
 * **Why this exists.** `SelectionPopup.spawn()` used to `await fetch(...)` to
 * fork a session server-side, and only call `window.open()` afterward, once
 * it knew the resulting `terminalId`. By the time that resolved, the click's
 * transient activation — the short window in which Chrome still trusts a
 * `window.open()` as user-initiated — had expired: forking a session is a
 * real network round trip, not instant, so the eventual popup got blocked
 * close to every time, not as a rare edge case. Opening a window HERE, while
 * the gesture is still fresh, then navigating that SAME window once the real
 * URL is known (`openFloatWindow`'s `preopened` param) is the standard
 * workaround — there is still exactly one `window.open()` call in the whole
 * flow, and it's the one still inside the gesture.
 *
 * Returns `null` exactly when the synchronous open itself was blocked (e.g. a
 * site-level "always block popups" setting) — callers must still fall back
 * to docking in that case, same as before this existed.
 *
 * Harmless to call under Electron too: `attachWindowOpenPolicy` intercepts
 * `window.open`, and a `data:` URL matches neither "our own origin" nor
 * "http/https external" — the same "everything else — dropped" bucket as
 * `ms-msdt:`/`file:`/`javascript:` — so this either returns `null` or a
 * non-functional handle, and `openFloatWindow` closes/ignores it either way
 * on the Electron branches, which never use it.
 */
export function preopenTerminalPopup(): Window | null {
  const name = `aasc-terminal-pending-${Math.random().toString(36).slice(2, 10)}`;
  return window.open(loadingPlaceholderUrl(), name, popupWindowFeatures());
}

/** Where a freshly-spawned floating session should appear. */
export type FloatWindowOutcome =
  /** A real OS window opened (native BrowserWindow, or a detached browser popup). */
  | { placed: 'window' }
  /** Caller must fall back to the in-app docked panel, for the stated reason. */
  | { placed: 'docked'; reason: 'stale-preload' | 'ipc-failed' | 'popup-blocked' };

/**
 * Open a floating session directly in its own OS window, skipping the in-app
 * `FloatingTerminalPanel` entirely.
 *
 * This is the one branch point shared by `SelectionPopup` (spawn → straight to
 * a window) and `FloatingTerminalPanel.handlePopOut` (detach an already-docked
 * panel), so the platform rules can never drift between them.
 *
 * **The caller MUST honor a `docked` result by rendering the in-app panel.**
 * The session is created server-side *before* any window exists, so a dropped
 * window leaves a live forked CLI session holding a WebSocket subscription with
 * no UI attached to it — invisible and unclosable. Falling back to the docked
 * panel is what prevents that orphan, and is the reason this returns an outcome
 * instead of a bare boolean.
 *
 * The three branches, in order:
 *
 *  1. **Electron with a working preload** → a real `BrowserWindow` via IPC.
 *  2. **Electron with a stale preload** → dock. Deliberately NOT `window.open`:
 *     per `attachWindowOpenPolicy`, an unrecognized `window.open` of our own
 *     origin escapes to the user's *system browser* on `http://localhost:<port>`.
 *     A stale preload is a build problem, and launching Chrome is not a graceful
 *     degradation of it — same rule as `DetailTabs.openProjectWindow`.
 *  3. **Plain browser** → navigates an already-open `preopened` window when one
 *     was passed (see `preopenTerminalPopup`), else falls back to a fresh
 *     `window.open` popup exactly as before. A blocked popup — no `preopened`
 *     given, or a fresh attempt also blocked — must dock rather than silently
 *     vanish.
 */
export async function openFloatWindow(opts: {
  terminalId: string;
  originSessionId?: string;
  label?: string;
  /**
   * A window already opened via `preopenTerminalPopup()`, synchronously,
   * before the caller's `await` that resolved `terminalId`. Only the plain-
   * browser branch (3) consumes it — the other branches close it, since the
   * real window there comes from somewhere else (Electron IPC) or doesn't
   * exist at all (stale preload), and leaving the loading placeholder open
   * would strand it as an orphaned tab forever.
   */
  preopened?: Window | null;
}): Promise<FloatWindowOutcome> {
  const api = typeof window !== 'undefined' ? window.electronAPI : undefined;

  if (api?.openTerminalWindow) {
    try { opts.preopened?.close(); } catch { /* already closed by the user — fine */ }
    try {
      const r = await api.openTerminalWindow(opts);
      return r?.ok ? { placed: 'window' } : { placed: 'docked', reason: 'ipc-failed' };
    } catch {
      return { placed: 'docked', reason: 'ipc-failed' };
    }
  }

  // Electron present but the API is missing → stale preload. Dock; never
  // window.open (see branch 2 above).
  if (api) {
    try { opts.preopened?.close(); } catch { /* already closed by the user — fine */ }
    return { placed: 'docked', reason: 'stale-preload' };
  }

  // Plain browser. Prefer navigating the already-open preopened window: the
  // popup-blocking gate applies to window.open() calls, not to setting
  // .location on a window reference the caller already holds, so this
  // navigation is NOT itself at risk of being blocked.
  if (opts.preopened && !opts.preopened.closed) {
    const qs = new URLSearchParams({ popout: 'terminal', terminalId: opts.terminalId });
    if (opts.originSessionId) qs.set('originSessionId', opts.originSessionId);
    if (opts.label) qs.set('label', opts.label);
    try {
      opts.preopened.location.href = `/?${qs.toString()}`;
      return { placed: 'window' };
    } catch {
      // Extremely unlikely for a same-origin relative navigation, but if it
      // does happen, close the placeholder before falling through to the
      // fresh-open path below — otherwise it strands on screen, blank,
      // while the caller separately acts on whatever outcome that fresh
      // attempt returns.
      try { opts.preopened.close(); } catch { /* already closed — fine */ }
    }
  }

  // No usable preopened window — none was passed, the user closed the loading
  // placeholder before the spawn finished, or the navigation above failed.
  // Same path as before preopening existed; a fresh attempt here can still be
  // blocked (this call is no longer inside the original click's activation
  // window either), and that must still dock rather than silently vanish.
  const win = openTerminalPopupFallback(opts);
  return win ? { placed: 'window' } : { placed: 'docked', reason: 'popup-blocked' };
}
