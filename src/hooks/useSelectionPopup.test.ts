import { renderHook, act } from '@testing-library/react';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { useSelectionPopup } from './useSelectionPopup';
import type { ExtractedSelection } from '@/lib/selectionExtractors';

const SEL: ExtractedSelection = {
  selection: 'bounced',
  contextLine: 'Down never bounced to the target',
  anchor: { x: 0, y: 0, right: 0, bottom: 0 },
};

function dispatchMouse(
  type: string,
  el: Element,
  { x = 0, y = 0, detail = 1 }: { x?: number; y?: number; detail?: number } = {},
): void {
  el.dispatchEvent(new MouseEvent(type, { bubbles: true, clientX: x, clientY: y, detail }));
}

describe('useSelectionPopup', () => {
  let container: HTMLDivElement;

  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    // Run the deferred extract synchronously so we can assert without waiting.
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => {
      cb(0);
      return 0;
    });
  });

  afterEach(() => {
    container.remove();
    vi.unstubAllGlobals();
  });

  function setup(extract = vi.fn((): ExtractedSelection | null => SEL)) {
    const containerRef = { current: container };
    const hook = renderHook(() =>
      useSelectionPopup({ enabled: true, trigger: 'auto', containerRef, extract }),
    );
    return { hook, extract };
  }

  it('does NOT open on a plain click, even when a stale selection is present', () => {
    // The reported bug: clicking into the terminal input re-opened the modes
    // popup because xterm still reported the earlier "bounced" selection.
    const { hook, extract } = setup();
    act(() => {
      dispatchMouse('mousedown', container, { x: 10, y: 10 });
      dispatchMouse('mouseup', container, { x: 10, y: 10, detail: 1 });
    });
    expect(extract).not.toHaveBeenCalled();
    expect(hook.result.current.active).toBeNull();
  });

  it('opens on a drag-select (pointer moved past the threshold)', () => {
    const { hook, extract } = setup();
    act(() => {
      dispatchMouse('mousedown', container, { x: 10, y: 10 });
      dispatchMouse('mouseup', container, { x: 120, y: 80, detail: 1 });
    });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(hook.result.current.active).toEqual(SEL);
  });

  it('opens on a double-click word select (no drag, detail >= 2)', () => {
    const { hook, extract } = setup();
    act(() => {
      dispatchMouse('mousedown', container, { x: 10, y: 10 });
      dispatchMouse('mouseup', container, { x: 11, y: 10, detail: 2 });
    });
    expect(extract).toHaveBeenCalledTimes(1);
    expect(hook.result.current.active).toEqual(SEL);
  });

  it('ignores interactions on an editable field (the input frame)', () => {
    const textarea = document.createElement('textarea');
    container.appendChild(textarea);
    const { hook, extract } = setup();
    act(() => {
      dispatchMouse('mousedown', textarea, { x: 10, y: 10 });
      // Even a drag inside a textarea must not open the popup.
      dispatchMouse('mouseup', textarea, { x: 120, y: 80, detail: 1 });
    });
    expect(extract).not.toHaveBeenCalled();
    expect(hook.result.current.active).toBeNull();
  });
});
