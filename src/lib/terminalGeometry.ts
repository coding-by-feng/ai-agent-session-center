/**
 * terminalGeometry — how wide a terminal renders, and who may resize the PTY.
 *
 * Kept import-free and pure so it can be unit-tested without xterm, a DOM, or a
 * WebSocket. `useTerminal` owns the side effects; this module owns the rules.
 *
 * ## The problem
 *
 * A PTY spawns at 120 columns. A phone in portrait measures ~49. Those cannot
 * both be satisfied, and the two ways of reconciling them fail differently:
 *
 * - **Resize the PTY to 49** — catastrophic and permanent. Claude Code wraps
 *   its own output to `process.stdout.columns` and emits real newlines; xterm
 *   can re-flow only the lines *it* wrapped, never newlines that arrived from
 *   the PTY. One resize hard-wraps all subsequent scrollback at 49 columns on
 *   EVERY device, and it never heals — not when the phone disconnects, not
 *   when the Mac's window is widened.
 * - **Soft-wrap 120 into 49 locally** — cosmetically bad but harmless and
 *   reversible: every full-width line breaks 2-3 times, mid-word, and box
 *   drawing and tables lose their alignment.
 *
 * So the narrow device must never take the first option. That leaves soft-wrap
 * (`'wrap'`) or rendering at the PTY's real width and panning (`'pan'`).
 */

/** How a terminal reconciles its container width with the PTY's width. */
export type TerminalWidthMode = 'pan' | 'wrap';

/**
 * Bounds on a PTY width we're willing to render at, mirroring the server's own
 * validation of an inbound resize (`0 < cols <= 500` in `wsManager`). A value
 * outside this range means the geometry message was malformed or the PTY is in
 * a broken state; falling back to the local fit is always safe, where trusting
 * it could size the canvas to something absurd.
 */
export const MIN_PTY_COLS = 20;
export const MAX_PTY_COLS = 500;

/** True when a reported PTY width is usable as a render target. */
export function isUsablePtyCols(ptyCols: number | null | undefined): ptyCols is number {
  return typeof ptyCols === 'number' && Number.isFinite(ptyCols)
    && ptyCols >= MIN_PTY_COLS && ptyCols <= MAX_PTY_COLS;
}

/**
 * The column count xterm should render at.
 *
 * `'pan'` pins the canvas to the PTY's real width so nothing wraps — the
 * container scrolls horizontally instead — which keeps box drawing, diffs,
 * tables and code aligned. `'wrap'` renders at the fitted width and lets xterm
 * soft-wrap, which reads better for prose output and needs no panning.
 *
 * Either way the PTY is untouched: this only decides how many columns the
 * local canvas draws. When the PTY width is unknown (no geometry message yet,
 * or an implausible one) both modes fall back to the fitted width, which is
 * the behavior that existed before panning was added.
 */
export function resolveRenderCols(
  mode: TerminalWidthMode,
  fittedCols: number,
  ptyCols: number | null | undefined,
): number {
  if (mode === 'wrap') return fittedCols;
  if (!isUsablePtyCols(ptyCols)) return fittedCols;
  // Never render NARROWER than the container can show. If the PTY is somehow
  // smaller than the fitted width there is nothing to pan to, and pinning to
  // it would leave dead space to the right of the content.
  return Math.max(ptyCols, fittedCols);
}

/**
 * May this device push its own viewport size to the shared PTY?
 *
 * **No, if it is a phone — even while it holds the control baton.** The server
 * already blocks a *spectator* from resizing (`holdsControl` in `wsManager`),
 * so the remaining hazard is a phone that takes control in order to type. That
 * user wants to send a command, not to reflow a 120-column PTY down to 49 and
 * permanently mangle the Mac's scrollback as a side effect. Taking control
 * means "let me type", never "resize everything to my screen".
 *
 * The check is deliberately viewport-based rather than `window.electronAPI`:
 * a desktop *browser* has no `electronAPI` but is perfectly entitled to drive
 * the PTY, and treating it as a phone would freeze its terminal geometry.
 */
export function mayDrivePtyGeometry(isMobile: boolean): boolean {
  return !isMobile;
}

/** The mode a device should start in. Phones pan (layout survives); everything
 *  else fits its container as it always has. */
export function defaultWidthMode(isMobile: boolean): TerminalWidthMode {
  return isMobile ? 'pan' : 'wrap';
}
