/**
 * jsdom has no layout engine and no ResizeObserver, so "is this text cut off?"
 * has nothing to measure. This stands in for both:
 *
 *  - `scrollWidth` is 8px per character of the element's own text, `clientWidth`
 *    is whatever the test sets, and the heights always agree — so a text is
 *    clipped exactly when it is longer than `clientWidth / 8` characters. An
 *    element marked `data-expanded="true"` is never clipped: it grows to fit.
 *  - `ResizeObserver` runs its callback once when an element is observed, and
 *    again whenever `fireResize()` is called — which is how a test simulates the
 *    panel being resized.
 *
 *  - `setSliver(px)` (opt-in) adds the UNROUNDED widths jsdom lacks: a Range over
 *    the text reports `scrollWidth + px`, the element's own rect reports
 *    `clientWidth`. With `px` under a whole pixel the whole-pixel metrics still say
 *    "fits" while the fractional ones say "cut off" — a 383.48px text in a 383px box.
 *
 * Call `installClipHarness()` in `beforeEach` and `restore()` in `afterEach`.
 */
import { act } from '@testing-library/react';

type Callback = (entries: unknown[], observer: unknown) => void;

export const CHAR_PX = 8;

export function installClipHarness(initialClientWidth = 200, options: { deferred?: boolean } = {}) {
  let clientWidth = initialClientWidth;
  const live = new Set<{ cb: Callback; targets: Set<Element> }>();
  // With `deferred`, a newly observed element's first report waits for `deliver()` — as the real observer's does
  // (it reports after layout, in a later task), which is what lets a test see the state in between.
  const pending: Array<{ cb: Callback; entry: { cb: Callback; targets: Set<Element> }; el: Element }> = [];

  const proto = HTMLElement.prototype;
  const saved = {
    scrollWidth: Object.getOwnPropertyDescriptor(proto, 'scrollWidth'),
    clientWidth: Object.getOwnPropertyDescriptor(proto, 'clientWidth'),
  };
  Object.defineProperty(proto, 'scrollWidth', {
    configurable: true,
    get(this: HTMLElement) {
      // An expanded prompt wraps and grows to fit, so it is exactly as wide as its box.
      if (this.getAttribute('data-expanded') === 'true') return clientWidth;
      return (this.textContent ?? '').length * CHAR_PX;
    },
  });
  Object.defineProperty(proto, 'clientWidth', {
    configurable: true,
    get() {
      return clientWidth;
    },
  });

  // The fractional widths. Scoped to elements carrying `data-expanded` (QueueItemText's span, the only thing the
  // fake scroll metrics describe) so other tests' rect math is untouched, and only once a test asks for them —
  // until then jsdom's Range has no `getBoundingClientRect` and the hook falls back to whole pixels.
  const rangeProto = Range.prototype as unknown as Record<string, unknown>;
  const elementProto = Element.prototype as unknown as Record<string, unknown>;
  const savedRect = {
    range: Object.getOwnPropertyDescriptor(rangeProto, 'getBoundingClientRect'),
    element: Object.getOwnPropertyDescriptor(elementProto, 'getBoundingClientRect'),
  };
  let sliverInstalled = false;
  const rectOf = (width: number) =>
    ({ width, height: 0, x: 0, y: 0, top: 0, left: 0, right: width, bottom: 0, toJSON: () => ({}) }) as DOMRect;
  function installSliver(extraPx: number) {
    const originalElementRect = savedRect.element?.value as (this: Element) => DOMRect;
    Object.defineProperty(rangeProto, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value(this: Range) {
        const node = this.commonAncestorContainer;
        const el = node instanceof Element ? node : node.parentElement;
        return rectOf(el?.hasAttribute('data-expanded') ? el.scrollWidth + extraPx : 0);
      },
    });
    Object.defineProperty(elementProto, 'getBoundingClientRect', {
      configurable: true,
      writable: true,
      value(this: Element) {
        return this.hasAttribute('data-expanded') ? rectOf((this as HTMLElement).clientWidth) : originalElementRect.call(this);
      },
    });
    sliverInstalled = true;
  }

  class FakeResizeObserver {
    private readonly entry: { cb: Callback; targets: Set<Element> };
    constructor(cb: Callback) {
      this.entry = { cb, targets: new Set() };
      live.add(this.entry);
    }
    observe(el: Element) {
      this.entry.targets.add(el);
      if (options.deferred) {
        pending.push({ cb: this.entry.cb, entry: this.entry, el });
        return;
      }
      // The real observer reports a newly observed element once, after layout. Reporting
      // here instead — inside the effect that subscribed, which the render's act() covers —
      // means no state update lands outside act. Tests that care about the gap before the
      // report ask for `deferred`.
      this.entry.cb([], this);
    }
    unobserve(el: Element) {
      this.entry.targets.delete(el);
    }
    disconnect() {
      this.entry.targets.clear();
      live.delete(this.entry);
    }
  }
  const hadRO = Object.getOwnPropertyDescriptor(globalThis, 'ResizeObserver');
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    writable: true,
    value: FakeResizeObserver,
  });

  return {
    /** The width every element is laid out at, from now on. Call `fireResize()` after to notify observers. */
    setClientWidth(px: number) {
      clientWidth = px;
    },
    /**
     * Report unrounded widths from now on: the text is `px` wider than `scrollWidth`, the box exactly `clientWidth`.
     * Call before rendering (or before `fireResize()`); `restore()` removes it.
     */
    setSliver(px: number) {
      installSliver(px);
    },
    /** Tell every live observer its target changed size. */
    async fireResize() {
      await act(async () => {
        for (const entry of [...live]) {
          if (entry.targets.size > 0) entry.cb([], undefined);
        }
      });
    },
    /** `deferred` only: deliver the first reports that are waiting (to elements still observed). */
    async deliver() {
      const waiting = pending.splice(0);
      await act(async () => {
        for (const item of waiting) {
          if (live.has(item.entry) && item.entry.targets.has(item.el)) item.cb([], undefined);
        }
      });
    },
    /** Number of observers still connected — to prove cleanup. */
    liveObservers: () => [...live].filter((e) => e.targets.size > 0).length,
    restore() {
      if (saved.scrollWidth) Object.defineProperty(proto, 'scrollWidth', saved.scrollWidth);
      else delete (proto as unknown as Record<string, unknown>).scrollWidth;
      if (saved.clientWidth) Object.defineProperty(proto, 'clientWidth', saved.clientWidth);
      else delete (proto as unknown as Record<string, unknown>).clientWidth;
      if (sliverInstalled) {
        if (savedRect.range) Object.defineProperty(rangeProto, 'getBoundingClientRect', savedRect.range);
        else delete rangeProto.getBoundingClientRect;
        if (savedRect.element) Object.defineProperty(elementProto, 'getBoundingClientRect', savedRect.element);
        sliverInstalled = false;
      }
      if (hadRO) Object.defineProperty(globalThis, 'ResizeObserver', hadRO);
      else delete (globalThis as unknown as Record<string, unknown>).ResizeObserver;
      live.clear();
      pending.length = 0;
    },
  };
}
