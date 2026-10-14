/**
 * useSelectionIn — the text a phone user has selected inside one surface
 * (AASC-20: the Conversation tab's AI popup).
 *
 * On a phone a selection is made with a long-press and the handles, not a mouse
 * drag, so the desktop's mouseup trigger (useSelectionPopup) never fires. The
 * document's `selectionchange` does, for touch and mouse alike: this reads the
 * selection as an external store (`useSyncExternalStore`), so it is current on
 * every render and no effect copies it into state.
 *
 * The surface is found by attribute, not by ref: `[data-ai-selectable="<id>"]`
 * on its root, so a selection elsewhere (or in another session's view) is not
 * this surface's.
 */
import { useCallback, useSyncExternalStore } from 'react';

export const SELECTABLE_ATTR = 'data-ai-selectable';

/** How much of the surrounding passage goes with a selection as context (the server caps it at 2 KB). */
const CONTEXT_CHARS = 1500;

function ownerOf(node: Node | null): Element | null {
  const el = node instanceof Element ? node : node?.parentElement ?? null;
  return el?.closest(`[${SELECTABLE_ATTR}]`) ?? null;
}

function currentRange(scopeId: string): Range | null {
  const sel = typeof window === 'undefined' ? null : window.getSelection?.();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  return ownerOf(range.commonAncestorContainer)?.getAttribute(SELECTABLE_ATTR) === scopeId ? range : null;
}

/** The selected text inside the surface marked `scopeId`, trimmed; '' when there is none. */
export function selectedTextIn(scopeId: string): string {
  return currentRange(scopeId) ? (window.getSelection()?.toString() ?? '').trim() : '';
}

/** The selection and the passage around it (the nearest `[data-ai-context]`), or null. */
export function captureSelectionIn(scopeId: string): { text: string; contextLine: string } | null {
  const range = currentRange(scopeId);
  const text = range ? (window.getSelection()?.toString() ?? '').trim() : '';
  if (!range || !text) return null;
  const node = range.commonAncestorContainer;
  const block = (node instanceof Element ? node : node.parentElement)?.closest('[data-ai-context]');
  const contextLine = (block?.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, CONTEXT_CHARS);
  return { text, contextLine };
}

export function useSelectionIn(scopeId: string, enabled: boolean): string {
  const subscribe = useCallback((notify: () => void) => {
    if (!enabled || typeof document === 'undefined') return () => {};
    document.addEventListener('selectionchange', notify);
    return () => document.removeEventListener('selectionchange', notify);
  }, [enabled]);
  return useSyncExternalStore(
    subscribe,
    () => (enabled ? selectedTextIn(scopeId) : ''),
    () => '',
  );
}
