/**
 * @module btwCapture
 * Reads a Claude Code `/btw` side question and its answer off a terminal's screen, so the phone
 * Chat can show them (Oct 25 2026).
 *
 * **Why the screen.** Claude keeps `/btw` exchanges in memory only (`session.btwHistory` in the
 * CLI): nothing reaches the transcript, so the chat reader can never see them. The answer exists
 * only in the PTY output, drawn as a panel that ends in a key-hint footer
 * (`↑/↓ to scroll · c to copy · f to fork · Esc to …`).
 *
 * **Why a headless xterm.** The TUI redraws with cursor moves, so stripping ANSI from the raw
 * bytes interleaves old and new text (the garbled first line in the phone terminal). Replaying the
 * terminal's output ring into `@xterm/headless` gives the screen exactly as a real terminal shows
 * it, and the panel is read from that.
 *
 * **Cheap on the hot path.** A chunk is only regex-tested for the footer. A capture (a replay of the
 * ring) runs after the output settles, at most once per `MIN_CAPTURE_GAP_MS` per terminal, and
 * only while the footer keeps appearing; an identical question and answer is not re-reported.
 */
import headless from '@xterm/headless';
import { stripAnsi } from '../src/lib/ansi.js';
import type { BtwAnswer } from '../src/types/session.js';

const { Terminal: HeadlessTerminal } = headless as unknown as typeof import('@xterm/headless');

/** The panel's key-hint footer; both hints together are specific to the `/btw` panel. */
const FOOTER_RE = /c to copy\b.*\bf to fork\b/;
/** The question line the panel starts with. */
const QUESTION_RE = /^\s*\/btw\s+(\S.*)$/;
/** A status glyph the CLI draws before the first answer line. */
const LEAD_GLYPH_RE = /^[⏺●◻◼○•✻]\s*/u;

/** Quiet output this long after a footer means the answer has (for now) stopped changing. */
const SETTLE_MS = 700;
/** A terminal that never goes quiet (a spinner ticking) is still captured this long after a footer. */
const MAX_WAIT_MS = 2500;
/** Never replay one terminal's ring more often than this. */
const MIN_CAPTURE_GAP_MS = 2000;
/** Bytes of the previous chunk kept so a footer split across two reads still matches. */
const CARRY_CHARS = 256;
/** Characters of a stored question / answer. */
export const BTW_QUESTION_CAP = 1024;
export const BTW_ANSWER_CAP = 8 * 1024;

export interface BtwScreen {
  bytes: Buffer;
  cols: number;
  rows: number;
}

export interface BtwCaptureDeps {
  /** The terminal's output ring and size, or null once it is gone. */
  snapshot(terminalId: string): BtwScreen | null;
  /** A new (or grown) answer for this terminal. */
  onAnswer(terminalId: string, answer: BtwAnswer): void;
}

interface CaptureState {
  carry: string;
  firstFooterAt: number;
  lastCaptureAt: number;
  timer: ReturnType<typeof setTimeout> | null;
  lastSig: string;
}

const states = new Map<string, CaptureState>();

const cutTo = (text: string, max: number): string => (text.length <= max ? text : text.slice(0, max));

/**
 * The `/btw` question and answer on a rendered screen (one string per row), or null when no panel
 * is showing or its question has scrolled off. Pure: the whole parse is testable without a PTY.
 */
export function parseBtwScreen(lines: readonly string[]): { question: string; answer: string } | null {
  let footer = -1;
  for (let i = lines.length - 1; i >= 0; i--) {
    if (FOOTER_RE.test(lines[i])) { footer = i; break; }
  }
  if (footer < 0) return null;
  let start = -1;
  for (let i = footer - 1; i >= 0; i--) {
    if (QUESTION_RE.test(lines[i])) { start = i; break; }
  }
  if (start < 0) return null;
  const question = (QUESTION_RE.exec(lines[start])?.[1] ?? '').trim();
  const body = lines.slice(start + 1, footer).map((l) => l.replace(/\s+$/, ''));
  while (body.length && !body[0].trim()) body.shift();
  while (body.length && !body[body.length - 1].trim()) body.pop();
  if (!question || body.length === 0) return null;
  body[0] = body[0].replace(/^(\s*)/, '').replace(LEAD_GLYPH_RE, '');
  const indents = body.slice(1).filter((l) => l.trim()).map((l) => /^ */.exec(l)?.[0].length ?? 0);
  const dedent = indents.length ? Math.min(...indents) : 0;
  const answer = [body[0], ...body.slice(1).map((l) => l.slice(Math.min(dedent, /^ */.exec(l)?.[0].length ?? 0)))].join('\n').trim();
  return answer ? { question, answer } : null;
}

/** The screen a terminal shows after `bytes`, one trimmed string per row of the viewport. */
export function renderScreen(screen: BtwScreen): Promise<string[]> {
  return new Promise((resolve) => {
    const term = new HeadlessTerminal({ cols: screen.cols, rows: screen.rows, scrollback: 0, allowProposedApi: true });
    term.write(screen.bytes, () => {
      const buf = term.buffer.active;
      const rows: string[] = [];
      for (let y = 0; y < screen.rows; y++) rows.push(buf.getLine(buf.viewportY + y)?.translateToString(true) ?? '');
      term.dispose();
      resolve(rows);
    });
  });
}

async function capture(terminalId: string, deps: BtwCaptureDeps): Promise<void> {
  const state = states.get(terminalId);
  if (!state) return;
  state.timer = null;
  state.firstFooterAt = 0;
  state.lastCaptureAt = Date.now();
  const screen = deps.snapshot(terminalId);
  if (!screen) return;
  const found = parseBtwScreen(await renderScreen(screen));
  if (!found) return;
  const question = cutTo(found.question, BTW_QUESTION_CAP);
  const answer = cutTo(found.answer, BTW_ANSWER_CAP);
  const sig = `${question}\n${answer}`;
  if (sig === state.lastSig) return;
  state.lastSig = sig;
  deps.onAnswer(terminalId, { question, answer, at: Date.now() });
}

/**
 * Feed one PTY chunk. Arms a capture when the chunk draws the `/btw` footer; while armed, every
 * chunk pushes the capture back until the output settles (or `MAX_WAIT_MS` passes).
 */
export function noteBtwChunk(terminalId: string, chunk: string, deps: BtwCaptureDeps, now = Date.now()): void {
  if (!chunk) return;
  const state = states.get(terminalId) ?? { carry: '', firstFooterAt: 0, lastCaptureAt: 0, timer: null, lastSig: '' };
  states.set(terminalId, state);
  const text = state.carry + stripAnsi(chunk);
  state.carry = text.slice(-CARRY_CHARS);
  const sawFooter = FOOTER_RE.test(text);
  if (sawFooter && !state.firstFooterAt) state.firstFooterAt = now;
  if (!state.firstFooterAt) return;
  if (state.timer) clearTimeout(state.timer);
  const sinceFirst = now - state.firstFooterAt;
  const gap = Math.max(0, state.lastCaptureAt + MIN_CAPTURE_GAP_MS - now);
  const wait = Math.max(gap, Math.min(SETTLE_MS, Math.max(0, MAX_WAIT_MS - sinceFirst)));
  state.timer = setTimeout(() => {
    void capture(terminalId, deps).catch(() => { /* best-effort: never break streaming */ });
  }, wait);
}

/** `/btw` exchanges kept per session. */
export const BTW_KEEP = 5;

/**
 * `list` with `answer` added, as a new array: a growing answer to the newest question replaces that
 * entry (keeping its time); anything else is appended, and only the newest `BTW_KEEP` are kept.
 */
export function withBtwAnswer(list: readonly BtwAnswer[] | undefined, answer: BtwAnswer): BtwAnswer[] {
  const prev = list ?? [];
  const last = prev[prev.length - 1];
  const grows = !!last && last.question === answer.question
    && (answer.answer.startsWith(last.answer.slice(0, 64)) || last.answer.startsWith(answer.answer.slice(0, 64)));
  const next = grows ? [...prev.slice(0, -1), { ...answer, at: last.at }] : [...prev, answer];
  return next.slice(-BTW_KEEP);
}

/** Forget a terminal's capture state. Call on terminal close. */
export function clearBtwState(terminalId: string): void {
  const state = states.get(terminalId);
  if (state?.timer) clearTimeout(state.timer);
  states.delete(terminalId);
}

/** Test-only: wipe all capture state between cases. */
export function resetBtwStates(): void {
  for (const id of [...states.keys()]) clearBtwState(id);
}
