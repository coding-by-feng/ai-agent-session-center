/**
 * useSelectionPopup — surface-agnostic selection-to-popup hook.
 *
 * Watches a container element for completed selections (via mouseup +
 * selectionchange) and surfaces an `active` state that the SelectionPopup
 * component can consume. The actual selection extraction is delegated to a
 * caller-supplied `extractor` so this hook works for both DOM-based viewers
 * (ProjectTab markdown) and xterm.js terminals.
 *
 * Trigger modes:
 *  - 'auto'   — show on selection end immediately
 *  - 'alt'    — show only when the user releases mouse with Alt held
 *  - 'off'    — never auto-show (popup only opens via explicit API)
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ExtractedSelection } from '@/lib/selectionExtractors';

export type SelectionTrigger = 'auto' | 'alt' | 'off';

// A pointer that moves less than this between mousedown and mouseup is a click,
// not a drag-select. Guards against re-opening the popup on a bare click when the
// surface still reports a STALE selection (see onMouseUp).
const CLICK_DRAG_THRESHOLD_PX = 4;

export interface UseSelectionPopupOptions {
  /** True when the parent surface wants the popup to be available. */
  enabled: boolean;
  /** Trigger mode. Defaults to 'auto'. */
  trigger?: SelectionTrigger;
  /** Element to watch for selections. */
  containerRef: React.RefObject<HTMLElement | null>;
  /**
   * Pure function that returns an ExtractedSelection or null. Called on every
   * candidate trigger event.
   */
  extract: (e: { clientX: number; clientY: number; altKey: boolean }) => ExtractedSelection | null;
  /**
   * Optional CSS selector identifying the selectable surface. When set, a mouseup
   * counts as in-scope if its target `closest(scopeSelector)` matches — in
   * ADDITION to the `containerRef` containment check. Required for surfaces that
   * reparent their content out of `containerRef` at runtime: the terminal moves
   * its `.xterm` element into a body-level fullscreen overlay, so the mouseup no
   * longer bubbles through `containerRef`. Scoping to '.xterm' follows the element
   * across the move so select-to-translate keeps working in fullscreen.
   */
  scopeSelector?: string;
}

export interface SelectionPopupState {
  /** The currently active extracted selection, or null when hidden. */
  active: ExtractedSelection | null;
  /** Programmatically dismiss the popup. */
  close: () => void;
  /**
   * Programmatically open the popup with a manually-built selection.
   * Useful for the "Translate file" toolbar button.
   */
  open: (sel: ExtractedSelection) => void;
}

export function useSelectionPopup(opts: UseSelectionPopupOptions): SelectionPopupState {
  const { enabled, trigger = 'auto', containerRef, extract, scopeSelector } = opts;
  const [active, setActive] = useState<ExtractedSelection | null>(null);
  const lastUpRef = useRef<number>(0);

  const close = useCallback(() => setActive(null), []);
  const open = useCallback((sel: ExtractedSelection) => setActive(sel), []);

  useEffect(() => {
    if (!enabled || trigger === 'off') {
      setActive(null);
      return;
    }
    // Is the mouseup within our selectable surface? We listen on `document`
    // (not `containerRef`) because some surfaces reparent their content out of
    // the container — the terminal moves its `.xterm` element into a body-level
    // fullscreen overlay, so container-bound events silently stop firing. The
    // `scopeSelector` follows the content across that move; `containerRef`
    // containment remains the fallback for static surfaces (markdown viewer).
    const inScope = (target: HTMLElement | null): boolean => {
      if (!target) return false;
      if (scopeSelector && target.closest(scopeSelector)) return true;
      const container = containerRef.current;
      return !!container && container.contains(target);
    };

    // Track where the pointer went down so mouseup can tell a drag from a click.
    let downX = 0;
    let downY = 0;
    const onMouseDown = (e: MouseEvent): void => {
      downX = e.clientX;
      downY = e.clientY;
    };

    const onMouseUp = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      // Only react to selections made inside our surface.
      if (!inScope(target)) return;
      // Don't trigger when clicking buttons, links, or editable fields (the
      // terminal's input helper is a <textarea>).
      if (target?.closest('button, a, input, select, textarea, [role="button"]')) return;

      // De-duplicate: ignore quick double-fires
      const now = performance.now();
      if (now - lastUpRef.current < 50) return;
      lastUpRef.current = now;

      if (trigger === 'alt' && !e.altKey) {
        setActive(null);
        return;
      }

      // A bare click must never open the popup — only a real selection gesture
      // (a drag, or a double/triple-click word/line select) may. Some surfaces
      // keep a STALE selection after a click: the Claude Code TUI in the AI-popup
      // terminal captures mouse events, so xterm doesn't clear its selection on a
      // plain click. Extracting on such a click re-opens the modes popup even
      // though the user only clicked into the input. Requiring movement OR a
      // multi-click (`e.detail >= 2`) closes that hole for every surface.
      const dragged =
        Math.abs(e.clientX - downX) > CLICK_DRAG_THRESHOLD_PX ||
        Math.abs(e.clientY - downY) > CLICK_DRAG_THRESHOLD_PX;
      if (!dragged && e.detail < 2) {
        setActive(null);
        return;
      }

      // Defer one frame so the selection has finalized
      requestAnimationFrame(() => {
        const sel = extract({ clientX: e.clientX, clientY: e.clientY, altKey: e.altKey });
        setActive(sel);
      });
    };

    const onSelectionChange = (): void => {
      // If selection becomes empty, dismiss
      const s = window.getSelection?.();
      if (!s || s.isCollapsed) {
        // Don't close if popup-internal interactions cleared the DOM selection
        // — only close when the popup is showing AND user truly cleared.
        // This is handled by mouseup + click-outside, so we no-op here for now.
      }
    };

    const onKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setActive(null);
    };

    document.addEventListener('mousedown', onMouseDown);
    document.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('mousedown', onMouseDown);
      document.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, trigger, containerRef, extract, scopeSelector]);

  // Click-outside to close: registered separately so it doesn't depend on
  // the container ref being up to date.
  useEffect(() => {
    if (!active) return;
    const onDocClick = (e: MouseEvent): void => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (target.closest('[data-selection-popup]')) return;
      // If the user click-drags to extend the selection, mouseup will refresh.
      // We close on simple clicks outside the popup.
      setActive(null);
    };
    document.addEventListener('mousedown', onDocClick);
    return () => document.removeEventListener('mousedown', onDocClick);
  }, [active]);

  return { active, close, open };
}
