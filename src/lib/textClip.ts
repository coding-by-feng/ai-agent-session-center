/**
 * @module textClip
 * Is a piece of text cut off by the box it is in?
 *
 * Both ways this app cuts text show up the same way in the layout metrics: a
 * single line with `text-overflow: ellipsis` is wider than its box
 * (`scrollWidth > clientWidth`), and a `-webkit-line-clamp` block is taller than
 * its box (`scrollHeight > clientHeight`). So one check covers the queue's list
 * rows and its cards.
 *
 * Dependency-free so it can be unit-tested without a DOM, like the other pure
 * helpers in this directory.
 */

/**
 * Sub-pixel layout rounds `scrollWidth`/`clientWidth` independently, so text
 * that fits exactly can still report a difference of one. Anything within this
 * is "fits".
 */
export const CLIP_TOLERANCE_PX = 1;

/**
 * The fractional widths (a Range over the text, the box's own rect) are not
 * rounded, so only layout noise separates "fits" from "overflows". Any real
 * overflow, however small, makes `text-overflow: ellipsis` hide characters.
 */
export const FRACTION_TOLERANCE_PX = 0.1;

export interface ClipMetrics {
  scrollWidth: number;
  clientWidth: number;
  scrollHeight: number;
  clientHeight: number;
  /**
   * The text's own width, unrounded (`Range#getBoundingClientRect().width` over
   * the element's contents — the full width, even where an ellipsis cuts it).
   */
  contentWidth?: number;
  /** The element's own width, unrounded (`getBoundingClientRect().width`). */
  boxWidth?: number;
}

/**
 * True when the element's content overflows its box on either axis by more than
 * the tolerance.
 *
 * The whole-pixel metrics miss a sliver: a text 383.48px wide in a 383.00px box
 * reads `scrollWidth === clientWidth === 383` while an ellipsis hides its last
 * characters. When both fractional widths are given (and the element is laid
 * out — a box width of 0 is `display: none` or no layout engine) they decide the
 * horizontal axis too.
 */
export function isTextClipped(metrics: ClipMetrics): boolean {
  if (
    metrics.scrollWidth - metrics.clientWidth > CLIP_TOLERANCE_PX ||
    metrics.scrollHeight - metrics.clientHeight > CLIP_TOLERANCE_PX
  ) {
    return true;
  }
  const { contentWidth, boxWidth } = metrics;
  return (
    contentWidth !== undefined &&
    boxWidth !== undefined &&
    boxWidth > 0 &&
    contentWidth - boxWidth > FRACTION_TOLERANCE_PX
  );
}
