// Found on a real iPhone (Oct 2026): the Project tab's path bar scrolled to its end once, then the
// file's toolbar buttons narrowed it, and the open file's name stayed clipped ("gr" for greet.ts).
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { useRef } from 'react';
import { useKeepEndInView } from './useKeepEndInView';

let resize: (() => void) | null = null;
const observed: Element[] = [];

class FakeResizeObserver {
  constructor(cb: () => void) { resize = cb; }
  observe(el: Element) { observed.push(el); }
  disconnect() { resize = null; }
}

/** An element whose scrollWidth we set and whose scrollLeft writes we record. */
function rig(el: HTMLElement, width: { value: number }, writes: number[]) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, get: () => width.value });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, get: () => writes.at(-1) ?? 0, set: (v: number) => { writes.push(v); } });
}

function Bar({ k, onEl }: { k: string; onEl: (el: HTMLElement) => void }) {
  const ref = useRef<HTMLElement>(null);
  useKeepEndInView(ref, k);
  return <nav ref={(el) => { ref.current = el; if (el) onEl(el); }}><ol><li>{k}</li></ol></nav>;
}

describe('useKeepEndInView', () => {
  beforeEach(() => {
    resize = null;
    observed.length = 0;
    vi.stubGlobal('ResizeObserver', FakeResizeObserver);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('scrolls to the end again when the bar or its content changes size', () => {
    const width = { value: 200 };
    const writes: number[] = [];
    render(<Bar k="a" onEl={(el) => rig(el, width, writes)} />);
    expect(writes.at(-1)).toBe(200);
    expect(observed.map((e) => e.tagName)).toEqual(['NAV', 'OL']);
    width.value = 274;
    resize?.();
    expect(writes.at(-1)).toBe(274);
  });

  it('stops watching once the bar is gone', () => {
    const { unmount } = render(<Bar k="a" onEl={(el) => rig(el, { value: 1 }, [])} />);
    unmount();
    expect(resize).toBeNull();
  });
});
