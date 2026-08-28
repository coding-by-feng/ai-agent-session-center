/**
 * Scroll a target element into view inside ONE container, leaving every
 * ancestor untouched.
 *
 * Why this exists instead of `Element.scrollIntoView()`: that API walks the
 * whole ancestor chain and scrolls **every** scrollable box on it. Per CSS an
 * `overflow: hidden` box is still *programmatically* scrollable, so it happily
 * scrolls boxes the user has no scrollbar for and cannot scroll back. In the
 * Markdown viewer the OUTLINE's `scrollIntoView({ block: 'start' })` therefore
 * scrolled `.mdContainer` (`overflow: hidden`) and its ancestors, dragging the
 * whole detail panel upward until the PROJECT / TERMINAL / COMMANDS /
 * CONVERSATION tab bar was pushed off the top of the window — with nothing at
 * the call site to suggest it could, and no linter able to see it.
 *
 * The arithmetic is split out as a pure function so the clamping behaviour is
 * unit-testable without a layout engine (jsdom reports every rect as zero).
 */

export type ScrollBlock = 'start' | 'center';

export interface ScrollMetrics {
  /** Scroller's visible height (`clientHeight`). */
  containerHeight: number;
  /** Scroller's current `scrollTop`. */
  containerScrollTop: number;
  /** Scroller's total scrollable height (`scrollHeight`). */
  containerScrollHeight: number;
  /** Target's top **relative to the scroller's border box** (rect delta). */
  targetOffsetTop: number;
  /** Target's own height. */
  targetHeight: number;
}

/**
 * The `scrollTop` that puts `target` at the requested position, clamped to the
 * scroller's real range so a heading near the end of the document doesn't ask
 * for an impossible offset.
 */
export function computeScrollTop(
  m: ScrollMetrics,
  block: ScrollBlock = 'start',
  padding = 0,
): number {
  // targetOffsetTop is measured from the scroller's *current* scroll position,
  // so the absolute offset within the content is scrollTop + that delta.
  const absoluteTop = m.containerScrollTop + m.targetOffsetTop;
  const desired =
    block === 'center'
      ? absoluteTop - (m.containerHeight - m.targetHeight) / 2
      : absoluteTop - padding;
  const max = Math.max(0, m.containerScrollHeight - m.containerHeight);
  return Math.round(Math.min(max, Math.max(0, desired)));
}

export interface ScrollIntoContainerOptions {
  block?: ScrollBlock;
  behavior?: ScrollBehavior;
  /** Breathing room above the target in `start` mode. */
  padding?: number;
}

/**
 * Scroll `target` into view within `scroller` only. Returns false when either
 * element is missing, so callers can fall back or bail quietly.
 */
export function scrollIntoContainer(
  scroller: HTMLElement | null | undefined,
  target: Element | null | undefined,
  opts: ScrollIntoContainerOptions = {},
): boolean {
  if (!scroller || !target) return false;

  const containerRect = scroller.getBoundingClientRect();
  const targetRect = target.getBoundingClientRect();
  const top = computeScrollTop(
    {
      containerHeight: scroller.clientHeight,
      containerScrollTop: scroller.scrollTop,
      containerScrollHeight: scroller.scrollHeight,
      targetOffsetTop: targetRect.top - containerRect.top,
      targetHeight: targetRect.height,
    },
    opts.block ?? 'start',
    opts.padding ?? 0,
  );

  // jsdom (and older WebViews) don't implement Element.scrollTo — assigning
  // scrollTop is the equivalent without the smooth animation.
  if (typeof scroller.scrollTo === 'function') {
    scroller.scrollTo({ top, behavior: opts.behavior ?? 'smooth' });
  } else {
    scroller.scrollTop = top;
  }
  return true;
}
