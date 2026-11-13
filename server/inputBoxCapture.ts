/**
 * @module inputBoxCapture
 * Takes the text out of Claude Code's input box, for the queue's "take the text from Claude's input
 * box" button (Nov 13 2026). The point is dictation: the user holds Space in the terminal, Claude's
 * own voice feature types the transcript into its ❯ box, and one click moves it into the queue
 * compose box, where the user checks it and clicks ADD. Nothing is added or sent here.
 *
 *   ──────────────────────────────────────
 *   ❯ fix the queue so a paused item can     ← typed / dictated text (not dim): taken
 *     be edited without losing its schedule
 *   ──────────────────────────────────────
 *     ⏸ manual mode on                        ← footer: a few rows, never a ❯ row
 *
 * **Read off the screen.** No hook or API carries the unsent input, so the box is read from the
 * terminal's output ring (headlessScreen.ts), like the next-prompt suggestion. Dim cells are left
 * out: Claude draws its placeholder hint and its suggested next prompt dim in the same box.
 *
 * **Only the live box, at the bottom.** The box must be the lowest rule-❯-rule group with nothing
 * but a short footer under it. A permission or question dialog replaces the box (its options are
 * ❯ rows); searching further up would find a leftover copy of an old box, take an already-sent
 * prompt, and send Ctrl+U into the dialog, wiping what the user typed there.
 *
 * **Joining rows.** Ink draws every row itself, so a wrap and a Shift+Enter line break look alike,
 * and rows join with one space. Two exceptions join with none: CJK on either side, and a token
 * broken mid-way. Claude's wrap moves a word that fits to the next row and breaks only a token
 * longer than a whole row, so a break is mid-token when the row is full (it reaches the box's right
 * edge, RIGHT_MARGIN cells in) and the two fragments together are wider than a row. A word that
 * just fills its row is full too, but it and the next word fit a row, so they keep their space.
 *
 * **Cleared with Ctrl+U** (pinned with a tmux probe on Claude Code 2.1.323): one press deletes to the
 * start of the visual row, and on an empty row it deletes the line break, so 2×rows presses clear any
 * box; extra presses on an empty box do nothing, and Claude offers Ctrl+Y to paste the text back.
 * Not Ctrl+C (it interrupts a working turn, and a second press exits) and not Esc Esc (it opens the
 * rewind menu on an empty box).
 *
 * **Never inside a send.** A queue send writes its text, waits (1–5 s), then writes Enter. A take in
 * that gap would move the queued prompt here and leave the Enter to submit an empty box, while the
 * queue records it as sent. `noteTerminalWrite` (fed by POST /terminals/:id/write) remembers a text
 * write with no Enter after it, and the take refuses until the Enter comes or SEND_PENDING_MS pass.
 */
import type { ScreenCell } from './headlessScreen.js';

/** The input box's top and bottom rules. */
const RULE_RE = /^\s*─{10,}\s*$/;
/** The prompt glyph that starts the box's first row. */
const PROMPT_RE = /^\s*[❯>]\s?/u;
/** Claude's stand-ins for a paste or an image: the real content is not on screen. */
const ATTACHMENT_RE = /\[(?:Pasted text|Image) #\d+[^\]]*\]/;
/** CJK scripts, written without spaces between words. */
const CJK_RE = /[぀-ヿ㐀-䶿一-鿿가-힯＀-￯]/u;
/** Blank cells Claude leaves right of the box's text (Claude Code 2.1.323, 100 columns). */
const RIGHT_MARGIN = 2;
/** A long dictation fills many rows; a box taller than this is not Claude's input box. */
const MAX_BOX_ROWS = 60;
/** Rows Claude draws under the box (mode line, hints, notices). A dialog is taller. */
const MAX_FOOTER_ROWS = 6;
/** Claude's "delete to start of line". */
const CTRL_U = '\x15';
/** Time for Claude to redraw the box after the Ctrl+U burst. */
const CLEAR_SETTLE_MS = 400;
/** The longest a send waits between its text and its Enter (10 images ≈ 5.2 s), with margin. */
export const SEND_PENDING_MS = 8_000;

export interface InputBoxReading {
  /** The typed text; '' when the box is empty. */
  text: string;
  /** How many screen rows the box's text spans. */
  rows: number;
}

const textOf = (cells: readonly ScreenCell[]): string => cells.map((c) => c.ch).join('');
/** The row's typed characters: dim cells (hint, suggestion) become blanks. */
const typedOf = (cells: readonly ScreenCell[]): string => cells.map((c) => (c.dim ? ' ' : c.ch)).join('');
const isBlank = (cells: readonly ScreenCell[]): boolean => textOf(cells).trim() === '';

interface BoxLine {
  text: string;
  /** The text reaches the box's right edge. */
  full: boolean;
  /** How many cells of text a row of the box holds. */
  width: number;
}

const lastWord = (t: string): string => t.slice(t.lastIndexOf(' ') + 1);
const firstWord = (t: string): string => t.split(' ', 1)[0];

/** The rows' text: one space between rows, none after a mid-token break or beside CJK. */
function joinRows(lines: readonly BoxLine[]): string {
  return lines.reduce(
    (acc, line) => {
      const text = line.text.trim();
      if (!text) return acc;
      if (!acc.prev) return { out: text, prev: { ...line, text } };
      const midToken = acc.prev.full && lastWord(acc.prev.text).length + firstWord(text).length > acc.prev.width;
      const cjk = CJK_RE.test(acc.out.slice(-1)) || CJK_RE.test(text[0]);
      return { out: acc.out + (midToken || cjk ? '' : ' ') + text, prev: { ...line, text } };
    },
    { out: '', prev: null as BoxLine | null },
  ).out;
}

/**
 * The text in the live input box at the bottom of a rendered screen, or null when the bottom of the
 * screen is not Claude's input box (a dialog replaced it, the box is taller than the screen, or
 * another program is showing). Pure.
 */
export function parseInputBox(rows: readonly ScreenCell[][]): InputBoxReading | null {
  let close = rows.length - 1;
  while (close >= 0 && !RULE_RE.test(textOf(rows[close]))) close--;
  if (close < 2) return null;
  const footer = rows.slice(close + 1).filter((r) => !isBlank(r));
  if (footer.length > MAX_FOOTER_ROWS || footer.some((r) => PROMPT_RE.test(textOf(r)))) return null;

  let top = close - 1;
  while (top >= 0 && close - top <= MAX_BOX_ROWS + 1 && !RULE_RE.test(textOf(rows[top]))) top--;
  if (top < 0 || top === close - 1 || !RULE_RE.test(textOf(rows[top]))) return null;
  const first = textOf(rows[top + 1]);
  if (!PROMPT_RE.test(first)) return null;

  const glyph = PROMPT_RE.exec(first)?.[0].length ?? 0;
  const lines: BoxLine[] = rows.slice(top + 1, close).map((cells, i) => {
    const typed = typedOf(cells);
    const lastCell = typed.trimEnd().length - 1;
    return {
      text: i === 0 ? typed.slice(glyph) : typed,
      full: lastCell >= cells.length - 1 - RIGHT_MARGIN,
      width: cells.length - glyph - RIGHT_MARGIN,
    };
  });
  return { text: joinRows(lines), rows: lines.length };
}

/** The Ctrl+U burst that clears a box of `rows` screen rows. */
export function clearKeysFor(rows: number): string {
  return CTRL_U.repeat(Math.max(1, rows) * 2 + 2);
}

// ---------------------------------------------------------------------------
// Sends in flight: a text write waiting for its Enter.
// ---------------------------------------------------------------------------

const pendingSend = new Map<string, number>();

/** Is this write the text half of a send (printable text, not a key or escape sequence)? */
function isTextWrite(data: string): boolean {
  return !data.startsWith('\x1b') && /[^\x00-\x1f\x7f]/.test(data);
}

/** Record a write to the terminal through POST /terminals/:id/write. */
export function noteTerminalWrite(terminalId: string, data: string, now = Date.now()): void {
  if (data.includes('\r')) {
    pendingSend.delete(terminalId);
    return;
  }
  if (isTextWrite(data)) pendingSend.set(terminalId, now);
}

/** Has text been written to this terminal recently with no Enter after it? */
export function isSendPending(terminalId: string, now = Date.now()): boolean {
  const at = pendingSend.get(terminalId);
  if (at === undefined) return false;
  if (now - at >= SEND_PENDING_MS) {
    pendingSend.delete(terminalId);
    return false;
  }
  return true;
}

/** Forget a terminal (closed) or everything (tests). */
export function forgetTerminalWrites(terminalId?: string): void {
  if (terminalId === undefined) pendingSend.clear();
  else pendingSend.delete(terminalId);
}

// ---------------------------------------------------------------------------
// The take.
// ---------------------------------------------------------------------------

export interface InputBoxDeps {
  /** The terminal's screen, rendered; null once the terminal is gone or has no output. */
  readScreen(terminalId: string): Promise<ScreenCell[][] | null>;
  write(terminalId: string, data: string): void;
  wait(ms: number): Promise<void>;
  /** Is Claude (or another agent CLI) the terminal's foreground program? */
  agentInFront(terminalId: string): boolean;
  /** Is a send's Enter still to come (`isSendPending`)? */
  sendPending(terminalId: string): boolean;
}

export type TakeRefusal = 'no-terminal' | 'no-input-box' | 'not-agent' | 'send-in-progress' | 'has-attachment';

export type TakeInputResult =
  | { ok: true; text: string; cleared: boolean }
  | { ok: false; reason: TakeRefusal };

/**
 * Read the input box, clear it, and confirm it is empty. Writes nothing unless the box holds plain
 * text and it is safe to type: the agent is in front, no send is between its text and its Enter,
 * and the box holds no paste or image placeholder (whose content would be lost).
 * `cleared: false` means the box still holds text after the clear.
 */
export async function takeInputBox(terminalId: string, deps: InputBoxDeps): Promise<TakeInputResult> {
  if (deps.sendPending(terminalId)) return { ok: false, reason: 'send-in-progress' };
  const screen = await deps.readScreen(terminalId);
  if (!screen) return { ok: false, reason: 'no-terminal' };
  if (!deps.agentInFront(terminalId)) return { ok: false, reason: 'not-agent' };
  const box = parseInputBox(screen);
  if (!box) return { ok: false, reason: 'no-input-box' };
  if (!box.text) return { ok: true, text: '', cleared: true };
  if (ATTACHMENT_RE.test(box.text)) return { ok: false, reason: 'has-attachment' };
  deps.write(terminalId, clearKeysFor(box.rows));
  await deps.wait(CLEAR_SETTLE_MS);
  const after = await deps.readScreen(terminalId);
  const left = after ? parseInputBox(after) : null;
  return { ok: true, text: box.text, cleared: left !== null && left.text === '' };
}
