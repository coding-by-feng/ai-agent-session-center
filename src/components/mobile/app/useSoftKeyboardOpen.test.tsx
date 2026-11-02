// useSoftKeyboardOpen.test.tsx — the tab bar hides for the keyboard (AASC-39): a
// focused field AND a shorter screen; focus alone (Android's back closed the
// keyboard) brings the bar back.
import { describe, it, expect, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useKeyboardKeepsSplit, useSoftKeyboardOpen } from './useSoftKeyboardOpen';

function Probe() {
  return <><input aria-label="field" /><output>{useSoftKeyboardOpen() ? 'open' : 'closed'}</output></>;
}

function SplitProbe() {
  return <><input aria-label="field" /><output>{useKeyboardKeepsSplit() ? 'kept' : 'free'}</output></>;
}

function setWidth(w: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: w });
}

function setHeight(h: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => { setWidth(1024); setHeight(768); });

describe('useSoftKeyboardOpen', () => {
  it('is closed for a focused field while the screen keeps its height', () => {
    setHeight(844);
    const { getByLabelText, container } = render(<Probe />);
    act(() => getByLabelText('field').focus());
    expect(container.querySelector('output')).toHaveTextContent('closed');
  });

  it('opens when the window shrinks under a focused field, and closes when it grows back', () => {
    setHeight(844);
    const { getByLabelText, container } = render(<Probe />);
    act(() => getByLabelText('field').focus());
    act(() => setHeight(500));
    expect(container.querySelector('output')).toHaveTextContent('open');
    act(() => setHeight(844)); // the keyboard went, the field kept its focus
    expect(container.querySelector('output')).toHaveTextContent('closed');
  });

  it('stays closed when the window shrinks with no field focused', () => {
    setHeight(844);
    const { container } = render(<Probe />);
    act(() => setHeight(500));
    expect(container.querySelector('output')).toHaveTextContent('closed');
  });
});

// Nov 2: an iPad in landscape (1180 × 820) shrinks to ~420 for the keyboard, under the
// split's 600 px, and the layout change closed the keyboard again.
describe('useKeyboardKeepsSplit', () => {
  it('holds the split while the keyboard shrinks a wide, tall window', () => {
    setWidth(1180);
    setHeight(820);
    const { getByLabelText, container } = render(<SplitProbe />);
    act(() => getByLabelText('field').focus());
    act(() => setHeight(420));
    expect(container.querySelector('output')).toHaveTextContent('kept');
    act(() => setHeight(820));
    expect(container.querySelector('output')).toHaveTextContent('free'); // the media query takes over again
  });

  it('never splits a narrow window (portrait iPad, a phone)', () => {
    setWidth(820);
    setHeight(1180);
    const { getByLabelText, container } = render(<SplitProbe />);
    act(() => getByLabelText('field').focus());
    act(() => setHeight(760));
    expect(container.querySelector('output')).toHaveTextContent('free');
  });

  it('does nothing for a window that was never tall enough (a phone in landscape)', () => {
    setWidth(932);
    setHeight(430);
    const { getByLabelText, container } = render(<SplitProbe />);
    act(() => getByLabelText('field').focus());
    act(() => setHeight(200));
    expect(container.querySelector('output')).toHaveTextContent('free');
  });
});
