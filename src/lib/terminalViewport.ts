/**
 * @module terminalViewport
 * Where the terminal's view goes around a write or a fit (Nov 23 2026). The hook used to note the view's absolute
 * line before every write and scroll back to it after: right for someone reading scrollback, but a view at the
 * bottom then fell one line behind for every new line, so a working Codex's newest output and its input box slid
 * out of view ("jumps back up"). Now: a view at the bottom stays at the bottom; a view scrolled up stays on its line.
 * The auto-scroll toggle is separate and still forces the bottom.
 */

interface ViewTerminal {
  readonly buffer: { readonly active: { readonly viewportY: number; readonly baseY: number } };
  scrollToLine(line: number): void;
  scrollToBottom(): void;
}

export interface ViewMark {
  /** The view showed the last screen (xterm's own "at the bottom"). */
  readonly atBottom: boolean;
  /** Its absolute top line, for a view scrolled up. */
  readonly viewportY: number;
}

/** Note where the view is, before a write or a fit. */
export function markView(term: ViewTerminal): ViewMark {
  const { viewportY, baseY } = term.buffer.active;
  return { atBottom: viewportY >= baseY, viewportY };
}

/** Put the view back: at the bottom if it was there, else on the line it showed. Never moves a view that is right. */
export function restoreView(term: ViewTerminal, mark: ViewMark): void {
  const { viewportY, baseY } = term.buffer.active;
  if (mark.atBottom) {
    if (viewportY !== baseY) term.scrollToBottom();
  } else if (viewportY !== mark.viewportY) {
    term.scrollToLine(mark.viewportY);
  }
}
