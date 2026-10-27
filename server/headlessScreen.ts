/**
 * @module headlessScreen
 * A terminal's screen as a real terminal would show it, from its raw output: the bytes are replayed
 * into `@xterm/headless`, because a TUI redraws with cursor moves and stripped bytes interleave old and
 * new text. Shared by the screen readers: `/btw` answers (btwCapture.ts) and Claude's next-prompt
 * suggestion (promptSuggestionCapture.ts), which also needs each cell's dim attribute.
 */
import headless from '@xterm/headless';

const { Terminal: HeadlessTerminal } = headless as unknown as typeof import('@xterm/headless');

export interface TerminalScreen {
  bytes: Buffer;
  cols: number;
  rows: number;
}

/** One drawn cell: its character (a space when blank) and whether it is drawn dim (SGR 2). */
export interface ScreenCell {
  ch: string;
  dim: boolean;
}

type HeadlessBuffer = InstanceType<typeof HeadlessTerminal>['buffer']['active'];

/** Replay `screen.bytes` and hand the visible rows to `read`. */
function replay<T>(screen: TerminalScreen, read: (buf: HeadlessBuffer, y: number) => T): Promise<T[]> {
  return new Promise((resolve) => {
    const term = new HeadlessTerminal({ cols: screen.cols, rows: screen.rows, scrollback: 0, allowProposedApi: true });
    term.write(screen.bytes, () => {
      const buf = term.buffer.active;
      const rows: T[] = [];
      for (let y = 0; y < screen.rows; y++) rows.push(read(buf, buf.viewportY + y));
      term.dispose();
      resolve(rows);
    });
  });
}

/** The screen a terminal shows after `bytes`, one trimmed string per row of the viewport. */
export function renderScreen(screen: TerminalScreen): Promise<string[]> {
  return replay(screen, (buf, y) => buf.getLine(y)?.translateToString(true) ?? '');
}

/** The same screen as cells, so a reader can tell dim (placeholder) text from typed text. */
export function renderScreenCells(screen: TerminalScreen): Promise<ScreenCell[][]> {
  return replay(screen, (buf, y) => {
    const line = buf.getLine(y);
    const cells: ScreenCell[] = [];
    if (!line) return cells;
    for (let x = 0; x < line.length; x++) {
      const cell = line.getCell(x);
      // The second half of a wide character has width 0 and no text of its own.
      if (!cell || cell.getWidth() === 0) continue;
      cells.push({ ch: cell.getChars() || ' ', dim: cell.isDim() !== 0 });
    }
    return cells;
  });
}
