/**
 * @module promptSuggestionCapture
 * Reads Claude Code's suggested next prompt off a terminal's screen after a turn, so the phone
 * Composer and the desktop queue box can offer it (Oct 26 2026).
 *
 * **Why the screen.** Claude generates the suggestion in a forked query with `skipTranscript: true`
 * and no hook carries it; the documented `prompt_suggestion` message exists only in `--print
 * --output-format=stream-json` mode. In the interactive TUI it is drawn as dim text (SGR 2) in the
 * input box, about a second after the turn ends:
 *
 *   ────────────────────────────────────────
 *   ❯ ls -la                                  ← dim = the suggestion; typed text is not dim
 *   ────────────────────────────────────────
 *
 * **When Claude draws one.** Only after two or more assistant turns, never in plan mode or while a
 * permission is pending, and not while the plan's usage is at its warning level (unless
 * `CLAUDE_CODE_ENABLE_PROMPT_SUGGESTION=true`); it can be turned off in /config. So most turns of a
 * session have one and some do not, and an absent suggestion is normal.
 *
 * **Cheap.** A `Stop` arms a watch on the session's terminal for `WATCH_MS`. While armed, a chunk is
 * only regex-tested for a dim SGR; a dim chunk schedules one replay of the output ring
 * (headlessScreen.ts) after the output settles. The first suggestion found ends the watch; so does
 * input from the user (`disarmSuggestion`).
 */
import { renderScreenCells, type ScreenCell, type TerminalScreen } from './headlessScreen.js';
import type { PromptSuggestion } from '../src/types/session.js';

/** How long after a `Stop` a suggestion may still appear (it usually takes 1–3 s). */
const WATCH_MS = 10_000;
/** Quiet output this long after a dim chunk means the box has been drawn. */
const SETTLE_MS = 600;
/** A dim chunk this recent when the watch arms was probably the suggestion itself. */
const RECENT_DIM_MS = 5_000;
/** Characters of a stored suggestion. */
export const SUGGESTION_CAP = 500;
/** Rows a wrapped suggestion may take in the box. */
const MAX_BOX_ROWS = 6;

/** SGR with a 2 (dim) parameter: `\x1b[2m`, `\x1b[2;38;5;241m`, `\x1b[0;2m`. */
const DIM_SGR_RE = /\x1b\[(?:[\d;]*;)?2(?:;[\d;]*)?m/;
/** Mouse reports (SGR and legacy X10): a click or wheel in the terminal is not typing. */
const MOUSE_REPORT_RE = /\x1b\[<\d+;\d+;\d+[Mm]|\x1b\[M[\s\S]{3}/g;
/** The input box's top and bottom rules. */
const RULE_RE = /^\s*─{10,}\s*$/;
/** The prompt glyph that starts the box's first row. */
const PROMPT_RE = /^\s*[❯>]\s?/u;
/** Claude's own dim hints in an empty box, which are not suggestions. */
const HINT_RE = /^(Press up to |Message @|Try ")/;

export interface SuggestionCaptureDeps {
  /** The terminal's output ring and size, or null once it is gone. */
  snapshot(terminalId: string): TerminalScreen | null;
  /** A suggestion appeared in this terminal's input box. */
  onSuggestion(terminalId: string, suggestion: PromptSuggestion): void;
}

interface WatchState {
  until: number;
  timer: ReturnType<typeof setTimeout> | null;
}

const watches = new Map<string, WatchState>();
const lastDimAt = new Map<string, number>();

const textOf = (cells: readonly ScreenCell[]): string => cells.map((c) => c.ch).join('');

/**
 * The suggestion in the input box on a rendered screen, or null when the box is empty, holds text
 * the user typed (any non-dim character), shows one of Claude's hints, or is not on screen. Pure.
 */
export function parseSuggestionScreen(rows: readonly ScreenCell[][]): string | null {
  for (let i = rows.length - 1; i > 0; i--) {
    const text = textOf(rows[i]);
    if (!PROMPT_RE.test(text) || !RULE_RE.test(textOf(rows[i - 1]))) continue;
    const glyph = PROMPT_RE.exec(text)?.[0].length ?? 0;
    const box: ScreenCell[] = [...rows[i].slice(glyph)];
    for (let j = i + 1; j < rows.length && j <= i + MAX_BOX_ROWS; j++) {
      if (RULE_RE.test(textOf(rows[j]))) break;
      box.push({ ch: ' ', dim: true }, ...rows[j]);
    }
    if (box.some((c) => c.ch.trim() !== '' && !c.dim)) return null;
    const suggestion = textOf(box).replace(/\s+/g, ' ').trim();
    if (!suggestion || HINT_RE.test(suggestion)) return null;
    return suggestion.slice(0, SUGGESTION_CAP);
  }
  return null;
}

/** Is this terminal input the user typing (keys, paste), rather than mouse reports? */
export function isTypingInput(data: string): boolean {
  return data.replace(MOUSE_REPORT_RE, '').length > 0;
}

async function capture(terminalId: string, deps: SuggestionCaptureDeps): Promise<void> {
  const watch = watches.get(terminalId);
  if (!watch) return;
  watch.timer = null;
  const screen = deps.snapshot(terminalId);
  if (!screen) return;
  const text = parseSuggestionScreen(await renderScreenCells(screen));
  // Disarmed (the user typed, or a new turn began) while the screen was replaying.
  if (watches.get(terminalId) !== watch || !text) return;
  watches.delete(terminalId);
  deps.onSuggestion(terminalId, { text, at: Date.now() });
}

function schedule(terminalId: string, watch: WatchState, deps: SuggestionCaptureDeps): void {
  if (watch.timer) clearTimeout(watch.timer);
  watch.timer = setTimeout(() => {
    void capture(terminalId, deps).catch(() => { /* best-effort: never break streaming */ });
  }, SETTLE_MS);
}

/** A turn ended in this terminal (`Stop`): watch its next few seconds of output for a suggestion. */
export function armSuggestionWatch(terminalId: string, deps: SuggestionCaptureDeps, now = Date.now()): void {
  disarmSuggestion(terminalId);
  const watch: WatchState = { until: now + WATCH_MS, timer: null };
  watches.set(terminalId, watch);
  const dimAt = lastDimAt.get(terminalId);
  if (dimAt !== undefined && now - dimAt <= RECENT_DIM_MS) schedule(terminalId, watch, deps);
}

/** Feed one PTY chunk. Only a dim chunk inside an armed watch costs a (settled) screen replay. */
export function noteSuggestionChunk(terminalId: string, chunk: string, deps: SuggestionCaptureDeps, now = Date.now()): void {
  if (!chunk || !DIM_SGR_RE.test(chunk)) return;
  lastDimAt.set(terminalId, now);
  const watch = watches.get(terminalId);
  if (!watch) return;
  if (now > watch.until) {
    disarmSuggestion(terminalId);
    return;
  }
  schedule(terminalId, watch, deps);
}

/** Stop watching this terminal (the user typed, a new turn began, or it closed). */
export function disarmSuggestion(terminalId: string): void {
  const watch = watches.get(terminalId);
  if (watch?.timer) clearTimeout(watch.timer);
  watches.delete(terminalId);
}

/** Forget a terminal entirely. Call on terminal close. */
export function clearSuggestionState(terminalId: string): void {
  disarmSuggestion(terminalId);
  lastDimAt.delete(terminalId);
}

/** Test-only: wipe all watch state between cases. */
export function resetSuggestionStates(): void {
  for (const id of [...watches.keys()]) disarmSuggestion(id);
  lastDimAt.clear();
}
