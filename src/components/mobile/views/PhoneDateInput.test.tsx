// PhoneDateInput.test.tsx — the phone views' date field (Oct 22 2026): says what an empty value means, hands
// back the picked date, and sits in a box that never outgrows its column (the iOS Filters sheet slid sideways).
import { describe, it, expect, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import PhoneDateInput from './PhoneDateInput';

describe('PhoneDateInput', () => {
  it('says "Any date" while empty (hidden from screen readers: the label names the field), and not once set', () => {
    const { rerender, container } = render(<PhoneDateInput value="" onChange={() => {}} />);
    const hint = screen.getByText('Any date');
    expect(hint).toHaveAttribute('aria-hidden', 'true');
    rerender(<PhoneDateInput value="2026-10-22" onChange={() => {}} />);
    expect(screen.queryByText('Any date')).toBeNull();
    expect(container.querySelector('input')).toHaveValue('2026-10-22');
  });

  it('takes its own empty label, and hands back the picked date', () => {
    const onChange = vi.fn();
    const { container } = render(<PhoneDateInput value="" onChange={onChange} emptyLabel="No date" />);
    expect(screen.getByText('No date')).toBeTruthy();
    fireEvent.change(container.querySelector('input')!, { target: { value: '2026-11-01' } });
    expect(onChange).toHaveBeenCalledWith('2026-11-01');
  });
});
