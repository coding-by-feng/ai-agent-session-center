// useLongPress.test.tsx — a touch long-press that never gets in a scroll's way (AASC-20).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { act, fireEvent, render } from '@testing-library/react';
import { useRef } from 'react';
import { useLongPress, LONG_PRESS_MS } from './useLongPress';

function Surface({ onLongPress, enabled = true }: { onLongPress: (p: { clientX: number; clientY: number }) => void; enabled?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useLongPress({ enabled, targets: [ref], selector: '.screen', onLongPress });
  return (
    <div ref={ref} data-testid="surface">
      <div className="screen" data-testid="screen">output</div>
      <button type="button" data-testid="key">Esc</button>
    </div>
  );
}

/** jsdom has no PointerEvent: a MouseEvent carries the coordinates, the pointer fields are added. */
function pointer(el: Element, type: string, init: { x?: number; y?: number; pointerType?: string; id?: number } = {}) {
  const event = new MouseEvent(type, { bubbles: true, clientX: init.x ?? 10, clientY: init.y ?? 10 });
  Object.assign(event, { pointerType: init.pointerType ?? 'touch', pointerId: init.id ?? 1, isPrimary: true });
  act(() => { el.dispatchEvent(event); });
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('useLongPress', () => {
  it('fires once a finger stays put for the press time, at where it went down', () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Surface onLongPress={onLongPress} />);
    pointer(getByTestId('screen'), 'pointerdown', { x: 40, y: 90 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS - 1); });
    expect(onLongPress).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1); });
    expect(onLongPress).toHaveBeenCalledWith({ clientX: 40, clientY: 90 });
  });

  it('a scroll is not a press: moving, lifting, a cancel or a scroll event ends it', () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Surface onLongPress={onLongPress} />);
    const screen = getByTestId('screen');

    pointer(screen, 'pointerdown', { x: 40, y: 90 });
    pointer(screen, 'pointermove', { x: 40, y: 75 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });

    pointer(screen, 'pointerdown');
    pointer(screen, 'pointerup');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });

    pointer(screen, 'pointerdown');
    pointer(screen, 'pointercancel');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });

    pointer(screen, 'pointerdown');
    act(() => { fireEvent.scroll(screen); });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS * 2); });

    expect(onLongPress).not.toHaveBeenCalled();
  });

  it('tolerates a finger’s jitter', () => {
    const onLongPress = vi.fn();
    const { getByTestId } = render(<Surface onLongPress={onLongPress} />);
    pointer(getByTestId('screen'), 'pointerdown', { x: 40, y: 90 });
    pointer(getByTestId('screen'), 'pointermove', { x: 44, y: 93 });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(onLongPress).toHaveBeenCalledTimes(1);
  });

  it('ignores a mouse, presses outside the selector, and a disabled surface', () => {
    const onLongPress = vi.fn();
    const { getByTestId, rerender } = render(<Surface onLongPress={onLongPress} />);
    pointer(getByTestId('screen'), 'pointerdown', { pointerType: 'mouse' });
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    pointer(getByTestId('key'), 'pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    rerender(<Surface onLongPress={onLongPress} enabled={false} />);
    pointer(getByTestId('screen'), 'pointerdown');
    act(() => { vi.advanceTimersByTime(LONG_PRESS_MS); });
    expect(onLongPress).not.toHaveBeenCalled();
  });
});
