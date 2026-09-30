/**
 * The drag GESTURE, exercised with real pointer events in jsdom.
 *
 * queueDragReorder.test.ts covers the geometry in isolation. This covers the
 * state machine around it — the two thresholds that decide whether a press is
 * a tap, a scroll, or a drag. Those are pure interaction logic and cannot be
 * verified by reading the diff: the failure modes (every button press starts a
 * drag; a scroll snags a card) only appear when events actually fire.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { useQueueDragReorder, HOLD_MS, MOVE_CANCEL_PX } from './useQueueDragReorder';
import type { DragRect } from '@/lib/queueDragReorder';

/** Three cards side by side, 100 wide, 10 apart. */
const RECTS: DragRect[] = [
  { id: 1, left: 0, right: 100, top: 0, bottom: 50 },
  { id: 2, left: 110, right: 210, top: 0, bottom: 50 },
  { id: 3, left: 220, right: 320, top: 0, bottom: 50 },
];

function Harness({ onReorder }: { onReorder: (ids: number[]) => void }) {
  const drag = useQueueDragReorder([1, 2, 3], () => RECTS, onReorder);
  return (
    <div>
      {[1, 2, 3].map((id) => (
        <div
          key={id}
          data-testid={`card-${id}`}
          data-dragging={drag.draggingId === id}
          onPointerDown={(e) => drag.onPointerDown(e, id)}
        >
          <span data-testid={`handle-${id}`} title="Press and hold, then drag to reorder">⋮⋮</span>
          card {id}
          <button type="button">SEND</button>
        </div>
      ))}
      <span data-testid="insert">{String(drag.insertIndex)}</span>
    </div>
  );
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

function press(el: Element, x: number, y: number) {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: 'touch' });
}
function movePointer(x: number, y: number) {
  fireEvent(window, new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
    'pointermove', { clientX: x, clientY: y, bubbles: true, cancelable: true },
  ));
}
function release() {
  fireEvent(window, new Event('pointerup', { bubbles: true }));
}

describe('useQueueDragReorder', () => {
  it('does NOT start a drag before the hold elapses', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('card-1'), 50, 25);
    act(() => { vi.advanceTimersByTime(HOLD_MS - 50); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
  });

  it('lifts the card once the hold elapses', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('card-1'), 50, 25);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('true');
  });

  it('a press on a BUTTON inside the card never starts a drag', () => {
    // Cards are covered in SEND / EDIT / MOVE / DEL. Without this guard every
    // one of them would become a drag handle.
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const sendBtn = screen.getAllByRole('button', { name: 'SEND' })[0];
    press(sendBtn, 50, 25);
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
  });

  it('moving before the hold completes cancels it — a scroll, not a drag', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('card-1'), 50, 25);
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { movePointer(50 + MOVE_CANCEL_PX + 5, 25); });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
    release();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('reorders when dropped past another card', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('card-1'), 50, 25);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    // Right half of card 3 → insert at the end.
    act(() => { movePointer(300, 25); });
    release();
    expect(onReorder).toHaveBeenCalledWith([2, 3, 1]);
  });

  it('does not fire onReorder when dropped in its own slot', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('card-1'), 50, 25);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    act(() => { movePointer(20, 25); }); // left half of card 1 = index 0 = no-op
    release();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('clears the lifted state after release', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('card-1'), 50, 25);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    act(() => { movePointer(300, 25); });
    act(() => { release(); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
    expect(screen.getByTestId('insert').textContent).toBe('null');
  });

  it('clears the pressed handle\'s native title tooltip once dragging starts, restores it on drop', () => {
    // A native `title` tooltip already showing when the hold completes is not
    // reliably dismissed by this gesture's own preventDefault() on
    // pointermove, and can stay pinned over the list for the whole drag —
    // see the `titledEl` doc comment on the gesture ref in the hook.
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const handle = screen.getByTestId('handle-1');
    press(handle, 50, 25);
    expect(handle.getAttribute('title')).toBe('Press and hold, then drag to reorder');
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(handle.getAttribute('title')).toBe('');
    act(() => { movePointer(300, 25); });
    act(() => { release(); });
    expect(handle.getAttribute('title')).toBe('Press and hold, then drag to reorder');
  });

  it('leaves the title untouched when the hold is cancelled before becoming a drag', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const handle = screen.getByTestId('handle-1');
    press(handle, 50, 25);
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { movePointer(50 + MOVE_CANCEL_PX + 5, 25); }); // cancels before hold completes
    expect(handle.getAttribute('title')).toBe('Press and hold, then drag to reorder');
  });
});
