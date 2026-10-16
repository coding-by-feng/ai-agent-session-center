/**
 * useKeepEndInView — keep a horizontal scroller's end in view: a path bar's last crumb (the open
 * file, the current folder). It scrolls to the end when `key` changes and again whenever the bar
 * or its content changes size, since buttons that mount beside the bar narrow it after the first
 * scroll (the Project tab's file toolbar did, clipping greet.ts to "gr").
 */
import { useLayoutEffect, type RefObject } from 'react';

export function useKeepEndInView(ref: RefObject<HTMLElement | null>, key: unknown): void {
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return undefined;
    const pin = () => { el.scrollLeft = el.scrollWidth; };
    pin();
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(pin);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [ref, key]);
}
