// useMoreToTheRight.test.tsx — the Sessions filter row fades its edge only while more
// chips sit past it (Oct 20 2026).
import { describe, it, expect } from 'vitest';
import { act, fireEvent, render, screen } from '@testing-library/react';
import { useMoreToTheRight } from './useMoreToTheRight';

function Row() {
  const [ref, more] = useMoreToTheRight<HTMLDivElement>();
  return <div ref={ref} data-testid="row" data-more={more ? '' : undefined} />;
}

function size(el: HTMLElement, { scrollWidth, clientWidth, scrollLeft }: { scrollWidth: number; clientWidth: number; scrollLeft: number }) {
  Object.defineProperty(el, 'scrollWidth', { configurable: true, value: scrollWidth });
  Object.defineProperty(el, 'clientWidth', { configurable: true, value: clientWidth });
  Object.defineProperty(el, 'scrollLeft', { configurable: true, writable: true, value: scrollLeft });
}

describe('useMoreToTheRight', () => {
  it('says so while content runs past the right edge, and not once scrolled to the end', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    act(() => { size(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 0 }); fireEvent.scroll(row); });
    expect(row).toHaveAttribute('data-more');
    act(() => { size(row, { scrollWidth: 500, clientWidth: 300, scrollLeft: 200 }); fireEvent.scroll(row); });
    expect(row).not.toHaveAttribute('data-more');
  });

  it('says nothing when everything fits', () => {
    render(<Row />);
    const row = screen.getByTestId('row');
    act(() => { size(row, { scrollWidth: 300, clientWidth: 300, scrollLeft: 0 }); fireEvent.scroll(row); });
    expect(row).not.toHaveAttribute('data-more');
  });
});
