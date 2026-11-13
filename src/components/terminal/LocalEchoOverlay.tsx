/**
 * LocalEchoOverlay — draws the guesses of `src/lib/localEcho.ts` over the terminal ("Instant typing").
 *
 * It listens to the attached xterm itself (typed input, finished writes, resize, scroll, buffer switch) and
 * renders into `.xterm-screen`, so its cells line up with xterm's without reading anything outside the terminal.
 * It never writes to the terminal: a guess exists only here.
 *
 * Each guess is drawn on the terminal's background, so it hides what the cell showed before (the caret, or the
 * program's faint suggestion). A faint run right after the guesses is hidden too, and a bar caret is drawn
 * after the last guess. Guesses are underlined only while echoes are slow.
 */
import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import type { Terminal } from '@xterm/xterm';
import {
  GUESS_TIMEOUT_MS,
  INITIAL_ECHO,
  echoExpire,
  echoInput,
  echoOutput,
  echoReset,
  isSlowEcho,
  shownGuesses,
  type EchoState,
  type ScreenView,
} from '@/lib/localEcho';
import styles from '@/styles/modules/LocalEchoOverlay.module.css';

interface LocalEchoOverlayProps {
  getTerminal: () => Terminal | null;
  terminalId: string | null;
  enabled: boolean;
}

interface PaintedCell {
  key: string;
  ch: string;
  left: number;
  width: number;
}

interface Painting {
  terminalId: string;
  host: HTMLElement;
  top: number;
  cellHeight: number;
  cells: PaintedCell[];
  erase: { left: number; width: number } | null;
  caretLeft: number;
  slow: boolean;
  vars: React.CSSProperties;
}

function screenView(term: Terminal): ScreenView {
  const buf = term.buffer.active;
  return {
    cursorRow: buf.baseY + buf.cursorY,
    cursorCol: buf.cursorX,
    cols: term.cols,
    cellAt: (row, col) => buf.getLine(row)?.getCell(col)?.getChars() ?? '',
  };
}

/** Cells after `col` on `row` that the program drew faint (Claude's grey "Try …" suggestion). */
function faintRun(term: Terminal, row: number, col: number): number {
  const line = term.buffer.active.getLine(row);
  let end = col;
  while (end < term.cols && line?.getCell(end)?.isDim()) end += 1;
  return end - col;
}

/** Where the shown guesses go on screen, or null when there are none or they are scrolled out of view. */
function paint(term: Terminal, terminalId: string, state: EchoState): Painting | null {
  const guesses = shownGuesses(state);
  const host = term.element?.querySelector<HTMLElement>('.xterm-screen');
  if (guesses.length === 0 || !host || !term.cols || !term.rows) return null;
  const buf = term.buffer.active;
  const row = guesses[0].row;
  const viewportRow = row - buf.viewportY;
  if (viewportRow < 0 || viewportRow >= term.rows) return null;

  const cellWidth = host.clientWidth / term.cols;
  const cellHeight = host.clientHeight / term.rows;
  const last = guesses[guesses.length - 1];
  const afterLast = last.col + last.width;
  const faint = faintRun(term, row, afterLast);
  const theme = term.options.theme ?? {};
  const foreground = theme.foreground ?? '#e0e0e0';
  return {
    terminalId,
    host,
    top: viewportRow * cellHeight,
    cellHeight,
    cells: guesses.map((g) => ({ key: `${g.col}:${g.at}`, ch: g.ch, left: g.col * cellWidth, width: g.width * cellWidth })),
    erase: faint > 0 ? { left: afterLast * cellWidth, width: faint * cellWidth } : null,
    caretLeft: afterLast * cellWidth,
    slow: isSlowEcho(state),
    vars: {
      '--echo-bg': theme.background ?? '#0a0a1a',
      '--echo-fg': foreground,
      '--echo-caret': theme.cursor ?? foreground,
      '--echo-font': term.options.fontFamily ?? 'monospace',
      '--echo-size': `${term.options.fontSize ?? 14}px`,
    } as React.CSSProperties,
  };
}

export default function LocalEchoOverlay({ getTerminal, terminalId, enabled }: LocalEchoOverlayProps) {
  const [painting, setPainting] = useState<Painting | null>(null);

  useEffect(() => {
    const term = enabled && terminalId ? getTerminal() : null;
    if (!term || !terminalId) return undefined;
    let state: EchoState = INITIAL_ECHO;
    let expiry: ReturnType<typeof setTimeout> | null = null;

    const update = (next: EchoState): void => {
      const changed = next !== state;
      state = next;
      if (expiry) clearTimeout(expiry);
      expiry = null;
      if (state.guesses.length > 0) {
        const oldest = Math.min(...state.guesses.map((g) => g.at));
        expiry = setTimeout(() => update(echoExpire(state, Date.now())), Math.max(0, oldest + GUESS_TIMEOUT_MS + 5 - Date.now()));
      }
      if (changed || state.guesses.length > 0) setPainting(paint(term, terminalId, state));
    };

    const subscriptions = [
      term.onData((data) => update(echoInput(state, data, screenView(term), Date.now()))),
      term.onWriteParsed(() => {
        if (state.trusted || state.guesses.length > 0) update(echoOutput(state, screenView(term), Date.now()));
      }),
      term.onResize(() => update(echoReset(state))),
      term.onScroll(() => {
        if (state.guesses.length > 0) setPainting(paint(term, terminalId, state));
      }),
      term.buffer.onBufferChange(() => update(echoReset(state))),
    ];
    return () => {
      subscriptions.forEach((subscription) => subscription.dispose());
      if (expiry) clearTimeout(expiry);
    };
  }, [getTerminal, terminalId, enabled]);

  // A painting from another terminal, or from before instant typing was turned off, is stale.
  if (!enabled || !painting || painting.terminalId !== terminalId) return null;
  const { host, top, cellHeight, cells, erase, caretLeft, slow, vars } = painting;
  return createPortal(
    <div
      className={`${styles.layer}${slow ? ` ${styles.slow}` : ''}`}
      style={{ ...vars, top, height: cellHeight, lineHeight: `${cellHeight}px` }}
      aria-hidden="true"
      data-local-echo=""
    >
      {cells.map((cell) => (
        <span key={cell.key} className={styles.cell} style={{ left: cell.left, width: cell.width }} data-local-echo-guess="">
          {cell.ch}
        </span>
      ))}
      {erase && <span className={styles.erase} style={{ left: erase.left, width: erase.width }} data-local-echo-erase="" />}
      <span className={styles.caret} style={{ left: caretLeft }} />
    </div>,
    host,
  );
}
