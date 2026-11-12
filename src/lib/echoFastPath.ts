/**
 * Echo fast path: write a keystroke's echo to xterm at once instead of waiting
 * for the next animation frame.
 *
 * Terminal output is batched into one write per frame. xterm then parses on a
 * timer and paints on ITS next frame, so a typed character showed up a whole
 * frame late. Right after a key, a small chunk is almost always that key's echo:
 * writing it straight away lets xterm paint it on the coming frame.
 *
 * Each key grants a couple of fast writes inside a short window. Anything else
 * (bulk output, a long redraw, a hidden window) keeps the per-frame batch, so a
 * stream of output never turns into one parse per chunk.
 */

/** How long after a key a chunk still counts as its echo. */
export const ECHO_WINDOW_MS = 250;
/** Fast writes one key may use (the CLI can echo a key in two chunks). */
export const ECHO_CREDITS = 2;
/** Largest chunk (base64 length, ~768 bytes) that counts as an echo. */
export const ECHO_MAX_BASE64 = 1024;

export interface EchoCredit {
  readonly until: number;
  readonly left: number;
}

export function grantEchoCredit(now: number): EchoCredit {
  return { until: now + ECHO_WINDOW_MS, left: ECHO_CREDITS };
}

export interface EchoDecision {
  readonly fast: boolean;
  readonly credit: EchoCredit | null;
}

export function takeEchoCredit(
  credit: EchoCredit | null,
  now: number,
  base64Length: number,
  hidden: boolean,
): EchoDecision {
  if (!credit || now > credit.until) return { fast: false, credit: null };
  if (hidden || base64Length > ECHO_MAX_BASE64) return { fast: false, credit };
  const left = credit.left - 1;
  return { fast: true, credit: left > 0 ? { until: credit.until, left } : null };
}
