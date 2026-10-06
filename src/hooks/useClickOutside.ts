import { useEffect, type RefObject } from 'react';

type ElementRef = RefObject<HTMLElement | null>;

/**
 * Calls `handler` on a mousedown outside the element(s). Pass several refs when
 * part of the component is portaled out of its own subtree (a menu sent to
 * `<body>`): a click there is outside the component's DOM but not outside the
 * component. A memoized array keeps the listener from re-subscribing per render.
 */
export function useClickOutside(
  refs: ElementRef | ElementRef[],
  handler: () => void,
  enabled = true,
): void {
  useEffect(() => {
    if (!enabled) return;

    function handleClick(e: MouseEvent) {
      const mounted = (Array.isArray(refs) ? refs : [refs]).filter((r) => r.current);
      if (mounted.length > 0 && !mounted.some((r) => r.current?.contains(e.target as Node))) {
        handler();
      }
    }

    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [refs, handler, enabled]);
}
