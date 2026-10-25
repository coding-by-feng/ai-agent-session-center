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
import { useQueueDragReorder, edgeScrollStep, HOLD_MS, MOVE_CANCEL_PX, EDGE_PX } from './useQueueDragReorder';
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

describe('useQueueDragReorder — a mouse lifts on move (Oct 22 2026)', () => {
  function mousePress(el: Element, x: number, y: number) {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: 'mouse' });
  }

  it('a mouse that moves past the threshold lifts the row without waiting out the hold', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    mousePress(screen.getByTestId('card-1'), 50, 25);
    act(() => { movePointer(50 + MOVE_CANCEL_PX + 5, 25); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('true');
    act(() => { movePointer(300, 25); });
    act(() => { release(); });
    expect(onReorder).toHaveBeenCalledWith([2, 3, 1]);
  });

  it('a mouse jitter inside the threshold stays a click', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    mousePress(screen.getByTestId('card-1'), 50, 25);
    act(() => { movePointer(50 + MOVE_CANCEL_PX - 2, 25); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
    act(() => { release(); });
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('a mouse press on a BUTTON still never drags, however far it moves', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    mousePress(screen.getAllByRole('button', { name: 'SEND' })[0], 50, 25);
    act(() => { movePointer(300, 25); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
  });

  it('a pen keeps the hold: moving first is a scroll, as with a finger', () => {
    render(<Harness onReorder={vi.fn()} />);
    fireEvent.pointerDown(screen.getByTestId('card-1'), { clientX: 50, clientY: 25, button: 0, pointerType: 'pen' });
    act(() => { movePointer(50 + MOVE_CANCEL_PX + 5, 25); });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(screen.getByTestId('card-1').dataset.dragging).toBe('false');
  });
});

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

/**
 * AASC-18: on a phone the rows are `touch-action: pan-y`, so a swipe that starts
 * on a row belongs to the browser (it scrolls the queue) — the hook must leave
 * that touch alone — while a row that HAS lifted must stop the scroll, which only
 * a non-passive touchmove listener on the list (`scrollGuardRef`) can do.
 * Real pointer and touch events, a vertical list of three rows.
 */
describe('useQueueDragReorder — touch: a swipe scrolls, a hold drags', () => {
  const ROWS: DragRect[] = [
    { id: 1, left: 0, right: 300, top: 0, bottom: 80 },
    { id: 2, left: 0, right: 300, top: 88, bottom: 168 },
    { id: 3, left: 0, right: 300, top: 176, bottom: 256 },
  ];

  function ListHarness({ onReorder }: { onReorder: (ids: number[]) => void }) {
    const { draggingId, onPointerDown, scrollGuardRef } = useQueueDragReorder([1, 2, 3], () => ROWS, onReorder);
    return (
      <div data-testid="list" ref={scrollGuardRef}>
        {[1, 2, 3].map((id) => (
          <div
            key={id}
            data-testid={`row-${id}`}
            data-dragging={draggingId === id}
            onPointerDown={(e) => onPointerDown(e, id)}
          >
            row {id}
          </div>
        ))}
      </div>
    );
  }

  /** A finger's move as the browser delivers it: the touchmove (which the browser
   *  will turn into a scroll unless it is cancelled), then the pointermove. */
  function fingerMove(target: Element, x: number, y: number): Event {
    const tm = new Event('touchmove', { bubbles: true, cancelable: true });
    fireEvent(target, tm);
    movePointer(x, y);
    return tm;
  }

  it('a quick swipe on a row leaves the touch to the browser and lifts nothing', () => {
    const onReorder = vi.fn();
    render(<ListHarness onReorder={onReorder} />);
    const row = screen.getByTestId('row-3');
    press(row, 150, 200);
    const moves: Event[] = [];
    act(() => {
      for (let i = 1; i <= 6; i++) moves.push(fingerMove(row, 150, 200 - i * 12));
    });
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    expect(moves.every((m) => !m.defaultPrevented)).toBe(true);
    expect(screen.getByTestId('row-3').dataset.dragging).toBe('false');
    act(() => { release(); });
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('the browser taking the gesture for a scroll (pointercancel) cancels a pending hold', () => {
    const onReorder = vi.fn();
    render(<ListHarness onReorder={onReorder} />);
    press(screen.getByTestId('row-2'), 150, 120);
    act(() => { fireEvent(window, new Event('pointercancel')); });
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    expect(screen.getByTestId('row-2').dataset.dragging).toBe('false');
  });

  it('after a press and hold, the list cancels the touch scroll and the row follows the finger', () => {
    const onReorder = vi.fn();
    render(<ListHarness onReorder={onReorder} />);
    const row = screen.getByTestId('row-3');
    press(row, 150, 200);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(row.dataset.dragging).toBe('true');
    const moves: Event[] = [];
    // Up past the top half of row 1, in steps, as a finger travels.
    act(() => {
      for (let y = 190; y >= 10; y -= 20) moves.push(fingerMove(row, 150, y));
    });
    expect(moves.every((m) => m.defaultPrevented)).toBe(true);
    act(() => { release(); });
    expect(onReorder).toHaveBeenCalledWith([3, 1, 2]);
  });

  it('a touch that drags nowhere after lifting leaves the order alone and stops guarding', () => {
    const onReorder = vi.fn();
    render(<ListHarness onReorder={onReorder} />);
    const row = screen.getByTestId('row-1');
    press(row, 150, 40);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    act(() => { release(); });
    expect(onReorder).not.toHaveBeenCalled();
    // Released: the next swipe scrolls again.
    const tm = new Event('touchmove', { bubbles: true, cancelable: true });
    fireEvent(row, tm);
    expect(tm.defaultPrevented).toBe(false);
  });

  it('a long press does not open the context menu (image / text callout)', () => {
    render(<ListHarness onReorder={vi.fn()} />);
    const row = screen.getByTestId('row-2');
    press(row, 150, 120);
    const menu = new Event('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(row, menu);
    expect(menu.defaultPrevented).toBe(true);
    act(() => { release(); });
    // Not mid-press: a context menu is the browser's business again.
    const later = new Event('contextmenu', { bubbles: true, cancelable: true });
    fireEvent(row, later);
    expect(later.defaultPrevented).toBe(false);
  });
});

describe('edgeScrollStep — auto-scroll near the scroller\'s edges during a touch drag', () => {
  it('is 0 away from both edges', () => {
    expect(edgeScrollStep(300, 100, 600)).toBe(0);
  });
  it('scrolls up near the top and down near the bottom, faster closer to the edge', () => {
    expect(edgeScrollStep(100 + EDGE_PX - 1, 100, 600)).toBeLessThan(0);
    expect(edgeScrollStep(100, 100, 600)).toBeLessThan(edgeScrollStep(100 + EDGE_PX / 2, 100, 600));
    expect(edgeScrollStep(600 - EDGE_PX + 1, 100, 600)).toBeGreaterThan(0);
    expect(edgeScrollStep(600, 100, 600)).toBeGreaterThan(edgeScrollStep(600 - EDGE_PX / 2, 100, 600));
  });
  it('is capped past the edge', () => {
    expect(edgeScrollStep(-500, 100, 600)).toBe(edgeScrollStep(100, 100, 600));
  });
});
