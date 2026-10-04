import { useEffect, useState, type RefObject } from 'react';
import { isTextClipped, type ClipMetrics } from '@/lib/textClip';

/**
 * Everything `isTextClipped` can use. The whole-pixel metrics always; the
 * fractional widths where the browser can measure a Range (jsdom cannot, and
 * then the whole-pixel answer stands).
 */
function measure(element: HTMLElement): ClipMetrics {
  const metrics: ClipMetrics = {
    scrollWidth: element.scrollWidth,
    clientWidth: element.clientWidth,
    scrollHeight: element.scrollHeight,
    clientHeight: element.clientHeight,
  };
  if (typeof document === 'undefined' || typeof document.createRange !== 'function') return metrics;
  const range = document.createRange();
  if (typeof range.getBoundingClientRect !== 'function') return metrics;
  range.selectNodeContents(element);
  return {
    ...metrics,
    contentWidth: range.getBoundingClientRect().width,
    boxWidth: element.getBoundingClientRect().width,
  };
}

interface TextClippedOptions {
  /**
   * Stop measuring and keep the last answer. While a prompt is expanded nothing
   * is cut off, so a reading taken then says "fits" — and the moment it is folded
   * again, before the observer has reported, that would take the toggle away and
   * put a new one back a frame later (and drop keyboard focus in between). The
   * answer from when it was folded is the one that still applies.
   */
  paused?: boolean;
  /**
   * Something that changes the text's metrics without resizing its box — the
   * theme, which swaps the font: a flex row's width comes from the layout, and a
   * clamped card's height is capped at three lines, so no resize is reported.
   */
  remeasureKey?: string;
}

/**
 * Whether the text in `ref` is cut off by its box, kept current as the box is
 * resized (a docked panel dragged narrower, a window resized).
 *
 * The measurement happens in the ResizeObserver callback, never in the effect
 * body: an observer reports each element once when it is first observed, so the
 * initial reading arrives through the same path as every later one, and the
 * effect itself sets no state (`react-hooks/set-state-in-effect` fires on that).
 *
 * `text`, `paused` and `remeasureKey` re-subscribe when they change, which
 * re-measures even where no resize is reported (a prompt edited, a fold, a new
 * font). Where there is no ResizeObserver (old WebViews, jsdom) the answer stays
 * false: the text is shown, there is just no toggle to offer.
 */
export function useTextClipped(
  ref: RefObject<HTMLElement | null>,
  text: string,
  { paused = false, remeasureKey = '' }: TextClippedOptions = {},
): boolean {
  const [clipped, setClipped] = useState(false);

  useEffect(() => {
    const element = ref.current;
    if (paused || !element || typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(() => setClipped(isTextClipped(measure(element))));
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, text, paused, remeasureKey]);

  return clipped;
}
