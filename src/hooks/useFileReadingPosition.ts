import { useCallback, useLayoutEffect, type RefObject } from 'react';
import { readScrollPosition, writePositionValue } from '@/lib/fileReadingPosition';

/** Restore after mount/content load and visibility changes; never save hidden zero offsets. */
export function useFileReadingPosition(
  ref: RefObject<HTMLElement | null>,
  key: string | undefined,
  ready = true,
  onRestore?: (top: number) => void,
) {
  const save = useCallback(() => {
    const el = ref.current;
    if (key && ready && el && el.clientHeight > 0) {
      writePositionValue(key, JSON.stringify({ top: el.scrollTop, left: el.scrollLeft }));
    }
  }, [ref, key, ready]);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !key || !ready) return;
    let visible = false;
    let restoring = false;
    let frame = 0;
    const restore = () => {
      if (!el.clientHeight) {
        visible = false;
        return;
      }
      if (visible) return;
      visible = true;
      restoring = true;
      const p = readScrollPosition(key);
      el.scrollTop = p.top;
      el.scrollLeft = p.left;
      onRestore?.(el.scrollTop);
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        restoring = false;
      });
    };
    const persist = () => {
      if (!restoring && el.clientHeight > 0) {
        writePositionValue(key, JSON.stringify({ top: el.scrollTop, left: el.scrollLeft }));
      }
    };
    restore();
    const observer = new ResizeObserver(restore);
    observer.observe(el);
    el.addEventListener('scroll', persist, { passive: true });
    window.addEventListener('pagehide', persist);
    return () => {
      persist();
      cancelAnimationFrame(frame);
      observer.disconnect();
      el.removeEventListener('scroll', persist);
      window.removeEventListener('pagehide', persist);
    };
  }, [ref, key, ready, onRestore, save]);
  return save;
}
