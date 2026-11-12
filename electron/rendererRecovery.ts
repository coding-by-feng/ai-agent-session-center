/**
 * When a window's renderer dies, reload it instead of leaving a blank window.
 *
 * Nov 2 2026: opening the New Terminal Session's Working Directory list killed the renderer
 * (a fatal Chromium 132 accessibility check, ax_object.cc:3471, with a macOS accessibility client
 * on) and the window stayed blank until the app was restarted. Combobox no longer trips that
 * check, but any renderer crash should cost a reload, not the window.
 *
 * Pure: the caller keeps the history of reload times per window and does the reload.
 */

/** Reasons that mean the page died on its own. `clean-exit` and `killed` (app quit, OS kill) don't. */
const RELOAD_REASONS = new Set(['crashed', 'oom', 'abnormal-exit', 'launch-failed', 'integrity-failure']);

/** At most this many reloads per window within RELOAD_WINDOW_MS; past that, a crash loop is left alone. */
export const MAX_RELOADS = 3;
export const RELOAD_WINDOW_MS = 60_000;

export interface ReloadDecision {
  reload: boolean;
  /** The reload times to keep for this window (recent ones, plus `now` when reloading). */
  history: number[];
}

export function decideRendererReload(reason: string, now: number, history: readonly number[]): ReloadDecision {
  const recent = history.filter((t) => now - t < RELOAD_WINDOW_MS);
  if (!RELOAD_REASONS.has(reason) || recent.length >= MAX_RELOADS) return { reload: false, history: recent };
  return { reload: true, history: [...recent, now] };
}
