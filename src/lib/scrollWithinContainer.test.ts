import { describe, it, expect, vi } from 'vitest';
import {
  computeScrollTop,
  scrollIntoContainer,
  type ScrollMetrics,
} from './scrollWithinContainer';

/** A 500px-tall viewport over 5000px of content, currently at the top. */
const base: ScrollMetrics = {
  containerHeight: 500,
  containerScrollTop: 0,
  containerScrollHeight: 5000,
  targetOffsetTop: 1200,
  targetHeight: 24,
};

describe('computeScrollTop', () => {
  describe('block: start', () => {
    it('puts the target at the top of the scroller', () => {
      expect(computeScrollTop(base, 'start')).toBe(1200);
    });

    it('is relative to the CURRENT scroll position, not the content origin', () => {
      // Already scrolled 800px down; the target now sits 400px below the fold.
      expect(computeScrollTop(
        { ...base, containerScrollTop: 800, targetOffsetTop: 400 },
        'start',
      )).toBe(1200);
    });

    it('subtracts the padding so the heading is not flush against the edge', () => {
      expect(computeScrollTop(base, 'start', 8)).toBe(1192);
    });

    it('handles a target above the current viewport (negative offset)', () => {
      expect(computeScrollTop(
        { ...base, containerScrollTop: 2000, targetOffsetTop: -1500 },
        'start',
      )).toBe(500);
    });
  });

  describe('block: center', () => {
    it('centers the target in the viewport', () => {
      // 1200 - (500 - 24) / 2 = 1200 - 238
      expect(computeScrollTop(base, 'center')).toBe(962);
    });

    it('centers a target taller than it is tall without overshooting', () => {
      expect(computeScrollTop(
        { ...base, targetHeight: 300 },
        'center',
      )).toBe(1100);
    });
  });

  describe('clamping to the scroller’s real range', () => {
    it('never returns a negative scrollTop', () => {
      expect(computeScrollTop({ ...base, targetOffsetTop: 10 }, 'center')).toBe(0);
      expect(computeScrollTop({ ...base, targetOffsetTop: 0 }, 'start', 40)).toBe(0);
    });

    it('never scrolls past the end of the content', () => {
      // max = 5000 - 500 = 4500
      expect(computeScrollTop({ ...base, targetOffsetTop: 4900 }, 'start')).toBe(4500);
    });

    it('returns 0 when the content is shorter than the viewport', () => {
      expect(computeScrollTop({
        containerHeight: 500,
        containerScrollTop: 0,
        containerScrollHeight: 300,
        targetOffsetTop: 100,
        targetHeight: 24,
      }, 'start')).toBe(0);
    });

    it('rounds to a whole pixel', () => {
      expect(Number.isInteger(computeScrollTop({ ...base, targetHeight: 25 }, 'center'))).toBe(true);
    });
  });
});

describe('scrollIntoContainer', () => {
  const makeEl = (rect: { top: number; height: number }, extra: Partial<HTMLElement> = {}) => {
    const el = document.createElement('div');
    el.getBoundingClientRect = () => ({ top: rect.top, height: rect.height }) as DOMRect;
    Object.assign(el, extra);
    return el;
  };

  const makeScroller = () => {
    const el = makeEl({ top: 100, height: 500 });
    Object.defineProperty(el, 'clientHeight', { value: 500, configurable: true });
    Object.defineProperty(el, 'scrollHeight', { value: 5000, configurable: true });
    el.scrollTop = 0;
    return el;
  };

  it('scrolls the given container and nothing else', () => {
    const scroller = makeScroller();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    // Target's viewport top is 400px below the scroller's → offset 300.
    const target = makeEl({ top: 400, height: 24 });

    expect(scrollIntoContainer(scroller, target, { block: 'start' })).toBe(true);
    expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'smooth' });
  });

  it('never calls scrollIntoView — that is the bug it exists to avoid', () => {
    const scroller = makeScroller();
    scroller.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
    const target = makeEl({ top: 400, height: 24 });
    // Assign directly rather than vi.spyOn: jsdom does not implement
    // scrollIntoView on Element (unlike scrollTo), so spyOn — which requires
    // the property to already exist — throws "not defined on the object"
    // before the assertion ever runs, independent of whether the function
    // under test is correct.
    const scrollIntoViewMock = vi.fn();
    (target as unknown as { scrollIntoView: () => void }).scrollIntoView = scrollIntoViewMock;

    scrollIntoContainer(scroller, target);

    expect(scrollIntoViewMock).not.toHaveBeenCalled();
  });

  it('falls back to assigning scrollTop when Element.scrollTo is unavailable', () => {
    const scroller = makeScroller();
    // jsdom: no scrollTo on elements
    (scroller as unknown as { scrollTo?: unknown }).scrollTo = undefined;
    const target = makeEl({ top: 400, height: 24 });

    scrollIntoContainer(scroller, target, { block: 'start' });

    expect(scroller.scrollTop).toBe(300);
  });

  it('honours the behavior option', () => {
    const scroller = makeScroller();
    const scrollTo = vi.fn();
    scroller.scrollTo = scrollTo as unknown as HTMLElement['scrollTo'];
    scrollIntoContainer(scroller, makeEl({ top: 400, height: 24 }), { behavior: 'auto' });
    expect(scrollTo).toHaveBeenCalledWith({ top: 300, behavior: 'auto' });
  });

  it('returns false and does nothing when either element is missing', () => {
    const scroller = makeScroller();
    scroller.scrollTo = vi.fn() as unknown as HTMLElement['scrollTo'];
    expect(scrollIntoContainer(null, makeEl({ top: 0, height: 10 }))).toBe(false);
    expect(scrollIntoContainer(scroller, null)).toBe(false);
    expect(scroller.scrollTo).not.toHaveBeenCalled();
  });
});
