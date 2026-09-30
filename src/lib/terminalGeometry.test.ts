import { describe, it, expect } from 'vitest';
import {
  resolveRenderCols,
  mayDrivePtyGeometry,
  defaultWidthMode,
  isUsablePtyCols,
  MIN_PTY_COLS,
  MAX_PTY_COLS,
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
