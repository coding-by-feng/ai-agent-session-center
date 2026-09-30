/**
 * The drag GESTURE, exercised with real pointer events in jsdom.
 *
 * roomDragReorder.test.ts covers the geometry in isolation. This covers the
 * state machine around it — same two thresholds as useQueueDragReorder,
 * verified fresh for this hook rather than assumed identical.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, act, fireEvent } from '@testing-library/react';
import { Profiler, useCallback, useRef } from 'react';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  useRoomDragReorder,
  HOLD_MS,
  MOVE_CANCEL_PX,
  SETTLE_MS,
  LIFT_SCALE,
} from './useRoomDragReorder';
import type { RoomDragRect } from '@/lib/roomDragReorder';

/** Three room frames stacked vertically, 40 tall, 10 apart. */
const RECTS: RoomDragRect[] = [
  { id: 'a', top: 0, bottom: 40 },
  { id: 'b', top: 50, bottom: 90 },
  { id: 'c', top: 100, bottom: 140 },
];

function Harness({ onReorder, rects = RECTS, getRects }: {
  onReorder: (ids: string[]) => void;
  rects?: RoomDragRect[];
  getRects?: () => RoomDragRect[];
}) {
  const frames = useRef(new Map<string, HTMLElement>());
  const getFrameEl = useCallback((id: string) => frames.current.get(id), []);
  const drag = useRoomDragReorder(['a', 'b', 'c'], getRects ?? (() => rects), onReorder, getFrameEl);
  return (
    <div>
      {['a', 'b', 'c'].map((id) => (
        <div
          key={id}
          ref={(el) => {
            if (el) frames.current.set(id, el);
            else frames.current.delete(id);
          }}
          data-testid={`room-${id}`}
          data-dragging={drag.draggingId === id}
          data-shift={drag.shifts.get(id) ?? 0}
        >
          <span
            data-testid={`handle-${id}`}
            title="Press and hold, then drag to reorder this room"
            onPointerDown={(e) => drag.onPointerDown(e, id)}
          >
            handle
          </span>
          <button type="button">KILL</button>
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

describe('useRoomDragReorder', () => {
  it('does NOT start a drag before the hold elapses', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS - 50); });
    expect(screen.getByTestId('room-a').dataset.dragging).toBe('false');
  });

  it('lifts the room once the hold elapses', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(screen.getByTestId('room-a').dataset.dragging).toBe('true');
  });

  it('a press on a BUTTON inside the frame never starts a drag', () => {
    // Guards the kill-room button, the collapse chevron, and the ▲/▼ buttons —
    // all live inside the same frame as the handle.
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getAllByRole('button', { name: 'KILL' })[0], 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    expect(screen.getByTestId('room-a').dataset.dragging).toBe('false');
  });

  it('moving before the hold completes cancels it — a rail scroll, not a drag', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { movePointer(20, 20 + MOVE_CANCEL_PX + 5); });
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(screen.getByTestId('room-a').dataset.dragging).toBe('false');
    release();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('reorders when dropped past another room', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    // Bottom half of room c -> insert at the end.
    act(() => { movePointer(20, 135); });
    release();
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('does not fire onReorder when dropped in its own slot', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    act(() => { movePointer(20, 10); }); // top half of room a = index 0 = no-op
    release();
    expect(onReorder).not.toHaveBeenCalled();
  });

  it('clears the lifted state after release', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    act(() => { movePointer(20, 135); });
    act(() => { release(); });
    expect(screen.getByTestId('room-a').dataset.dragging).toBe('false');
    expect(screen.getByTestId('insert').textContent).toBe('null');
  });

  it('clears the handle\'s native title tooltip once dragging starts, restores it on drop', () => {
    // Same fix as useQueueDragReorder's identical gesture shape — a native
    // title tooltip already showing when the hold completes is not reliably
    // dismissed by this gesture's own preventDefault() on pointermove.
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const handle = screen.getByTestId('handle-a');
    press(handle, 20, 20);
    expect(handle.getAttribute('title')).toBe('Press and hold, then drag to reorder this room');
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect(handle.getAttribute('title')).toBe('');
    act(() => { movePointer(20, 135); });
    act(() => { release(); });
    expect(handle.getAttribute('title')).toBe('Press and hold, then drag to reorder this room');
  });

  it('leaves the title untouched when the hold is cancelled before becoming a drag', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const handle = screen.getByTestId('handle-a');
    press(handle, 20, 20);
    act(() => { vi.advanceTimersByTime(100); });
    act(() => { movePointer(20, 20 + MOVE_CANCEL_PX + 5); }); // cancels before hold completes
    expect(handle.getAttribute('title')).toBe('Press and hold, then drag to reorder this room');
  });
});

/**
 * The gesture a MOUSE or TRACKPAD actually produces.
 *
 * Every test above presses with `pointerType: 'touch'` and then holds
 * perfectly still for HOLD_MS before moving — a gesture no hand performs with
 * a pointing device. A trackpad drag has travelled well past MOVE_CANCEL_PX
 * within a frame or two of the press, which the hold-first rule read as a
 * rail scroll and cancelled, silently, every single time.
 */
describe('useRoomDragReorder — mouse/trackpad', () => {
  function pressMouse(el: Element, x: number, y: number) {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: 'mouse' });
  }

  it('reorders on a drag that starts moving immediately, with no hold at all', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    // ~16ms/frame. By frame two the pointer is 14px away — past
    // MOVE_CANCEL_PX — and HOLD_MS is still 300ms from elapsing.
    act(() => { vi.advanceTimersByTime(16); });
    act(() => { movePointer(20, 34); });
    act(() => { vi.advanceTimersByTime(16); });
    act(() => { movePointer(20, 80); });
    act(() => { vi.advanceTimersByTime(16); });
    act(() => { movePointer(20, 130); });
    act(() => { release(); });
    expect(onReorder).toHaveBeenCalledWith(['b', 'c', 'a']);
  });

  it('lifts the room as soon as the mouse moves past the drag threshold', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { movePointer(20, 40); });
    expect(screen.getByTestId('room-a').dataset.dragging).toBe('true');
  });

  it('a click that never moves is still a click, not a drag', () => {
    // Guards the collapse/kill/▲▼ controls: a plain press-and-release on the
    // handle must not commit a phantom reorder.
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS * 2); });
    act(() => { release(); });
    expect(onReorder).not.toHaveBeenCalled();
  });
});

/**
 * The carry preview: what the user SEES while a room is in hand.
 *
 * The lifted room follows the pointer (a CSS variable written straight to its
 * element) while the rooms it has passed slide aside to open the slot it will
 * land in (`shifts`, re-rendered only when the slot changes). On release it
 * settles from where it was carried into that slot.
 */
describe('useRoomDragReorder — carry preview', () => {
  function pressMouse(el: Element, x: number, y: number) {
    fireEvent.pointerDown(el, { clientX: x, clientY: y, button: 0, pointerType: 'mouse' });
  }
  const shiftOf = (id: string) => screen.getByTestId(`room-${id}`).dataset.shift;
  const carryOf = (id: string) => screen.getByTestId(`room-${id}`).style.getPropertyValue('--room-drag-dy');

  /** What `el.animate()` returns — just enough of an Animation for the hook. */
  const fakeAnimation = () => ({ finish: vi.fn(), addEventListener: vi.fn() });

  /** Stub a frame's on-screen box; `box.top` can be moved between reads. */
  function stubBox(el: HTMLElement, box: { top: number; height: number }) {
    el.getBoundingClientRect = () => ({
      top: box.top, bottom: box.top + box.height, height: box.height,
      left: 0, right: 100, width: 100, x: 0, y: box.top,
      toJSON() { return this; },
    }) as DOMRect;
  }

  it('slides only the rooms the carried one has passed, and clears them on drop', () => {
    render(<Harness onReorder={vi.fn()} />);
    press(screen.getByTestId('handle-a'), 20, 20);
    act(() => { vi.advanceTimersByTime(HOLD_MS); });
    expect([shiftOf('a'), shiftOf('b'), shiftOf('c')]).toEqual(['0', '0', '0']);

    act(() => { movePointer(20, 135); }); // bottom half of c → slot 3
    expect([shiftOf('a'), shiftOf('b'), shiftOf('c')]).toEqual(['0', '-50', '-50']);

    act(() => { movePointer(20, 75); }); // bottom half of b → slot 2
    expect([shiftOf('a'), shiftOf('b'), shiftOf('c')]).toEqual(['0', '-50', '0']);

    act(() => { release(); });
    expect([shiftOf('a'), shiftOf('b'), shiftOf('c')]).toEqual(['0', '0', '0']);
  });

  it('carries the lifted room with the pointer, clamped to the rooms\' span', () => {
    render(<Harness onReorder={vi.fn()} />);
    pressMouse(screen.getByTestId('handle-b'), 20, 70);
    act(() => { movePointer(20, 84); });
    expect(carryOf('b')).toBe('14px');
    act(() => { movePointer(20, 30); });
    expect(carryOf('b')).toBe('-40px');
    act(() => { movePointer(20, -500); }); // b's top may rise to a's top, no further
    expect(carryOf('b')).toBe('-50px');
    act(() => { movePointer(20, 900); }); // b's bottom may sink to c's bottom, no further
    expect(carryOf('b')).toBe('50px');
    // Only the carried room moves with the pointer.
    expect(carryOf('a')).toBe('');
    expect(carryOf('c')).toBe('');

    act(() => { release(); });
    expect(carryOf('b')).toBe('');
  });

  it('following the pointer does not re-render on every move — only when the slot changes', () => {
    // The switcher renders every session card; a render per pointermove
    // (60-120 Hz) would re-render all of them for the whole drag.
    let commits = 0;
    render(
      <Profiler id="harness" onRender={() => { commits++; }}>
        <Harness onReorder={vi.fn()} />
      </Profiler>,
    );
    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { movePointer(20, 26); }); // lifts, and indicates slot 1
    const afterLift = commits;

    for (let y = 27; y <= 36; y++) {
      act(() => { movePointer(20, y); }); // ten moves, all still slot 1
    }
    expect(carryOf('a')).toBe('16px');
    expect(commits - afterLift).toBeLessThanOrEqual(1);
  });

  it('settles the dropped room from where it was carried into its new slot', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const frame = screen.getByTestId('room-a');
    const animate = vi.fn(fakeAnimation);
    frame.animate = animate as unknown as HTMLElement['animate'];
    const box = { top: 65, height: 40 }; // carried 65px down: centre at 85
    stubBox(frame, box);

    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { movePointer(20, 85); }); // a's bottom edge at 105, before c's middle → slot 2
    act(() => { release(); });
    expect(onReorder).toHaveBeenCalledWith(['b', 'a', 'c']);

    box.top = 50; // the re-render put it in its new slot: centre at 70
    act(() => { vi.advanceTimersByTime(16); });

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes, options] = animate.mock.calls[0] as unknown as [Keyframe[], KeyframeAnimationOptions];
    expect(keyframes[0].transform).toBe(`translateY(15px) scale(${LIFT_SCALE})`);
    expect(keyframes[keyframes.length - 1].transform).toBe('none');
    expect(options.duration).toBe(SETTLE_MS);
  });

  it('a drop that changes nothing still settles the room back home', () => {
    const onReorder = vi.fn();
    render(<Harness onReorder={onReorder} />);
    const frame = screen.getByTestId('room-a');
    const animate = vi.fn(fakeAnimation);
    frame.animate = animate as unknown as HTMLElement['animate'];
    const box = { top: 12, height: 40 }; // carried 12px down: centre at 32
    stubBox(frame, box);

    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { movePointer(20, 32); }); // bottom half of a → slot 1, a no-op
    act(() => { release(); });
    expect(onReorder).not.toHaveBeenCalled();

    box.top = 0; // back in its own slot: centre at 20
    act(() => { vi.advanceTimersByTime(16); });

    expect(animate).toHaveBeenCalledTimes(1);
    const [keyframes] = animate.mock.calls[0] as unknown as [Keyframe[]];
    expect(keyframes[0].transform).toBe(`translateY(12px) scale(${LIFT_SCALE})`);
  });

  it('a room still sliding when the drop lands glides the rest of the way instead of snapping', () => {
    // A quick flick releases inside the 180ms slide. The drop removes the
    // slide transition in the same render as the commit, so without its own
    // settle the room would jump the remaining distance.
    render(<Harness onReorder={vi.fn()} />);
    const dragged = screen.getByTestId('room-a');
    dragged.animate = vi.fn(fakeAnimation) as unknown as HTMLElement['animate'];
    stubBox(dragged, { top: 90, height: 40 });
    const sliding = screen.getByTestId('room-b');
    const slideAnimate = vi.fn(fakeAnimation);
    sliding.animate = slideAnimate as unknown as HTMLElement['animate'];
    const slidingBox = { top: 25, height: 40 }; // halfway through its -50px slide
    stubBox(sliding, slidingBox);
    const still = screen.getByTestId('room-c');
    const stillAnimate = vi.fn(fakeAnimation);
    still.animate = stillAnimate as unknown as HTMLElement['animate'];
    stubBox(still, { top: 100, height: 40 }); // never moves

    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { movePointer(20, 85); }); // slot 2: b slides up
    act(() => { release(); });
    slidingBox.top = 0; // its committed slot
    act(() => { vi.advanceTimersByTime(16); });

    expect(slideAnimate).toHaveBeenCalledTimes(1);
    const [keyframes] = slideAnimate.mock.calls[0] as unknown as [Keyframe[]];
    expect(keyframes[0].transform).toBe('translateY(25px)'); // no lift scale on a passed room
    expect(keyframes[keyframes.length - 1].transform).toBe('none');
    expect(stillAnimate).not.toHaveBeenCalled();
  });

  it('grabbing a room while a drop is still settling lands the settle before measuring', () => {
    // getBoundingClientRect includes a running animation's transform, so
    // measuring mid-settle would freeze a moving box into every slot and
    // slide of the next drag.
    const events: string[] = [];
    const getRects = () => { events.push('measure'); return RECTS; };
    render(<Harness onReorder={vi.fn()} getRects={getRects} />);
    const frame = screen.getByTestId('room-a');
    const settle = { finish: vi.fn(() => { events.push('finish'); }), addEventListener: vi.fn() };
    frame.animate = vi.fn(() => settle) as unknown as HTMLElement['animate'];
    stubBox(frame, { top: 30, height: 40 });

    pressMouse(screen.getByTestId('handle-a'), 20, 20);
    act(() => { movePointer(20, 50); });
    act(() => { release(); });
    act(() => { vi.advanceTimersByTime(16); }); // the settle starts

    pressMouse(screen.getByTestId('handle-b'), 20, 70);
    act(() => { movePointer(20, 90); }); // lifts b

    expect(events).toEqual(['measure', 'finish', 'measure']);
  });

  it('the drop is aimed by the carried room\'s leading edge, not by the grip under the pointer', () => {
    // Review case: an expanded room above a collapsed one. The grip sits near
    // the top, so 24px of travel leaves the POINTER far above b — but a's
    // bottom edge has crossed b's middle, which is what the user sees.
    const TALL: RoomDragRect[] = [
      { id: 'a', top: 0, bottom: 190 },
      { id: 'b', top: 196, bottom: 230 },
      { id: 'c', top: 236, bottom: 386 },
    ];
    render(<Harness onReorder={vi.fn()} rects={TALL} />);
    pressMouse(screen.getByTestId('handle-a'), 20, 18);
    act(() => { movePointer(20, 40); }); // 22px: bottom edge at 212, b's middle is 213
    expect(screen.getByTestId('insert').textContent).toBe('1');
    act(() => { movePointer(20, 42); }); // 24px: bottom edge at 214
    expect(screen.getByTestId('insert').textContent).toBe('2');
    expect(shiftOf('b')).toBe('-196');
  });

  it('skips the settle animation under prefers-reduced-motion', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query.includes('prefers-reduced-motion: reduce'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;
    try {
      render(<Harness onReorder={vi.fn()} />);
      const frame = screen.getByTestId('room-a');
      const animate = vi.fn();
      frame.animate = animate as unknown as HTMLElement['animate'];
      const box = { top: 90, height: 40 };
      stubBox(frame, box);

      pressMouse(screen.getByTestId('handle-a'), 20, 20);
      act(() => { movePointer(20, 110); });
      act(() => { release(); });
      box.top = 50;
      act(() => { vi.advanceTimersByTime(16); });

      expect(animate).not.toHaveBeenCalled();
    } finally {
      window.matchMedia = original;
    }
  });

  it('the settle starts at the same scale the stylesheet lifts the room to', () => {
    // LIFT_SCALE (JS, the settle's first keyframe) and the lifted rule's
    // `scale:` (CSS) live in files nothing cross-checks. If they drift, every
    // drop starts with a visible pop between the two sizes.
    const css = readFileSync(
      resolve(__dirname, '../styles/modules/DetailPanel.module.css'),
      'utf8',
    );
    const rule = css.match(/\.roomGroupDragging\s*\{[^}]*\}/g)?.find((r) => /\bscale\s*:/.test(r));
    expect(rule, 'lifted .roomGroupDragging rule with a scale').toBeTruthy();
    const value = String(LIFT_SCALE).replace('.', '\\.');
    expect(rule!).toMatch(new RegExp(`\\bscale:\\s*${value};`));
  });
});
