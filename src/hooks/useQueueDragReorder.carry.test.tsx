/**
 * The List layout's "carry" (Oct 21 2026): a held prompt follows the finger, the
 * prompts it passes slide aside to open the slot it will land in, and the drop is
 * aimed by the carried row's leading edge — the room strip's carry, on the queue.
 * Without `getItemEl` nothing is carried and nothing slides. The Card grid's carry
 * (both ways) is `useQueueDragReorder.cardCarry.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { useRef, type CSSProperties } from 'react';
import { useQueueDragReorder, HOLD_MS, LIFT_SCALE, CARRY_VAR } from './useQueueDragReorder';
import type { DragRect } from '@/lib/queueDragReorder';

/** Three rows stacked, 100 tall, 10 apart: midpoints 50, 160, 270. */
const RECTS: DragRect[] = [
  { id: 1, left: 0, right: 300, top: 0, bottom: 100 },
  { id: 2, left: 0, right: 300, top: 110, bottom: 210 },
  { id: 3, left: 0, right: 300, top: 220, bottom: 320 },
];

function Harness({ onReorder, carry = true, ids = [1, 2, 3] }: { onReorder: (ids: number[]) => void; carry?: boolean; ids?: number[] }) {
  const els = useRef(new Map<number, HTMLElement>());
  const drag = useQueueDragReorder(ids, () => RECTS, onReorder, carry ? (id) => els.current.get(id) : undefined);
  return (
    <div>
      {[1, 2, 3].map((id) => {
        const shift = drag.shifts.get(id);
        return (
          <div
            key={id}
            ref={(el) => { if (el) els.current.set(id, el); }}
            data-testid={`row-${id}`}
            data-dragging={drag.draggingId === id}
            style={shift ? ({ '--queue-shift': `${shift}px` } as CSSProperties) : undefined}
            onPointerDown={(e) => drag.onPointerDown(e, id)}
          >
            row {id}
          </div>
        );
      })}
      <span data-testid="insert">{String(drag.insertIndex)}</span>
    </div>
  );
}

const row = (id: number) => screen.getByTestId(`row-${id}`);
const carried = (id: number) => row(id).style.getPropertyValue(CARRY_VAR);
const shiftOf = (id: number) => row(id).style.getPropertyValue('--queue-shift');

function press(el: Element, y: number) {
  fireEvent.pointerDown(el, { clientX: 150, clientY: y, button: 0, pointerType: 'touch' });
  act(() => { vi.advanceTimersByTime(HOLD_MS); });
}
function moveTo(y: number) {
  act(() => {
    fireEvent(window, new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
      'pointermove', { clientX: 150, clientY: y, bubbles: true, cancelable: true },
    ));
  });
}
function release() {
  act(() => { fireEvent(window, new Event('pointerup', { bubbles: true })); });
}

let vibrate: ReturnType<typeof vi.fn>;
beforeEach(() => {
  vi.useFakeTimers();
  vibrate = vi.fn();
  Object.defineProperty(navigator, 'vibrate', { value: vibrate, configurable: true });
});
afterEach(() => {
  vi.useRealTimers();
  Reflect.deleteProperty(navigator, 'vibrate');
});

describe('useQueueDragReorder — carrying a row in the List layout', () => {
  it('the lifted row follows the finger, and the row it passes slides up into the gap it left', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(row(1), 50);
    moveTo(130); // 80 px down: its bottom edge (180) is past row 2's middle (160)
    expect(carried(1)).toBe('80px');
    expect(screen.getByTestId('insert').textContent).toBe('2');
    expect(shiftOf(2)).toBe('-110px'); // row 1's pitch: its top to row 2's top
    expect(shiftOf(3)).toBe('');
  });

  it('aims by the carried row’s leading edge, not the finger', () => {
    // Held by its very top: the finger (75) is still inside row 1, but the row's
    // bottom (170) has crossed row 2's middle, which is what the user sees.
    render(<Harness onReorder={vi.fn()} />);
    press(row(1), 5);
    moveTo(75);
    expect(screen.getByTestId('insert').textContent).toBe('2');
  });

  it('carried up, the rows it passes slide down to make room', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(row(3), 300); // held near its bottom
    moveTo(230); // 70 px up: its top (150) is above row 2's middle (160)
    expect(carried(3)).toBe('-70px');
    expect(screen.getByTestId('insert').textContent).toBe('1');
    expect(shiftOf(2)).toBe('110px');
    expect(shiftOf(1)).toBe('');
  });

  it('stays within the list: no higher than the first row, no lower than the last', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(row(1), 50);
    moveTo(2000);
    expect(carried(1)).toBe('220px'); // the last row's bottom (320) − its own (100)
    moveTo(-2000);
    expect(carried(1)).toBe('0px');
  });

  it('a drop commits the order and lets go of the carry and the slides', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(row(1), 50);
    moveTo(130);
    release();
    expect(onReorder).toHaveBeenCalledWith([2, 1, 3]);
    expect(carried(1)).toBe('');
    expect(shiftOf(2)).toBe('');
  });

  it('ticks once each time the landing slot changes (touch), besides the buzz on lift', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(row(1), 50);
    expect(vibrate).toHaveBeenCalledTimes(1); // the lift
    moveTo(60); // still its own slot
    expect(vibrate).toHaveBeenCalledTimes(1);
    moveTo(130); // → slot 2
    moveTo(135); // same slot
    expect(vibrate).toHaveBeenCalledTimes(2);
    expect(vibrate).toHaveBeenLastCalledWith(8);
  });

  it('without an element for the rows nothing is carried, nothing slides, nothing buzzes but the lift', () => {
    render(<Harness onReorder={vi.fn()} carry={false} />);
    press(row(1), 50);
    moveTo(200); // the finger past row 2's middle: slot 2
    expect(screen.getByTestId('insert').textContent).toBe('2');
    expect(carried(1)).toBe('');
    expect(shiftOf(2)).toBe('');
    expect(vibrate).toHaveBeenCalledTimes(1);
  });

  it('lands by the row it was shown before, when the queue changed under the drag (a prompt was sent)', () => {
    // Carrying 3 up to just before 2; meanwhile the scheduler sends 1. The old slot number (1)
    // applied to [2, 3] would leave 3 where it was; the drop still lands 3 before 2.
    const onReorder = vi.fn();
    const { rerender } = render(<Harness onReorder={onReorder} />);
    press(row(3), 300);
    moveTo(230);
    rerender(<Harness onReorder={onReorder} ids={[2, 3]} />);
    release();
    expect(onReorder).toHaveBeenCalledWith([3, 2]);
  });

  it('does nothing when the carried prompt itself was sent mid-drag', () => {
    const onReorder = vi.fn();
    const { rerender } = render(<Harness onReorder={onReorder} />);
    press(row(3), 300);
    moveTo(230);
    rerender(<Harness onReorder={onReorder} ids={[1, 2]} />);
    release();
    expect(onReorder).not.toHaveBeenCalled();
  });
});

/** The settle glides the lifted row down from LIFT_SCALE: it must be the CSS's scale, or every drop starts with a pop. */
describe('Terminal.module.css — the carried row', () => {
  it('grows by exactly LIFT_SCALE', () => {
    const css = readFileSync(resolve(__dirname, '../styles/modules/Terminal.module.css'), 'utf8');
    const at = css.indexOf('.queueList.queueListCarry .queueItem.dragging {');
    expect(at).toBeGreaterThan(-1);
    const rule = css.slice(at, css.indexOf('}', at));
    expect(rule).toContain(`scale: ${LIFT_SCALE};`);
    expect(rule).toContain(`translate: 0 var(${CARRY_VAR}, 0px);`);
  });
});
