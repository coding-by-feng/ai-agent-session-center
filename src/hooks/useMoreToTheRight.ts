/**
 * useMoreToTheRight — does a sideways scroller have content past its right edge right
 * now? The phone's filter chips fade their edge then (Oct 20 2026), so a chip cut in
 * half reads as "scroll for more", and stop fading once scrolled to the end or when
 * everything fits. Measured on resize, on scroll and when the children change.
 */
import { useCallback, useEffect, useState } from 'react';

export function useMoreToTheRight<T extends HTMLElement>(): [(el: T | null) => void, boolean] {
  const [el, setEl] = useState<T | null>(null);
  const [more, setMore] = useState(false);
  const ref = useCallback((node: T | null) => setEl(node), []);

  useEffect(() => {
    if (!el) return undefined;
    const measure = () => setMore(el.scrollLeft + el.clientWidth < el.scrollWidth - 1);
    measure();
    const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    resize?.observe(el);
    const mutations = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measure);
    mutations?.observe(el, { childList: true, subtree: true, characterData: true });
    el.addEventListener('scroll', measure, { passive: true });
    return () => {
      resize?.disconnect();
      mutations?.disconnect();
      el.removeEventListener('scroll', measure);
    };
  }, [el]);

  return [ref, more];
}
