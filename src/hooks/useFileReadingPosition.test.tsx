import { useRef } from 'react';
import { render, act, cleanup } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useFileReadingPosition } from './useFileReadingPosition';
import { readScrollPosition, readPdfPosition, writePositionValue } from '@/lib/fileReadingPosition';

let height = 300;
let resized: () => void;
function Preview({ id, ready = true }: { id: string; ready?: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  useFileReadingPosition(ref, id, ready);
  return <div ref={ref} data-testid="preview" />;
}
beforeEach(() => {
  height = 300;
  vi.useFakeTimers();
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(() => height);
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(cb: () => void) {
        resized = cb;
      }
      observe() {}
      disconnect() {}
    },
  );
  vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 16));
  vi.stubGlobal('cancelAnimationFrame', clearTimeout);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settle = () =>
  act(() => {
    vi.advanceTimersByTime(20);
  });
function scroll(el: HTMLElement, top: number, left = 0) {
  act(() => {
    el.scrollTop = top;
    el.scrollLeft = left;
    el.dispatchEvent(new Event('scroll'));
  });
}

describe('file reading position', () => {
  it('restores legacy offsets and keeps both axes through remounts', () => {
    localStorage.setItem('legacy-file', '780');
    const first = render(<Preview id="legacy-file" />);
    expect(first.getByTestId('preview').scrollTop).toBe(780);
    settle();
    scroll(first.getByTestId('preview'), 980, 72);
    first.unmount();
    const second = render(<Preview id="legacy-file" />);
    expect(second.getByTestId('preview').scrollTop).toBe(980);
    expect(second.getByTestId('preview').scrollLeft).toBe(72);
  });
  it('isolates files when switching in the same mounted container', () => {
    writePositionValue('file-a', JSON.stringify({ top: 900, left: 40 }));
    writePositionValue('file-b', JSON.stringify({ top: 250, left: 0 }));
    const view = render(<Preview id="file-a" />);
    settle();
    view.rerender(<Preview id="file-b" />);
    settle();
    expect(view.getByTestId('preview').scrollTop).toBe(250);
    scroll(view.getByTestId('preview'), 450);
    view.rerender(<Preview id="file-a" />);
    expect(view.getByTestId('preview').scrollTop).toBe(900);
    expect(readScrollPosition('file-b').top).toBe(450);
  });
  it('ignores hidden zero offsets and restores when visible again', () => {
    const view = render(<Preview id="hidden-file" />);
    settle();
    const el = view.getByTestId('preview');
    scroll(el, 640, 80);
    height = 0;
    act(() => resized());
    scroll(el, 0);
    expect(readScrollPosition('hidden-file').top).toBe(640);
    height = 300;
    act(() => resized());
    expect(el.scrollTop).toBe(640);
    expect(el.scrollLeft).toBe(80);
  });
  it('waits for content and does not lose position on immediate unmount', () => {
    writePositionValue('loading-file', JSON.stringify({ top: 450, left: 0 }));
    const view = render(<Preview id="loading-file" ready={false} />);
    expect(view.getByTestId('preview').scrollTop).toBe(0);
    view.rerender(<Preview id="loading-file" />);
    expect(view.getByTestId('preview').scrollTop).toBe(450);
    view.unmount();
    settle();
    expect(readScrollPosition('loading-file').top).toBe(450);
  });
  it('retains state when browser storage is unavailable', () => {
    vi.spyOn(localStorage, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    vi.spyOn(localStorage, 'getItem').mockImplementation(() => {
      throw new Error('disabled');
    });
    writePositionValue('private-file', JSON.stringify({ top: 420, left: 12 }));
    expect(readScrollPosition('private-file')).toEqual({ top: 420, left: 12 });
  });
  it('rejects malformed PDF state and preserves a valid document anchor', () => {
    writePositionValue('bad-pdf', '{');
    expect(readPdfPosition('bad-pdf')).toBeNull();
    const position = { page: 7, zoom: 'page-width', top: 550, left: 12, rotation: 90 };
    writePositionValue('good-pdf', JSON.stringify(position));
    expect(readPdfPosition('good-pdf')).toEqual(position);
    writePositionValue('bad-scale-pdf', JSON.stringify({ ...position, zoom: 'Infinity' }));
    expect(readPdfPosition('bad-scale-pdf')).toBeNull();
  });
});
