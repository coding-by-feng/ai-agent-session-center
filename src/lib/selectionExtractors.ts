/**
 * Surface-agnostic selection extractors used by SelectionPopup.
 *
 * Each extractor reads the current selection from a specific source (xterm.js
 * terminal vs. the DOM `window.getSelection()`) and returns a uniform shape
 * the popup can act on.
 */

export interface ExtractedSelection {
  /** The user-selected text. Always non-empty when returned. */
  selection: string;
  /**
   * The single line surrounding the selection (or the selection itself if it
   * already spans a single short line). Used to give the AI a tiny bit of
   * context. Trimmed to ~400 chars.
   */
  contextLine: string;
  /**
   * Anchor rect for positioning the popup. In viewport coordinates (clientX/Y).
   */
  anchor: { x: number; y: number; right: number; bottom: number };
}

const MAX_SELECTION = 4000;
const MAX_CONTEXT_LINE = 400;

function clampString(value: string, max: number): string {
  if (value.length <= max) return value;
  return value.slice(0, max);
}

function rectFromSelection(): DOMRect | null {
  if (typeof window === 'undefined') return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;
  try {
    const range = sel.getRangeAt(0);
    const rects = range.getClientRects();
    if (rects.length === 0) return range.getBoundingClientRect();
    // Prefer the *last* rect (so the popup hugs the end of the selection)
    return rects[rects.length - 1];
  } catch {
    return null;
  }
}

/**
 * DOM-based selection extractor (markdown viewers, summary, notes).
 *
 * `containerEl` constrains where the selection must be — selections that
 * start outside the container are ignored.
 */
export function extractDomSelection(containerEl: HTMLElement | null): ExtractedSelection | null {
  if (!containerEl || typeof window === 'undefined') return null;
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return null;

  const range = sel.getRangeAt(0);
  // Confirm the selection starts inside the target container
  if (!containerEl.contains(range.commonAncestorContainer)) return null;

  const text = sel.toString().trim();
  if (!text) return null;

  // Surrounding context line — climb to the closest block-level ancestor and
  // grab its textContent, trimmed and clamped.
  let contextLine = text;
  const blockEl = findBlockAncestor(range.startContainer, containerEl);
  if (blockEl && blockEl.textContent) {
    const block = blockEl.textContent.replace(/\s+/g, ' ').trim();
    if (block && block !== text) contextLine = block;
  }

  const rect = rectFromSelection();
  const anchor = rect
    ? { x: rect.left, y: rect.top, right: rect.right, bottom: rect.bottom }
    : { x: 0, y: 0, right: 0, bottom: 0 };

  return {
    selection: clampString(text, MAX_SELECTION),
    contextLine: clampString(contextLine, MAX_CONTEXT_LINE),
    anchor,
  };
}

function findBlockAncestor(node: Node, root: HTMLElement): HTMLElement | null {
  let cur: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (cur && cur !== root) {
    if (cur.nodeType === Node.ELEMENT_NODE) {
      const el = cur as HTMLElement;
      const display = window.getComputedStyle(el).display;
      if (display !== 'inline' && display !== 'inline-block') return el;
    }
    cur = cur.parentNode;
  }
  return root;
}

/**
 * xterm.js selection extractor.
 *
 * Pass an xterm Terminal instance and an anchor rect (taken from the terminal's
 * container) so the popup can be positioned roughly at the end of the
 * selection. xterm exposes `getSelectionPosition()` (cell coords) which we use
 * to refine the rect when available.
 */
interface XtermLike {
  getSelection(): string;
  hasSelection(): boolean;
}

export function extractXtermSelection(
  term: XtermLike | null,
  containerEl: HTMLElement | null,
  anchorEvent?: { clientX: number; clientY: number } | null,
): ExtractedSelection | null {
  if (!term || !term.hasSelection || !term.hasSelection()) return null;
  const text = term.getSelection().trim();
  if (!text) return null;

  // For xterm we don't have block-context easily — the surrounding line is
  // the selection itself (truncated). The model still gets it as a hint.
  const firstLine = text.split('\n')[0];

  let anchor = { x: 0, y: 0, right: 0, bottom: 0 };
  if (anchorEvent) {
    anchor = {
      x: anchorEvent.clientX,
      y: anchorEvent.clientY,
      right: anchorEvent.clientX,
      bottom: anchorEvent.clientY,
    };
  } else if (containerEl) {
    const rect = containerEl.getBoundingClientRect();
    anchor = {
      x: rect.left + rect.width / 2,
      y: rect.top + rect.height / 2,
      right: rect.left + rect.width / 2,
      bottom: rect.top + rect.height / 2,
    };
  }

  return {
    selection: clampString(text, MAX_SELECTION),
    contextLine: clampString(firstLine, MAX_CONTEXT_LINE),
    anchor,
  };
}
