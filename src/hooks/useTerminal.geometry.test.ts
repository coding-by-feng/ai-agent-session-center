import { describe, it, expect } from 'vitest';
import { isSaneGeometry, MIN_SANE_COLS } from './useTerminal';

// Regression cover for the narrow-column terminal bug: fitAddon.fit() measures
// ~0 when its container is hidden/collapsed (display:none tab, panel mid-mount,
// pop-out before first paint). Sending that tiny `cols` to the PTY is permanent
// damage — Claude Code wraps its own output to process.stdout.columns with hard
// newlines that xterm can never re-flow — so sendResize must reject it.
describe('isSaneGeometry — narrow-column PTY guard', () => {
  it('accepts a normal terminal size', () => {
    expect(isSaneGeometry(80, 24)).toBe(true);
    expect(isSaneGeometry(200, 50)).toBe(true);
  });

  it('accepts exactly the minimum width', () => {
    expect(isSaneGeometry(MIN_SANE_COLS, 1)).toBe(true);
  });

  it('rejects a collapsed-container measurement (cols ~0)', () => {
    expect(isSaneGeometry(0, 0)).toBe(false);
    expect(isSaneGeometry(2, 1)).toBe(false);
    expect(isSaneGeometry(MIN_SANE_COLS - 1, 24)).toBe(false);
  });

  it('rejects a zero/negative row count even when cols look fine', () => {
    expect(isSaneGeometry(120, 0)).toBe(false);
    expect(isSaneGeometry(120, -1)).toBe(false);
  });

  it('rejects non-finite measurements', () => {
    expect(isSaneGeometry(Number.NaN, 24)).toBe(false);
    expect(isSaneGeometry(120, Number.NaN)).toBe(false);
    expect(isSaneGeometry(Number.POSITIVE_INFINITY, 24)).toBe(false);
  });
});
