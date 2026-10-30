/**
 * @module codexReadyWatch
 * When a just-launched Codex card can leave `connecting` early.
 *
 * Codex sends its first hook only at its first prompt, so a new Codex card used to sit in `connecting` for the
 * whole 30 s connecting timeout even though its `›` input was on screen within a second or two, and a phone
 * could not send it anything (the composer and the prompt route both refuse while `connecting`).
 *
 * This watches the terminal's live output from launch (never the replay ring: a restore prefills it with the old
 * Codex screen, and the shell echoes the launch line into it) and calls `onReady` once that output shows Codex's
 * input row, has been quiet for a moment, and the same test the timeout uses (`atInput`: codex holds the PTY
 * foreground in a folder its trust record lists `trusted`) holds. Anything else keeps the 30 s path.
 *
 * Import-free on purpose: sessionStore wires the terminal in, the tests drive it with fakes.
 */

/** Codex's input prompt glyph (`› Ask Codex to do anything`). Its menus mark the chosen option with it too. */
export const CODEX_INPUT_GLYPH = '›';
export const CODEX_READY_POLL_MS = 250;
/** How long the screen must stay still before the card counts as ready. */
export const CODEX_READY_QUIET_MS = 1_500;
/** Enough of a full-screen Codex redraw (~6 KB at launch) to still hold its input row. */
export const CODEX_READY_KEEP_CHARS = 8_192;

const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-_]/g;
/** A menu row: `› 1. Update now`. */
const MENU_OPTION_RE = /^\s*\d+\./;

/**
 * Does this output end on Codex's input row? The last `›` must not mark a numbered menu option (an update,
 * sign-in or model notice), and nothing after it may ask to press Enter.
 */
export function showsCodexInput(output: string): boolean {
  const text = output.replace(ANSI_RE, '');
  const at = text.lastIndexOf(CODEX_INPUT_GLYPH);
  if (at < 0) return false;
  const after = text.slice(at + CODEX_INPUT_GLYPH.length);
  return !MENU_OPTION_RE.test(after) && !/press enter/i.test(after);
}

export interface CodexReadyWatchDeps {
  /** Is the card still `connecting`? A hook (or the timeout) ending it first ends the watch. */
  stillConnecting: () => boolean;
  /** Codex is the PTY's foreground program in a folder it trusts (sessionStore's `codexAtItsInput`). */
  atInput: () => boolean;
  /** Listen to the terminal's output from now on; returns the unsubscribe. */
  tapOutput: (listener: (chunk: string) => void) => () => void;
  onReady: () => void;
  now?: () => number;
  pollMs?: number;
  quietMs?: number;
}

/** Start watching. Returns a cancel function; the watch also ends by itself once it fires or the card moves on. */
export function watchCodexReady(deps: CodexReadyWatchDeps): () => void {
  const now = deps.now ?? Date.now;
  const quietMs = deps.quietMs ?? CODEX_READY_QUIET_MS;
  let seen = '';
  let lastOutputAt: number | undefined;
  let stopped = false;
  const untap = deps.tapOutput((chunk) => {
    seen = (seen + chunk).slice(-CODEX_READY_KEEP_CHARS);
    lastOutputAt = now();
  });
  const timer = setInterval(() => {
    if (stopped) return;
    if (!deps.stillConnecting()) return stop();
    if (lastOutputAt === undefined || now() - lastOutputAt < quietMs) return;
    // The trust record is read last, only once the screen has settled on an input row.
    if (!showsCodexInput(seen) || !deps.atInput()) return;
    stop();
    deps.onReady();
  }, deps.pollMs ?? CODEX_READY_POLL_MS);
  // Never keeps a test file or a shutting-down server alive.
  timer.unref?.();
  function stop(): void {
    stopped = true;
    clearInterval(timer);
    untap();
  }
  return stop;
}
