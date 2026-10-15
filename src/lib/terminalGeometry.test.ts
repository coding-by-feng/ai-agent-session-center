import { describe, it, expect } from 'vitest';
import {
  resolveRenderCols,
  mayDrivePtyGeometry,
  defaultWidthMode,
  isUsablePtyCols,
  MIN_PTY_COLS,
  MAX_PTY_COLS,
  FIT_MIN_FONT_PX,
  TEXT_SIZES,
  fitFontSize,
  resolveFit,
  stepTextSize,
} from './terminalGeometry';

// The real numbers from the reported case: a 120-column PTY viewed on a phone
// that fits ~49 columns.
const PTY = 120;
const PHONE_FIT = 49;

describe('mayDrivePtyGeometry', () => {
  it('lets a desktop drive the PTY', () => {
    expect(mayDrivePtyGeometry(false)).toBe(true);
  });

  it('NEVER lets a phone drive the PTY', () => {
    // The whole point: a phone resize hard-wraps every device's scrollback
    // permanently. This must hold even though the phone can hold the baton.
    expect(mayDrivePtyGeometry(true)).toBe(false);
  });
});

describe('defaultWidthMode', () => {
  it('pans on a phone so layout survives', () => {
    expect(defaultWidthMode(true)).toBe('pan');
  });

  it('keeps the pre-existing fit behavior elsewhere', () => {
    expect(defaultWidthMode(false)).toBe('wrap');
  });
});

describe('isUsablePtyCols', () => {
  it('accepts a real PTY width', () => {
    expect(isUsablePtyCols(PTY)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['NaN', NaN],
    ['Infinity', Infinity],
    ['zero', 0],
    ['negative', -80],
    ['below MIN', MIN_PTY_COLS - 1],
    ['above MAX', MAX_PTY_COLS + 1],
  ])('rejects %s', (_label, value) => {
    expect(isUsablePtyCols(value as number | null | undefined)).toBe(false);
  });

  it('accepts the exact bounds', () => {
    expect(isUsablePtyCols(MIN_PTY_COLS)).toBe(true);
    expect(isUsablePtyCols(MAX_PTY_COLS)).toBe(true);
  });
});

describe('resolveRenderCols', () => {
  it('pans at the PTY width so nothing wraps', () => {
    // The fix for the reported bug: render 120, not 49, and let the container
    // scroll. 49 is what produced "--oneli" / "ne --decorate".
    expect(resolveRenderCols('pan', PHONE_FIT, PTY)).toBe(PTY);
  });

  it('wraps at the fitted width when asked to', () => {
    expect(resolveRenderCols('wrap', PHONE_FIT, PTY)).toBe(PHONE_FIT);
  });

  it('ignores the PTY width entirely in wrap mode', () => {
    // Wrap must stay purely local — reading ptyCols here would reintroduce
    // horizontal overflow in the mode chosen specifically to avoid it.
    expect(resolveRenderCols('wrap', PHONE_FIT, 500)).toBe(PHONE_FIT);
  });

  it.each([
    ['unknown', null],
    ['not yet received', undefined],
    ['implausible', 9999],
    ['collapsed', 0],
  ])('falls back to the fitted width when the PTY width is %s', (_l, value) => {
    // Falling back reproduces the pre-panning behavior, which is safe.
    expect(resolveRenderCols('pan', PHONE_FIT, value as number | null)).toBe(PHONE_FIT);
  });

  it('never renders narrower than the container', () => {
    // A PTY narrower than the viewport has nothing to pan to; pinning to it
    // would leave dead space to the right of the content.
    expect(resolveRenderCols('pan', 200, 80)).toBe(200);
  });

  it('is a pure function of its arguments', () => {
    const a = resolveRenderCols('pan', PHONE_FIT, PTY);
    const b = resolveRenderCols('pan', PHONE_FIT, PTY);
    expect(a).toBe(b);
  });
});

// ---------------------------------------------------------------------------
// Fit (AASC-45): the font shrinks so the PTY's real columns fit the width.
// ---------------------------------------------------------------------------

describe('resolveRenderCols in fit mode', () => {
  it('renders at the PTY width, as pan does (the font is what shrinks)', () => {
    expect(resolveRenderCols('fit', PHONE_FIT, PTY)).toBe(PTY);
  });

  it('falls back to the fitted width when the PTY width is unknown', () => {
    expect(resolveRenderCols('fit', PHONE_FIT, null)).toBe(PHONE_FIT);
  });
});

describe('fitFontSize', () => {
  // A phone in landscape (844 px) showing a 160-column PTY in a face whose
  // glyph is 0.6 px wide per px of font: 844 / (160 × 0.6) = 8.79 px.
  it('shrinks the font so every PTY column fits, rounded down to a quarter pixel', () => {
    expect(fitFontSize(844, 160, 0.6, 11)).toBe(8.75);
  });

  it('never grows the text past the reading size', () => {
    expect(fitFontSize(844, 80, 0.6, 11)).toBe(11);
  });

  it(`is null below the ${FIT_MIN_FONT_PX} px floor: the caller pans instead`, () => {
    // Portrait, 390 px for 160 columns: 4.06 px would be unreadable.
    expect(fitFontSize(390, 160, 0.6, 11)).toBeNull();
  });

  it('accepts exactly the floor', () => {
    expect(fitFontSize(FIT_MIN_FONT_PX * 0.6 * 100, 100, 0.6, 11)).toBe(FIT_MIN_FONT_PX);
  });

  it.each([
    ['no width', 0, 120, 0.6],
    ['an unusable PTY width', 844, 9999, 0.6],
    ['an unmeasured glyph', 844, 120, 0],
    ['a non-finite width', Number.NaN, 120, 0.6],
  ])('is null with %s', (_label, width, cols, glyph) => {
    expect(fitFontSize(width, cols, glyph, 11)).toBeNull();
  });
});

describe('resolveFit', () => {
  it('fits when the font can shrink far enough', () => {
    expect(resolveFit(844, 160, 0.6, 11)).toEqual({ fontSize: 8.75, fitted: true });
  });

  it('pans at the reading size when it cannot', () => {
    expect(resolveFit(390, 160, 0.6, 11)).toEqual({ fontSize: 11, fitted: false });
  });

  it('pans at the reading size while the PTY width is unknown', () => {
    expect(resolveFit(844, null, 0.6, 11)).toEqual({ fontSize: 11, fitted: false });
  });
});

describe('stepTextSize', () => {
  it('steps through the text sizes', () => {
    expect(stepTextSize(11, 1)).toBe(12);
    expect(stepTextSize(11, -1)).toBe(10);
  });

  it('stops at either end', () => {
    expect(stepTextSize(TEXT_SIZES[0], -1)).toBe(TEXT_SIZES[0]);
    expect(stepTextSize(TEXT_SIZES[TEXT_SIZES.length - 1], 1)).toBe(TEXT_SIZES[TEXT_SIZES.length - 1]);
  });

  it('moves from a size between steps to the next step that way', () => {
    expect(stepTextSize(8.75, 1)).toBe(9);
    expect(stepTextSize(8.75, -1)).toBe(8);
  });
});

describe('a phone and the PTY in fit mode', () => {
  it('fit changes the local font only: no phone, in either orientation, drives the PTY', () => {
    // The phone app in landscape is wider than the mobile breakpoint (isMobile false)
    // and is exactly where Fit is used most.
    expect(mayDrivePtyGeometry(true)).toBe(false);
    expect(mayDrivePtyGeometry(false, true)).toBe(false);
    expect(mayDrivePtyGeometry(true, true)).toBe(false);
  });
});
