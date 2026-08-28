import { describe, it, expect, vi, afterEach } from 'vitest';
import { isSaneGeometry, MIN_SANE_COLS, verifySettled } from './useTerminal';
import type { Terminal } from '@xterm/xterm';
import type { FitAddon } from '@xterm/addon-fit';

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

// Regression cover for the SAME bug's harder-to-catch variant: a measurement
// that is non-zero (clears MIN_SANE_COLS easily, e.g. 30 cols) but was taken
// mid-reflow right after an attach/remount — e.g. DetailTabs' split/stacked
// toggle moving the terminal to a new JSX parent — and isn't the container's
// real, settled size. isSaneGeometry can't tell this apart from a genuinely
// narrow terminal by value alone; verifySettled is the guard that can, by
// comparing two readings a frame apart.
describe('verifySettled — transitional-measurement PTY guard', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function mkContainer(width: number, height: number): HTMLElement {
    return { offsetWidth: width, offsetHeight: height } as unknown as HTMLElement;
  }

  it('calls onSettled when a second reading one frame later agrees with the first', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    const term = { cols: 80, rows: 24 } as unknown as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon; // no-op: cols/rows stay put
    const container = mkContainer(560, 300);
    const onSettled = vi.fn();

    verifySettled(term, fitAddon, container, 80, 24, onSettled);

    expect(fitAddon.fit).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(80, 24);
  });

  it('does NOT call onSettled when the second reading disagrees (still mid-reflow)', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    // Simulates the exact corrupting case: the container widened between the
    // two measurements (30 -> 80 cols), so the FIRST reading (what a naive
    // fit()+send would have used) was transitional, not final. Mutated via
    // termData (untyped) rather than the Terminal-cast `term` alias — the
    // real Terminal.cols is a readonly getter, so `term.cols = 80` doesn't
    // typecheck even though this mock is a plain mutable object at runtime.
    const termData = { cols: 30, rows: 24 };
    const term = termData as unknown as Terminal;
    const fitAddon = { fit: vi.fn(() => { termData.cols = 80; }) } as unknown as FitAddon;
    const container = mkContainer(560, 300);
    const onSettled = vi.fn();

    verifySettled(term, fitAddon, container, 30, 24, onSettled);

    expect(onSettled).not.toHaveBeenCalled();
  });

  it('does NOT call onSettled, and never re-fits, when the container is hidden at re-check time', () => {
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => { cb(0); return 0; });
    const term = { cols: 30, rows: 24 } as unknown as Terminal;
    const fitAddon = { fit: vi.fn() } as unknown as FitAddon;
    const container = mkContainer(0, 0); // e.g. tab became display:none again
    const onSettled = vi.fn();

    verifySettled(term, fitAddon, container, 30, 24, onSettled);

    expect(fitAddon.fit).not.toHaveBeenCalled();
    expect(onSettled).not.toHaveBeenCalled();
  });
});
