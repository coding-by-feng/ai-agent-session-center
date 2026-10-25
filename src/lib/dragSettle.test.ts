/**
 * The drop glide (`settleInto`): every element that moved goes from where it was
 * drawn at the drop into its new place. Rows and rooms only ever move up or down;
 * a queue card (Oct 22 2026) also moves sideways, across a wrapping grid.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { dropPoses, settleInto } from './dragSettle';

/** What `el.animate()` returns — just enough of an Animation for the settle. */
const fakeAnimation = () => ({ finish: vi.fn(), addEventListener: vi.fn() });

/** An element whose on-screen box (100×40) can be moved between reads. */
function element(box: { left: number; top: number }) {
  const el = document.createElement('div');
  document.body.append(el);
  el.getBoundingClientRect = () => ({
    left: box.left, top: box.top, right: box.left + 100, bottom: box.top + 40,
    width: 100, height: 40, x: box.left, y: box.top,
    toJSON() { return this; },
  }) as DOMRect;
  const animate = vi.fn(fakeAnimation);
  el.animate = animate as unknown as HTMLElement['animate'];
  return { el, animate };
}

const firstTransform = (animate: ReturnType<typeof vi.fn>) =>
  (animate.mock.calls[0][0] as Keyframe[])[0].transform;

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe('settleInto', () => {
  it('glides a row that only moved up or down on translateY, as it always has', () => {
    const box = { left: 0, top: 60 };
    const { el, animate } = element(box);
    const poses = dropPoses([{ el, lifted: false }]);
    box.top = 0; // the commit put it 60px higher
    settleInto(poses, new Set(), { durationMs: 150, liftScale: 1.02 });
    vi.advanceTimersByTime(16);
    expect(firstTransform(animate)).toBe('translateY(60px)');
  });

  it('glides a card that also moved sideways on both axes, the carried one from its lift scale', () => {
    const box = { left: 110, top: 0 };
    const { el, animate } = element(box);
    const poses = dropPoses([{ el, lifted: true }]);
    box.left = 0; // the commit put it a cell left, a row down
    box.top = 90;
    settleInto(poses, new Set(), { durationMs: 150, liftScale: 1.02 });
    vi.advanceTimersByTime(16);
    expect(firstTransform(animate)).toBe('translate(110px, -90px) scale(1.02)');
  });

  it('leaves alone one that neither moved nor was carried', () => {
    const { el, animate } = element({ left: 40, top: 40 });
    settleInto(dropPoses([{ el, lifted: false }]), new Set(), { durationMs: 150, liftScale: 1.02 });
    vi.advanceTimersByTime(16);
    expect(animate).not.toHaveBeenCalled();
  });
});
