// keepScroll.ts — keeps a scrolling list where the reader left it across a full redraw. The call screen is redrawn
// every second (the clock), and each redraw builds a new transcript list whose scroll starts at the top. A reader
// scrolled up stays put; a reader at the bottom follows new lines.

/** The parts of an element that matter here, so the logic is testable without a DOM. */
export interface ScrollBox {
  scrollTop: number;
  readonly scrollHeight: number;
  readonly clientHeight: number;
}

export interface ScrollMemo {
  top: number;
  atBottom: boolean;
}

/** Within this many pixels of the end counts as "at the bottom" (sub-pixel scroll rounding). */
export const NEAR_BOTTOM_PX = 24;

export function readScroll(box: ScrollBox | null): ScrollMemo | null {
  if (!box) return null;
  return { top: box.scrollTop, atBottom: box.scrollHeight - box.scrollTop - box.clientHeight <= NEAR_BOTTOM_PX };
}

/** `memo` is what was read before the redraw; null (first draw, or the list was hidden) starts at the bottom. */
export function applyScroll(box: ScrollBox | null, memo: ScrollMemo | null): void {
  if (!box) return;
  box.scrollTop = !memo || memo.atBottom ? box.scrollHeight : memo.top;
}
