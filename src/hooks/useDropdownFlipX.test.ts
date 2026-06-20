import { describe, it, expect, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';
import { useDropdownFlipX } from './useDropdownFlipX';

/** Build a detached element whose getBoundingClientRect reports a fixed box. */
function makeMenu(left: number, right: number): HTMLDivElement {
  const el = document.createElement('div');
  el.getBoundingClientRect = () =>
    ({
      left,
      right,
      top: 0,
      bottom: 0,
      width: right - left,
      height: 0,
      x: left,
      y: 0,
      toJSON() {},
    }) as DOMRect;
  return el;
}

describe('useDropdownFlipX', () => {
  beforeEach(() => {
    // jsdom defaults to 1024, but pin it so the assertions are explicit.
    Object.defineProperty(window, 'innerWidth', {
      value: 1024,
      configurable: true,
      writable: true,
    });
  });

  it('applies no transform while the dropdown is closed', () => {
    const ref = { current: makeMenu(-50, 100) };
    renderHook(({ open }) => useDropdownFlipX(open, ref), {
      initialProps: { open: false },
    });
    expect(ref.current.style.transform).toBe('');
  });

  it('applies no transform when the menu sits fully inside the viewport', () => {
    const ref = { current: makeMenu(100, 300) };
    renderHook(({ open }) => useDropdownFlipX(open, ref), {
      initialProps: { open: true },
    });
    expect(ref.current.style.transform).toBe('');
  });

  it('pushes the menu right when it overflows the left edge', () => {
    // left = -40 → dx = VIEWPORT_PAD(8) - (-40) = 48
    const ref = { current: makeMenu(-40, 120) };
    renderHook(({ open }) => useDropdownFlipX(open, ref), {
      initialProps: { open: true },
    });
    expect(ref.current.style.transform).toBe('translateX(48px)');
  });

  it('pulls the menu left when it overflows the right edge', () => {
    // right = 1100, innerWidth 1024 → dx = (1024 - 8) - 1100 = -84
    const ref = { current: makeMenu(900, 1100) };
    renderHook(({ open }) => useDropdownFlipX(open, ref), {
      initialProps: { open: true },
    });
    expect(ref.current.style.transform).toBe('translateX(-84px)');
  });

  it('clears the correction when the dropdown closes again', () => {
    const ref = { current: makeMenu(-40, 120) };
    const { rerender } = renderHook(
      ({ open }) => useDropdownFlipX(open, ref),
      { initialProps: { open: true } },
    );
    expect(ref.current.style.transform).toBe('translateX(48px)');
    rerender({ open: false });
    expect(ref.current.style.transform).toBe('');
  });

  it('prioritises the left edge when the menu is wider than the viewport', () => {
    // Overflows both edges; left correction wins so the menu's start stays visible.
    const ref = { current: makeMenu(-30, 1200) };
    renderHook(({ open }) => useDropdownFlipX(open, ref), {
      initialProps: { open: true },
    });
    expect(ref.current.style.transform).toBe('translateX(38px)');
  });
});
