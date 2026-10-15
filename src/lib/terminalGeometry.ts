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
 *
 * The phone app's Terminal segment (AASC-45) adds `'fit'`: render at the PTY's
 * real width like pan, with the FONT shrunk until those columns fit the screen
 * (a phone in landscape reads a 160-column PTY at ~9 px). Below
 * {@link FIT_MIN_FONT_PX} it pans at the reading size instead. Still only the
 * local canvas: the column count it renders is the PTY's own.
 */

/** How a terminal reconciles its container width with the PTY's width. */
export type TerminalWidthMode = 'pan' | 'wrap' | 'fit';

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
  // 'fit' renders the PTY's columns too; it shrinks the font so they fit.
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
export function mayDrivePtyGeometry(isMobile: boolean, isNativeApp = false): boolean {
  // The phone app never drives it, whatever its width: a phone in landscape
  // or a tablet is wider than the mobile breakpoint (AASC-17).
  return !isMobile && !isNativeApp;
}

/** The mode a device should start in. Phones pan (layout survives); everything
 *  else fits its container as it always has. */
export function defaultWidthMode(isMobile: boolean, isNativeApp = false): TerminalWidthMode {
  return isMobile || isNativeApp ? 'pan' : 'wrap';
}

// ---------------------------------------------------------------------------
// Fit (AASC-45): shrink the font, never the PTY
// ---------------------------------------------------------------------------

/** Below this a fitted terminal can't be read: fit pans at the reading size instead. */
export const FIT_MIN_FONT_PX = 7;

/** Fit sizes the font in quarter pixels: finer steps only blur the canvas. */
const FIT_STEP_PX = 0.25;

/**
 * The font size at which `ptyCols` columns fit `availableWidth` px, for a
 * monospace face `glyphWidthPerPx` px wide per px of font size (≈ 0.6),
 * rounded down to a quarter pixel. Never above `readableFontPx` (the size the
 * user reads at: fitting only shrinks). Null below `minFontPx`, or when an
 * input is unusable: pan instead.
 */
export function fitFontSize(
  availableWidth: number,
  ptyCols: number | null | undefined,
  glyphWidthPerPx: number,
  readableFontPx: number,
  minFontPx: number = FIT_MIN_FONT_PX,
): number | null {
  if (!isUsablePtyCols(ptyCols)) return null;
  if (!Number.isFinite(availableWidth) || availableWidth <= 0) return null;
  if (!Number.isFinite(glyphWidthPerPx) || glyphWidthPerPx <= 0) return null;
  const exact = availableWidth / (ptyCols * glyphWidthPerPx);
  const size = Math.min(readableFontPx, Math.floor(exact / FIT_STEP_PX) * FIT_STEP_PX);
  return size >= minFontPx ? size : null;
}

export interface FitDecision {
  fontSize: number;
  /** False: the PTY can't fit at a readable size (or its width is unknown), so this pans. */
  fitted: boolean;
}

/** What fit mode renders at: the fitted font, or the reading size panned. */
export function resolveFit(
  availableWidth: number,
  ptyCols: number | null | undefined,
  glyphWidthPerPx: number,
  readableFontPx: number,
): FitDecision {
  const size = fitFontSize(availableWidth, ptyCols, glyphWidthPerPx, readableFontPx);
  return size === null ? { fontSize: readableFontPx, fitted: false } : { fontSize: size, fitted: true };
}

/** The phone's text sizes (A− / A+), in px. */
export const TEXT_SIZES: readonly number[] = [8, 9, 10, 11, 12, 13, 14, 16, 18];

/** The next text size up (+1) or down (-1); a size between steps moves to the next step that way. */
export function stepTextSize(current: number, direction: 1 | -1): number {
  if (direction > 0) return TEXT_SIZES.find((s) => s > current) ?? TEXT_SIZES[TEXT_SIZES.length - 1];
  return [...TEXT_SIZES].reverse().find((s) => s < current) ?? TEXT_SIZES[0];
}
