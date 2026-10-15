// useSoftKeyboardOpen.test.tsx — the tab bar hides for the keyboard (AASC-39): a
// focused field AND a shorter screen; focus alone (Android's back closed the
// keyboard) brings the bar back.
import { describe, it, expect, afterEach } from 'vitest';
import { act, render } from '@testing-library/react';
import { useSoftKeyboardOpen } from './useSoftKeyboardOpen';

function Probe() {
  return <><input aria-label="field" /><output>{useSoftKeyboardOpen() ? 'open' : 'closed'}</output></>;
}

function setHeight(h: number) {
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: h });
  window.dispatchEvent(new Event('resize'));
}

afterEach(() => setHeight(768));

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
