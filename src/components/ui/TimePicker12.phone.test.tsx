/**
 * TimePicker12 on a phone (AASC-20, feature 67): the platform's own time
 * picker, reading and writing the same `HH:MM` 24-hour string the queue stores
 * (loops' daily start, quiet hours). The desktop keeps its three dropdowns.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import TimePicker12 from './TimePicker12';
import { fromTimeInputValue, toTimeInputValue } from '@/lib/timePicker';

const platform = vi.hoisted(() => ({ isMobile: true }));
vi.mock('@/lib/platform', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/platform')>()),
  useIsMobile: () => platform.isMobile,
}));

beforeEach(() => {
  platform.isMobile = true;
});

describe('time input values', () => {
  it('round-trips the stored HH:MM without changing its format', () => {
    expect(toTimeInputValue('8:05')).toBe('08:05');
    expect(toTimeInputValue('23:59')).toBe('23:59');
    expect(toTimeInputValue('24:00')).toBe('');
    expect(toTimeInputValue(undefined)).toBe('');
    expect(fromTimeInputValue('07:30')).toBe('07:30');
    expect(fromTimeInputValue('07:30:15')).toBe('07:30');
    expect(fromTimeInputValue('')).toBeUndefined();
    expect(fromTimeInputValue('7pm')).toBeUndefined();
  });
});

describe('TimePicker12 on a phone', () => {
  it('is one native time input holding the stored value, and writes HH:MM 24-hour back', () => {
    const onChange = vi.fn();
    render(<TimePicker12 value="22:00" onChange={onChange} ariaLabel="Window start" />);
    const input = screen.getByLabelText('Window start', { selector: 'input' }) as HTMLInputElement;
    expect(input.type).toBe('time');
    expect(input.value).toBe('22:00');
    expect(screen.queryAllByRole('combobox')).toHaveLength(0);
    fireEvent.change(input, { target: { value: '07:45' } });
    expect(onChange).toHaveBeenCalledWith('07:45');
  });

  it('never clears a required time, and an optional one clears with its own button', () => {
    const required = vi.fn();
    const { unmount } = render(<TimePicker12 value="09:00" onChange={required} ariaLabel="Window end" />);
    fireEvent.change(screen.getByLabelText('Window end', { selector: 'input' }), { target: { value: '' } });
    expect(required).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
    unmount();

    const optional = vi.fn();
    render(<TimePicker12 value="08:15" onChange={optional} allowEmpty ariaLabel="First fire of day" />);
    const clear = screen.getByRole('button', { name: 'Clear First fire of day' });
    fireEvent.click(clear);
    expect(optional).toHaveBeenCalledWith(undefined);
  });

  it('shows no Clear button for an unset optional time', () => {
    render(<TimePicker12 value={undefined} onChange={vi.fn()} allowEmpty ariaLabel="First fire of day" />);
    expect((screen.getByLabelText('First fire of day', { selector: 'input' }) as HTMLInputElement).value).toBe('');
    expect(screen.queryByRole('button', { name: /Clear/ })).toBeNull();
  });
});

describe('TimePicker12 on the desktop', () => {
  it('keeps its hour / minute / AM-PM dropdowns', () => {
    platform.isMobile = false;
    render(<TimePicker12 value="13:45" onChange={vi.fn()} />);
    expect(screen.getAllByRole('combobox')).toHaveLength(3);
    expect(document.querySelector('input[type=time]')).toBeNull();
  });
});
