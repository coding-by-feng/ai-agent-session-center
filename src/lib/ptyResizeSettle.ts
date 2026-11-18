/**
 * The PTY hears a window resize only once the size has settled (Nov 18 2026).
 *
 * Dashboard PTYs run Claude inline (no alternate screen, so selection and AI popups
 * work). Each resize the PTY hears (SIGWINCH) makes Claude redraw its live region by
 * moving the cursor up by the OLD height, which is wrong at the new width, so the old
 * frame stays in scrollback ("✻ Embellishing…" printed three times, rules broken).
 * A slow window drag used to send one resize per 200 ms pause; now xterm re-fits
 * locally at once and the PTY gets the final size after `PTY_RESIZE_SETTLE_MS` of quiet.
 *
 *   drag ──pause──pause──release ──(500 ms quiet)──▶ one resize at the final size
 */
export const PTY_RESIZE_SETTLE_MS = 500;

export interface PtyResizeSettler {
  /** The size xterm now has; sent once no other size follows for the settle time. */
  request(cols: number, rows: number): void;
  /** Drop a pending size (the terminal was switched, moved or disposed). */
  cancel(): void;
}

export function createPtyResizeSettler(
  send: (cols: number, rows: number) => void,
  settleMs: number = PTY_RESIZE_SETTLE_MS,
): PtyResizeSettler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const cancel = (): void => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return {
    request(cols, rows) {
      cancel();
      timer = setTimeout(() => {
        timer = null;
        send(cols, rows);
      }, settleMs);
    },
    cancel,
  };
}
