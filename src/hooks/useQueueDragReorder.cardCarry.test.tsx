/**
 * The Card grid's carry (Oct 22 2026): a held card follows the pointer both ways,
 * the cards it passes step one cell toward its old place (the last card of a row
 * wraps to the next row, and back), and it lands in the place of the card whose
 * centre is nearest its own. The List's carry is `useQueueDragReorder.carry.test.tsx`.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { useRef, type CSSProperties } from 'react';
import { useQueueDragReorder, LIFT_SCALE, CARRY_VAR, CARRY_X_VAR } from './useQueueDragReorder';
import type { DragRect } from '@/lib/queueDragReorder';

/** Three columns of 100×80 cards, 10 apart, the second row one card short.
 *  Centres: 1 (50,40) 2 (160,40) 3 (270,40) / 4 (50,130) 5 (160,130). */
const GRID: DragRect[] = [
  { id: 1, left: 0, right: 100, top: 0, bottom: 80 },
  { id: 2, left: 110, right: 210, top: 0, bottom: 80 },
  { id: 3, left: 220, right: 320, top: 0, bottom: 80 },
  { id: 4, left: 0, right: 100, top: 90, bottom: 170 },
  { id: 5, left: 110, right: 210, top: 90, bottom: 170 },
];

function Harness({ onReorder, rects = GRID }: { onReorder: (ids: number[]) => void; rects?: DragRect[] }) {
  const els = useRef(new Map<number, HTMLElement>());
  const ids = rects.map((r) => r.id);
  const drag = useQueueDragReorder(ids, () => rects, onReorder, (id) => els.current.get(id), 'card');
  return (
    <div>
      {ids.map((id) => {
        const shift = drag.cardShifts.get(id);
        return (
          <div
            key={id}
            ref={(el) => { if (el) els.current.set(id, el); }}
            data-testid={`card-${id}`}
            style={shift ? ({ '--queue-shift-x': `${shift.x}px`, '--queue-shift-y': `${shift.y}px` } as CSSProperties) : undefined}
            onPointerDown={(e) => drag.onPointerDown(e, id)}
          >
            card {id}
          </div>
        );
      })}
      <span data-testid="insert">{String(drag.insertIndex)}</span>
      <span data-testid="list-shifts">{drag.shifts.size}</span>
    </div>
  );
}

const card = (id: number) => screen.getByTestId(`card-${id}`);
const carried = (id: number) => [card(id).style.getPropertyValue(CARRY_X_VAR), card(id).style.getPropertyValue(CARRY_VAR)];
const shiftOf = (id: number) => [card(id).style.getPropertyValue('--queue-shift-x'), card(id).style.getPropertyValue('--queue-shift-y')];
const insert = () => screen.getByTestId('insert').textContent;

/** A mouse press: moving it past 8 px lifts the card at once (no hold). */
function press(el: Element, x: number, y: number) {
  fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: 'mouse' });
}
function moveTo(x: number, y: number) {
  act(() => {
    fireEvent(window, new (window as unknown as { PointerEvent: typeof MouseEvent }).PointerEvent(
      'pointermove', { clientX: x, clientY: y, bubbles: true, cancelable: true },
    ));
  });
}
function release() {
  act(() => { fireEvent(window, new Event('pointerup', { bubbles: true })); });
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('useQueueDragReorder — carrying a card in the Card grid', () => {
  it('follows the pointer, and the card it passes steps back into the cell it left', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(card(1), 50, 40);
    moveTo(116, 40); // its centre is now nearer 2's than its own
    expect(carried(1)).toEqual(['66px', '0px']);
    expect(insert()).toBe('2');
    expect(shiftOf(2)).toEqual(['-110px', '0px']);
    expect(shiftOf(3)).toEqual(['', '']);
    expect(screen.getByTestId('list-shifts').textContent).toBe('0'); // the List's vertical slides stay empty
  });

  it('carried onto the next row, the first card there wraps up to the end of the row above', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(card(3), 270, 40);
    moveTo(50, 130); // onto 4
    expect(carried(3)).toEqual(['-220px', '90px']);
    expect(insert()).toBe('4');
    expect(shiftOf(4)).toEqual(['220px', '-90px']);
  });

  it('carried up a row, the cards it passes step forward, the last of a row down to the next', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(card(5), 160, 130);
    moveTo(160, 40); // onto 2
    expect(insert()).toBe('1');
    expect(shiftOf(2)).toEqual(['110px', '0px']);
    expect(shiftOf(3)).toEqual(['-220px', '90px']);
    expect(shiftOf(4)).toEqual(['110px', '0px']);
    expect(shiftOf(1)).toEqual(['', '']);
  });

  it('dropped into the empty cell after the last card, it goes to the end', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(card(1), 50, 40);
    moveTo(270, 130);
    release();
    expect(onReorder).toHaveBeenCalledWith([2, 3, 4, 5, 1]);
  });

  it('is drawn over the cards only, however far the pointer goes', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(card(1), 50, 40);
    moveTo(2000, 2000);
    expect(carried(1)).toEqual(['220px', '90px']);
    moveTo(-2000, -2000);
    expect(carried(1)).toEqual(['0px', '0px']);
  });

  it('aims where the pointer took it, not where it is drawn: a tall expanded card still reaches the last row', () => {
    // An expanded card 400 tall beside a short one; the next row below both. Its
    // drawing stops 90 px down, where its centre is still nearer its own place.
    const tall: DragRect[] = [
      { id: 1, left: 0, right: 100, top: 0, bottom: 400 },
      { id: 2, left: 110, right: 210, top: 0, bottom: 80 },
      { id: 3, left: 0, right: 100, top: 410, bottom: 490 },
      { id: 4, left: 110, right: 210, top: 410, bottom: 490 },
    ];
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} rects={tall} />);
    press(card(1), 50, 200);
    moveTo(50, 450);
    expect(carried(1)).toEqual(['0px', '90px']);
    expect(insert()).toBe('3');
    release();
    expect(onReorder).toHaveBeenCalledWith([2, 3, 1, 4]);
  });

  it('one column of cards (a narrow panel) stacks like List rows: the passed cards slide by the carried card’s height', () => {
    // Moving each card into the cell above would leave 2 at 0 and 3 at 110, but
    // after the drop 3 sits at 70 (it follows 2, which is 60 tall): cells only
    // hold in rows of equal height, which a column of cards is not.
    const column: DragRect[] = [
      { id: 1, left: 0, right: 300, top: 0, bottom: 100 },
      { id: 2, left: 0, right: 300, top: 110, bottom: 170 },
      { id: 3, left: 0, right: 300, top: 180, bottom: 240 },
    ];
    render(<Harness onReorder={vi.fn()} rects={column} />);
    press(card(1), 150, 50);
    moveTo(150, 200); // its bottom edge past 3's middle: the end
    expect(insert()).toBe('3');
    expect(shiftOf(2)).toEqual(['0px', '-110px']);
    expect(shiftOf(3)).toEqual(['0px', '-110px']);
    expect(carried(1)).toEqual(['', '140px']); // up and down only
  });

  it('a drop commits the order and lets go of the carry and the shifts', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(card(3), 270, 40);
    moveTo(50, 130);
    release();
    expect(onReorder).toHaveBeenCalledWith([1, 2, 4, 3, 5]);
    expect(carried(3)).toEqual(['', '']);
    expect(shiftOf(4)).toEqual(['', '']);
    expect(insert()).toBe('null');
  });
});

/** The settle glides the lifted card down from LIFT_SCALE: it must be the CSS's scale, or every drop starts with a pop. */
describe('Terminal.module.css — the carried card', () => {
  const css = readFileSync(resolve(__dirname, '../styles/modules/Terminal.module.css'), 'utf8');
  const rule = (selector: string) => {
    const at = css.indexOf(`${selector} {`);
    expect(at).toBeGreaterThan(-1);
    return css.slice(at, css.indexOf('}', at));
  };

  it('grows by exactly LIFT_SCALE and follows both carry variables', () => {
    const carriedRule = rule('.queueCardGrid.queueCardGridCarry .queueCard.dragging');
    expect(carriedRule).toContain(`scale: ${LIFT_SCALE};`);
    expect(carriedRule).toContain(`translate: var(${CARRY_X_VAR}, 0px) var(${CARRY_VAR}, 0px);`);
  });

  it('slides the passed cards by both shift variables', () => {
    expect(rule('.queueCardGrid.queueCardGridCarry .queueCard')).toContain(
      'translate: var(--queue-shift-x, 0px) var(--queue-shift-y, 0px);',
    );
  });
});
