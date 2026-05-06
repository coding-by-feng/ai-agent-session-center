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
  const { enabled, trigger = 'auto', containerRef, extract } = opts;
  const [active, setActive] = useState<ExtractedSelection | null>(null);
  const lastUpRef = useRef<number>(0);

  const close = useCallback(() => setActive(null), []);
  const open = useCallback((sel: ExtractedSelection) => setActive(sel), []);

  useEffect(() => {
    if (!enabled || trigger === 'off') {
      setActive(null);
      return;
    }
    const container = containerRef.current;
    if (!container) return;

    const onMouseUp = (e: MouseEvent): void => {
      // De-duplicate: ignore quick double-fires
      const now = performance.now();
      if (now - lastUpRef.current < 50) return;
      lastUpRef.current = now;

      if (trigger === 'alt' && !e.altKey) {
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

    container.addEventListener('mouseup', onMouseUp);
    document.addEventListener('selectionchange', onSelectionChange);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      container.removeEventListener('mouseup', onMouseUp);
      document.removeEventListener('selectionchange', onSelectionChange);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [enabled, trigger, containerRef, extract]);

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
