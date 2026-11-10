/**
 * localEcho.ts — mosh-style local echo for the desktop terminal ("Instant typing", Nov 2026).
 *
 * Each printable key is drawn at once as a guess, while the key still goes to the PTY as before. The program's
 * real echo then confirms the guess or replaces it. Guesses live only here and in `LocalEchoOverlay`, never in
 * xterm's buffer, so a wrong guess can flicker but never leave wrong text behind.
 *
 * Rules, after mosh:
 * - A line starts untrusted. Its first key is guessed but hidden until its echo arrives; only then are guesses
 *   drawn. Text a program never echoes (a password) is therefore never shown. Enter starts a new untrusted line.
 * - Only printable characters are guessed. Any other key (Backspace, arrows, Esc, Tab, Ctrl-x, a paste) drops the
 *   guesses and makes the line untrusted again, because the real cursor will move. Backspace too: retyping a
 *   deleted word, the old word's echo arrives first and would "confirm" the new guesses (real Claude, 150 ms).
 * - A guess is confirmed when the real cursor has moved past its cell and the cell holds that character. A cell
 *   that already showed the letter (Claude's grey "Try …" suggestion) does not confirm it on its own. A space may
 *   stay an empty cell: Claude moves the cursor on rather than writing it.
 * - The cursor moving anywhere else, a different character, or no echo within GUESS_TIMEOUT_MS drops every guess.
 *   Only a dropped guess the user saw counts as a miss; MAX_MISSES in a row stop guessing until the next Enter.
 * - After any reset the real cursor may be behind, because keys typed before it are still on their way. So a new
 *   probe waits for a pause in typing longer than the echo time; probing at once put every later guess one cell
 *   short against real Claude over a 150 ms link.
 * - Reports the terminal sends by itself (mouse, focus, cursor position, device attributes) are not keys.
 *
 * Pure: every function returns a new state.
 */

/** What the predictor reads from the terminal. Rows are absolute buffer rows. */
export interface ScreenView {
  cursorRow: number;
  cursorCol: number;
  cols: number;
  /** The character in a cell; '' for an empty cell or the right half of a wide character. */
  cellAt: (row: number, col: number) => string;
}

export interface Guess {
  ch: string;
  /** Cells it takes: 1, or 2 for a wide (CJK) character. */
  width: number;
  row: number;
  col: number;
  /** When it was typed (ms). */
  at: number;
  /** False while the line is untrusted: kept to place later keys, never drawn. */
  shown: boolean;
}

export interface EchoState {
  trusted: boolean;
  guesses: readonly Guess[];
  /** Misses in a row. */
  misses: number;
  /** Too many misses: no guessing until the next Enter. */
  disabled: boolean;
  /** Smoothed echo time (ms), or null before the first echo. */
  srtt: number | null;
  /** When the last key was typed (ms), or null before the first. */
  lastKeyAt: number | null;
}

export const GUESS_TIMEOUT_MS = 1000;
export const MAX_MISSES = 3;
/** Above this smoothed echo time the overlay underlines its guesses, as mosh does. */
export const SLOW_ECHO_MS = 80;

export const INITIAL_ECHO: EchoState = Object.freeze({
  trusted: false,
  guesses: Object.freeze([]) as readonly Guess[],
  misses: 0,
  disabled: false,
  srtt: null,
  lastKeyAt: null,
});

// One run of reports the terminal sends on its own: SGR and X10 mouse, focus in/out, a cursor position report,
// and device attributes replies.
const TERMINAL_REPORT_RE =
  // eslint-disable-next-line no-control-regex -- matching escape sequences is the point
  /^(?:\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}|\x1b\[[IO]|\x1b\[\d+;\d+R|\x1b\[[?>][\d;]*c)+$/;

/** True for input the terminal produced by itself rather than a key the user pressed. */
export function isTerminalReport(data: string): boolean {
  return TERMINAL_REPORT_RE.test(data);
}

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x2e80, 0x303e], [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff],
  [0xa000, 0xa4cf], [0xac00, 0xd7a3], [0xf900, 0xfaff], [0xfe30, 0xfe4f], [0xff00, 0xff60], [0xffe0, 0xffe6],
];

/**
 * Cells a typed character takes, or 0 when it is not guessed: control characters, combining marks, and
 * anything outside the Basic Multilingual Plane (emoji), whose width terminals disagree on.
 */
export function charWidth(ch: string): number {
  const code = ch.codePointAt(0);
  if (code === undefined || [...ch].length !== 1) return 0;
  if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code > 0xffff) return 0;
  if (code >= 0x300 && code <= 0x36f) return 0;
  return WIDE_RANGES.some(([lo, hi]) => code >= lo && code <= hi) ? 2 : 1;
}

/** The guesses the overlay draws. */
export function shownGuesses(state: EchoState): Guess[] {
  return state.guesses.filter((guess) => guess.shown);
}

export function isSlowEcho(state: EchoState): boolean {
  return state.srtt !== null && state.srtt > SLOW_ECHO_MS;
}

/** Drop every guess and wait for an echo before drawing again; the echo timing is kept. */
export function echoReset(state: EchoState): EchoState {
  if (state.guesses.length === 0 && !state.trusted) return state;
  return { ...state, guesses: [], trusted: false };
}

function newLine(state: EchoState): EchoState {
  return { ...INITIAL_ECHO, srtt: state.srtt, lastKeyAt: state.lastKeyAt };
}

function miss(state: EchoState): EchoState {
  const misses = state.guesses.some((guess) => guess.shown) ? state.misses + 1 : state.misses;
  return { ...state, guesses: [], trusted: false, misses, disabled: misses >= MAX_MISSES };
}

/** No key for longer than the echo takes: every earlier key has echoed, so the real cursor is current. */
function typingPaused(state: EchoState, now: number): boolean {
  if (state.lastKeyAt === null || state.srtt === null) return true;
  return now - state.lastKeyAt > state.srtt * 1.5 + 20;
}

function addGuess(state: EchoState, ch: string, view: ScreenView, now: number, paused: boolean): EchoState {
  if (state.disabled) return state;
  // A new probe starts from the real cursor, which is only right once typing has paused.
  if (!state.trusted && state.guesses.length === 0 && !paused) return state;
  const width = charWidth(ch);
  const last = state.guesses[state.guesses.length - 1];
  const row = last ? last.row : view.cursorRow;
  const col = last ? last.col + last.width : view.cursorCol;
  // The program decides where a full row wraps (Claude's box is narrower than the terminal): never guess it.
  if (col + width > view.cols) return echoReset(state);
  const guess: Guess = { ch, width, row, col, at: now, shown: state.trusted };
  return { ...state, guesses: [...state.guesses, guess] };
}

/** A chunk of typed input (xterm's onData), with the screen as it is before the program has echoed it. */
export function echoInput(state: EchoState, data: string, view: ScreenView, now: number): EchoState {
  if (isTerminalReport(data)) return state;
  const paused = typingPaused(state, now);
  const typed: EchoState = { ...state, lastKeyAt: now };
  if (/[\r\n]/.test(data)) return newLine(typed);
  const chars = [...data];
  if (chars.length > 0 && chars.every((ch) => charWidth(ch) > 0)) {
    return chars.reduce((next, ch) => addGuess(next, ch, view, now, paused), typed);
  }
  return echoReset(typed);
}

/** The cell shows the guessed character; a space may be left as an empty cell. */
function echoed(cell: string, ch: string): boolean {
  return cell === ch || (ch === ' ' && cell === '');
}

/** The program wrote to the screen: confirm the guesses its echo covers, or drop them all on a miss. */
export function echoOutput(state: EchoState, view: ScreenView, now: number): EchoState {
  let next = state;
  while (next.guesses.length > 0) {
    const [guess, ...rest] = next.guesses;
    const onRow = view.cursorRow === guess.row;
    if (onRow && view.cursorCol >= guess.col + guess.width && echoed(view.cellAt(guess.row, guess.col), guess.ch)) {
      const rtt = Math.max(0, now - guess.at);
      next = {
        ...next,
        trusted: true,
        // Trusting the line makes the keys typed meanwhile visible.
        guesses: next.trusted ? rest : rest.map((g) => ({ ...g, shown: true })),
        // Only a guess the user saw clears a run of misses; re-trusting after one does not.
        misses: guess.shown ? 0 : next.misses,
        srtt: next.srtt === null ? rtt : next.srtt * 0.75 + rtt * 0.25,
      };
      continue;
    }
    // Still waiting: the cursor sits where this guess goes.
    if (onRow && view.cursorCol === guess.col) break;
    return miss(next);
  }
  return next;
}

/** Timer tick: a guess with no echo for GUESS_TIMEOUT_MS is a miss. */
export function echoExpire(state: EchoState, now: number): EchoState {
  return state.guesses.some((guess) => now - guess.at > GUESS_TIMEOUT_MS) ? miss(state) : state;
}
