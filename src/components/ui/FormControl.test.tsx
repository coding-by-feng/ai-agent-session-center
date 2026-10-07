import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import Field from './Field';
import NativeSelect from './NativeSelect';
import TextInput from './TextInput';
import TextArea from './TextArea';
import SearchInput from './SearchInput';

describe('TextArea', () => {
  it('is a labelled multi-line field that reports its text', () => {
    const onChange = vi.fn();
    render(<TextArea aria-label="Notes" defaultValue="" onChange={onChange} />);
    const box = screen.getByRole('textbox', { name: 'Notes' });
    expect(box.tagName).toBe('TEXTAREA');
    expect(box.getAttribute('rows')).toBe('2');
    fireEvent.change(box, { target: { value: 'line 1\nline 2' } });
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});

const OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'urgent', label: 'Urgent' },
  { value: 'low', label: 'Low' },
] as const;

describe('NativeSelect', () => {
  it('renders the options and reports the chosen value', () => {
    const onChange = vi.fn();
    render(<NativeSelect aria-label="Priority" value="all" onChange={onChange} options={OPTIONS} />);
    const select = screen.getByRole('combobox', { name: 'Priority' }) as HTMLSelectElement;
    expect(Array.from(select.options).map((o) => o.textContent)).toEqual(['All', 'Urgent', 'Low']);
    fireEvent.change(select, { target: { value: 'urgent' } });
    expect(onChange).toHaveBeenCalledWith('urgent');
  });

  it('honours a disabled option', () => {
    render(
      <NativeSelect
        aria-label="Tag"
        value="all"
        onChange={() => {}}
        options={[{ value: 'all', label: 'All' }, { value: 'x', label: 'x', disabled: true }]}
      />,
    );
    const select = screen.getByRole('combobox', { name: 'Tag' }) as HTMLSelectElement;
    expect(select.options[1].disabled).toBe(true);
  });
});

describe('Field', () => {
  it('labels the control it wraps', () => {
    render(
      <Field label="Project">
        <NativeSelect value="all" onChange={() => {}} options={OPTIONS} />
      </Field>,
    );
    expect(screen.getByRole('combobox', { name: 'Project' })).toBeTruthy();
  });

  it('labels a text input too', () => {
    render(
      <Field label="From">
        <TextInput type="date" />
      </Field>,
    );
    expect(screen.getByLabelText('From').getAttribute('type')).toBe('date');
  });
});

describe('SearchInput (field variant)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('debounces typing and clears at once', () => {
    const onChange = vi.fn();
    render(<SearchInput variant="field" ariaLabel="Search tasks" onChange={onChange} debounceMs={200} />);
    const input = screen.getByRole('textbox', { name: 'Search tasks' });

    fireEvent.change(input, { target: { value: 'fix' } });
    expect(onChange).not.toHaveBeenCalled();
    act(() => {
      vi.advanceTimersByTime(200);
    });
    expect(onChange).toHaveBeenLastCalledWith('fix');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(onChange).toHaveBeenLastCalledWith('');
    expect((input as HTMLInputElement).value).toBe('');
  });

  it('adopts a new controlled value (e.g. a filter reset) and keeps focus in the box on clear', () => {
    const onChange = vi.fn();
    const { rerender } = render(<SearchInput variant="field" ariaLabel="Search" onChange={onChange} value="old" />);
    const input = screen.getByRole('textbox', { name: 'Search' }) as HTMLInputElement;
    expect(input.value).toBe('old');

    rerender(<SearchInput variant="field" ariaLabel="Search" onChange={onChange} value="new" />);
    expect(input.value).toBe('new');

    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    expect(input.value).toBe('');
    expect(document.activeElement).toBe(input);
  });

  it('shows the clear button only while there is text', () => {
    render(<SearchInput variant="field" ariaLabel="Search" onChange={() => {}} value="" />);
    expect(screen.queryByRole('button', { name: 'Clear search' })).toBeNull();
  });

  it('keeps the data-search-input focus hook the shortcuts use', () => {
    render(<SearchInput variant="field" ariaLabel="Search" onChange={() => {}} />);
    expect(screen.getByRole('textbox', { name: 'Search' }).hasAttribute('data-search-input')).toBe(true);
  });
});
