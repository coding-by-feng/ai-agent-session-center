/**
 * Tests for FindInFileBar — keyboard UX improvements:
 *   ArrowDown / ArrowUp navigation
 *   F3 / Shift+F3 document-level shortcut
 *   wrap-around visual indicator (.countWrapped)
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, cleanup } from '@testing-library/react';

import FindInFileBar from './FindInFileBar';

// Sample file content with three matches of "foo" (one per line)
const FILE_CONTENT: string = ['foo', 'bar foo', 'baz foo'].join('\n');

function renderBar(opts: {
  fileContent?: string;
  onClose?: () => void;
  onScrollToLine?: (lineNumber: number) => void;
  onTermChange?: (term: string, caseSensitive: boolean) => void;
} = {}) {
  const onClose = opts.onClose ?? vi.fn();
  const onScrollToLine = opts.onScrollToLine ?? vi.fn();
  const onTermChange = opts.onTermChange ?? vi.fn();
  const utils = render(
    <FindInFileBar
      fileContent={opts.fileContent ?? FILE_CONTENT}
      onClose={onClose}
      onScrollToLine={onScrollToLine}
      onTermChange={onTermChange}
    />,
  );
  const input = utils.container.querySelector('input') as HTMLInputElement;
  return { ...utils, input, onClose, onScrollToLine, onTermChange };
}

/** Type the query into the input so matches are generated. */
function typeQuery(input: HTMLInputElement, value: string): void {
  fireEvent.change(input, { target: { value } });
}

/** Find the count span (e.g. "1 of 3"). */
function getCountSpan(): HTMLElement {
  const el = screen.getByText(/of \d+|No results/);
  return el;
}

describe('FindInFileBar keyboard UX', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    cleanup();
  });

  it('ArrowDown advances activeIdx', () => {
    const { input } = renderBar();
    typeQuery(input, 'foo');

    // Initial: 1 of 3
    expect(getCountSpan().textContent).toBe('1 of 3');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(getCountSpan().textContent).toBe('2 of 3');

    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(getCountSpan().textContent).toBe('3 of 3');
  });

  it('ArrowUp decrements activeIdx', () => {
    const { input } = renderBar();
    typeQuery(input, 'foo');

    // Advance to 3rd match so we can decrement
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(getCountSpan().textContent).toBe('3 of 3');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(getCountSpan().textContent).toBe('2 of 3');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(getCountSpan().textContent).toBe('1 of 3');
  });

  it('wrapping past last -> first sets the wrapped indicator briefly', () => {
    const { input } = renderBar();
    typeQuery(input, 'foo');

    // Advance to the last match
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(getCountSpan().textContent).toBe('3 of 3');

    // No wrap yet
    expect(getCountSpan().getAttribute('data-wrapped')).toBe('false');

    // This should wrap 3 -> 1 (index 2 -> 0)
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(getCountSpan().textContent).toBe('1 of 3');
    expect(getCountSpan().getAttribute('data-wrapped')).toBe('true');
    expect(getCountSpan().className).toMatch(/countWrapped/);

    // After ~600ms the indicator clears
    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(getCountSpan().getAttribute('data-wrapped')).toBe('false');
    expect(getCountSpan().className).not.toMatch(/countWrapped/);
  });

  it('wrapping past first -> last (via ArrowUp) also sets the wrapped indicator', () => {
    const { input } = renderBar();
    typeQuery(input, 'foo');

    expect(getCountSpan().textContent).toBe('1 of 3');
    expect(getCountSpan().getAttribute('data-wrapped')).toBe('false');

    fireEvent.keyDown(input, { key: 'ArrowUp' });
    expect(getCountSpan().textContent).toBe('3 of 3');
    expect(getCountSpan().getAttribute('data-wrapped')).toBe('true');

    // Drain the pending wrap timer before the test ends
    act(() => {
      vi.advanceTimersByTime(650);
    });
    expect(getCountSpan().getAttribute('data-wrapped')).toBe('false');
  });

  it('F3 works at document level to advance match', () => {
    const { input } = renderBar();
    typeQuery(input, 'foo');

    expect(getCountSpan().textContent).toBe('1 of 3');

    // Fire F3 on the document (not on the input)
    const prevented = !fireEvent.keyDown(document, { key: 'F3' });
    // If handler called preventDefault, fireEvent returns false
    expect(prevented).toBe(true);
    expect(getCountSpan().textContent).toBe('2 of 3');

    fireEvent.keyDown(document, { key: 'F3' });
    expect(getCountSpan().textContent).toBe('3 of 3');

    // Shift+F3 goes backward
    fireEvent.keyDown(document, { key: 'F3', shiftKey: true });
    expect(getCountSpan().textContent).toBe('2 of 3');

    // Ensure the document-level handler stops working after unmount
    cleanup();
    // Re-render a fresh bar so the unmounted listener should NOT fire anymore.
    // We can't measure the unmounted component, but confirm no error is thrown.
    expect(() => fireEvent.keyDown(document, { key: 'F3' })).not.toThrow();
    // Silence lint: reference unused input so TS doesn't complain
    void input;
  });
});
