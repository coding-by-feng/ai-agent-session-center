import { describe, it, expect } from 'vitest';
import { CLIP_TOLERANCE_PX, FRACTION_TOLERANCE_PX, isTextClipped } from './textClip';

const metrics = (over: Partial<Parameters<typeof isTextClipped>[0]> = {}) => ({
  scrollWidth: 200,
  clientWidth: 200,
  scrollHeight: 20,
  clientHeight: 20,
  ...over,
});

describe('isTextClipped', () => {
  it('is false when the text fits', () => {
    expect(isTextClipped(metrics())).toBe(false);
  });

  it('sees a single-line ellipsis: the text is wider than its box', () => {
    expect(isTextClipped(metrics({ scrollWidth: 480, clientWidth: 200 }))).toBe(true);
  });

  it('sees a line clamp: the text is taller than its box', () => {
    expect(isTextClipped(metrics({ scrollHeight: 96, clientHeight: 48 }))).toBe(true);
  });

  it('either axis is enough, and the other is not consulted', () => {
    expect(isTextClipped(metrics({ scrollWidth: 480 }))).toBe(true);
    expect(isTextClipped(metrics({ scrollHeight: 96 }))).toBe(true);
  });

  it('ignores sub-pixel rounding but not a real overflow', () => {
    expect(CLIP_TOLERANCE_PX).toBe(1);
    expect(isTextClipped(metrics({ scrollWidth: 200 + CLIP_TOLERANCE_PX }))).toBe(false);
    expect(isTextClipped(metrics({ scrollWidth: 200 + CLIP_TOLERANCE_PX + 1 }))).toBe(true);
    expect(isTextClipped(metrics({ scrollHeight: 20 + CLIP_TOLERANCE_PX }))).toBe(false);
    expect(isTextClipped(metrics({ scrollHeight: 20 + CLIP_TOLERANCE_PX + 1 }))).toBe(true);
  });

  it('is false for an element that is not laid out (display:none, detached): every metric is 0', () => {
    expect(isTextClipped(metrics({ scrollWidth: 0, clientWidth: 0, scrollHeight: 0, clientHeight: 0 }))).toBe(false);
  });
});

/**
 * `scrollWidth` and `clientWidth` are whole pixels, each rounded on its own, so a text that overflows its
 * box by less than a pixel can read "equal" — while the ellipsis still hides characters. The fractional
 * widths (a Range over the text, the box's own rect) see it.
 */
describe('isTextClipped — fractional widths', () => {
  it('sees a sliver of overflow that the whole-pixel metrics round away', () => {
    // scrollWidth 383 === clientWidth 383, yet the text is 383.48 wide in a 383.0 box: an ellipsis shows.
    expect(isTextClipped(metrics({ scrollWidth: 383, clientWidth: 383, contentWidth: 383.48, boxWidth: 383 }))).toBe(true);
  });

  it('ignores layout noise below the tolerance', () => {
    expect(FRACTION_TOLERANCE_PX).toBe(0.1);
    // Binary fractions (1/16 and 1/8, a browser lays out in 1/64 px): exactly representable, so the
    // subtraction is exact. `383 + 0.1 - 383` is 0.10000000000002…, which would test float rounding at the
    // boundary rather than the rule — and no measurement ever lands there.
    expect(isTextClipped(metrics({ contentWidth: 383.0625, boxWidth: 383 }))).toBe(false);
    expect(isTextClipped(metrics({ contentWidth: 383.125, boxWidth: 383 }))).toBe(true);
  });

  it('text narrower than its box is not clipped', () => {
    expect(isTextClipped(metrics({ contentWidth: 300.2, boxWidth: 383 }))).toBe(false);
  });

  it('is not consulted for an element that is not laid out (box width 0)', () => {
    expect(isTextClipped(metrics({ contentWidth: 120, boxWidth: 0 }))).toBe(false);
  });

  it('needs both fractional widths: one alone says nothing', () => {
    expect(isTextClipped(metrics({ contentWidth: 999 }))).toBe(false);
    expect(isTextClipped(metrics({ boxWidth: 1 }))).toBe(false);
  });

  it('does not stop the whole-pixel checks from answering when the fractional widths agree', () => {
    expect(isTextClipped(metrics({ scrollWidth: 480, clientWidth: 200, contentWidth: 200, boxWidth: 200 }))).toBe(true);
  });
});
