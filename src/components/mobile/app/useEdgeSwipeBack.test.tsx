// useEdgeSwipeBack.test.tsx — the in-page back swipe (AASC-39): only from the left
// edge, only sideways, completes past 40 % or on a flick, cancels otherwise.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useRef } from 'react';
import { COMPLETE_RATIO, EDGE_PX, FLICK_PX_PER_MS, edgeSwipeOutcome, useEdgeSwipeBack } from './useEdgeSwipeBack';

describe('edgeSwipeOutcome', () => {
  it('completes past 40 % of the width', () => {
    expect(edgeSwipeOutcome(390 * COMPLETE_RATIO, 390, 0)).toBe('complete');
    expect(edgeSwipeOutcome(390 * COMPLETE_RATIO - 1, 390, 0)).toBe('cancel');
  });

  it('completes a short fast flick, but not a twitch', () => {
    expect(edgeSwipeOutcome(60, 390, FLICK_PX_PER_MS + 0.1)).toBe('complete');
    expect(edgeSwipeOutcome(10, 390, 5)).toBe('cancel');
  });

  it('never completes a drag back to the left', () => {
    expect(edgeSwipeOutcome(-100, 390, 3)).toBe('cancel');
  });
});

function Host({ enabled, onBack }: { enabled: boolean; onBack: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEdgeSwipeBack(ref, enabled, onBack);
  return <div ref={ref} data-testid="host"><p data-testid="row">row</p></div>;
}

function touch(el: Element, type: string, x: number, y = 100, t = 0) {
  const ev = new Event(type, { bubbles: true, cancelable: true }) as Event & { touches: unknown[] };
  Object.defineProperty(ev, 'touches', { value: type === 'touchend' ? [] : [{ clientX: x, clientY: y }] });
  Object.defineProperty(ev, 'timeStamp', { value: t });
  el.dispatchEvent(ev);
  return ev;
}

describe('useEdgeSwipeBack', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      left: 0, top: 0, right: 390, bottom: 800, width: 390, height: 800, x: 0, y: 0, toJSON: () => ({}),
    });
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('follows a drag from the edge and pops once it is far enough', () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Host enabled onBack={onBack} />);
    const host = getByTestId('host');
    touch(host, 'touchstart', EDGE_PX - 4, 100, 0);
    const move = touch(host, 'touchmove', 250, 105, 300);
    expect(move.defaultPrevented).toBe(true);
    expect(host.dataset.swipe).toBe('drag');
    expect(host.style.getPropertyValue('--edge-dx')).not.toBe('');
    touch(host, 'touchend', 250, 105, 320);
    act(() => { vi.advanceTimersByTime(300); });
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it('slides back when let go too early', () => {
    const onBack = vi.fn();
    const { getByTestId } = render(<Host enabled onBack={onBack} />);
    const host = getByTestId('host');
    touch(host, 'touchstart', 4, 100, 0);
    touch(host, 'touchmove', 60, 100, 400);
    touch(host, 'touchend', 60, 100, 800);
    act(() => { vi.advanceTimersByTime(300); });
    expect(onBack).not.toHaveBeenCalled();
    expect(host.dataset.swipe).toBeUndefined();
  });

  it('ignores a touch away from the edge, a vertical scroll, and a root screen', () => {
    const onBack = vi.fn();
    const { getByTestId, rerender } = render(<Host enabled onBack={onBack} />);
    const host = getByTestId('host');
    touch(host, 'touchstart', 40, 100, 0);
    touch(host, 'touchmove', 300, 100, 100);
    touch(host, 'touchend', 300, 100, 120);
    touch(host, 'touchstart', 4, 100, 0);
    const scroll = touch(host, 'touchmove', 10, 300, 100);
    expect(scroll.defaultPrevented).toBe(false);
    touch(host, 'touchend', 10, 300, 120);
    rerender(<Host enabled={false} onBack={onBack} />);
    touch(host, 'touchstart', 4, 100, 0);
    touch(host, 'touchmove', 300, 100, 100);
    touch(host, 'touchend', 300, 100, 120);
    act(() => { vi.advanceTimersByTime(300); });
    expect(onBack).not.toHaveBeenCalled();
  });

  // Oct 26 2026: over Tailscale a session screen stayed half swiped.
  describe('a drag always ends', () => {
    it('hears the end on the element the touch started on, after a live update replaced it', () => {
      const onBack = vi.fn();
      const { getByTestId } = render(<Host enabled onBack={onBack} />);
      const host = getByTestId('host');
      const row = getByTestId('row');
      touch(row, 'touchstart', 4, 100, 0);
      touch(row, 'touchmove', 250, 100, 300);
      expect(host.dataset.swipe).toBe('drag');
      row.remove();
      touch(row, 'touchend', 250, 100, 320);
      act(() => { vi.advanceTimersByTime(300); });
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('handles an end that reaches both the row and the stack once', () => {
      const onBack = vi.fn();
      const { getByTestId } = render(<Host enabled onBack={onBack} />);
      const row = getByTestId('row');
      touch(row, 'touchstart', 4, 100, 0);
      touch(row, 'touchmove', 250, 100, 300);
      touch(row, 'touchend', 250, 100, 320);
      act(() => { vi.advanceTimersByTime(300); });
      expect(onBack).toHaveBeenCalledTimes(1);
    });

    it('slides back a drag whose end never came when the next touch starts', () => {
      const onBack = vi.fn();
      const { getByTestId } = render(<Host enabled onBack={onBack} />);
      const host = getByTestId('host');
      touch(host, 'touchstart', 4, 100, 0);
      touch(host, 'touchmove', 250, 100, 300);
      touch(host, 'touchstart', 200, 300, 2000);
      expect(host.dataset.swipe).toBe('settle');
      act(() => { vi.advanceTimersByTime(300); });
      expect(host.dataset.swipe).toBeUndefined();
      expect(host.style.getPropertyValue('--edge-dx')).toBe('');
      expect(onBack).not.toHaveBeenCalled();
    });

    it('slides back when the app leaves the screen mid-drag', () => {
      const onBack = vi.fn();
      const { getByTestId } = render(<Host enabled onBack={onBack} />);
      const host = getByTestId('host');
      touch(host, 'touchstart', 4, 100, 0);
      touch(host, 'touchmove', 250, 100, 300);
      act(() => { window.dispatchEvent(new Event('blur')); });
      act(() => { vi.advanceTimersByTime(300); });
      expect(host.dataset.swipe).toBeUndefined();
      expect(onBack).not.toHaveBeenCalled();
    });
  });
});
