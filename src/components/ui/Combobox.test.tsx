// Combobox.test.tsx — the ▾ toggle on a touch screen.
//
// Found on an Android phone (e2e run 5, F1): the New Terminal Session form's Model ▾ focused the
// input, so the soft keyboard rose, the form shrank to what was left above it, and the list the
// tap had just opened was clipped to 0px. A second tap meant for "haiku" landed on the keyboard
// instead. A finger asked for the list, not for typing: only a mouse or pen keeps the focus
// (and with it the arrow keys).
import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import Combobox from './Combobox';

const ITEMS = ['fable', 'opus', 'sonnet', 'haiku'];

function setup() {
  const onChange = vi.fn();
  render(<Combobox value="" onChange={onChange} items={ITEMS} placeholder="Default" />);
  return { onChange, input: screen.getByRole('combobox'), toggle: screen.getByRole('button', { name: 'Toggle dropdown' }) };
}

function press(toggle: HTMLElement, pointerType: 'touch' | 'mouse' | 'pen') {
  fireEvent.pointerDown(toggle, { pointerType });
  fireEvent.click(toggle);
}

describe('Combobox ▾ toggle', () => {
  it('a finger opens the whole list without focusing the input (no soft keyboard over it)', () => {
    const { input, toggle } = setup();
    press(toggle, 'touch');
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual(ITEMS);
    expect(document.activeElement).not.toBe(input);
  });

  it('a mouse still focuses the input, so the arrow keys work', () => {
    const { input, toggle } = setup();
    press(toggle, 'mouse');
    expect(screen.getAllByRole('option')).toHaveLength(ITEMS.length);
    expect(document.activeElement).toBe(input);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    expect(screen.getByRole('option', { name: 'fable' }).getAttribute('aria-selected')).toBe('true');
  });

  it('a click with no pointer event before it (keyboard, assistive tech) focuses as before', () => {
    const { input, toggle } = setup();
    fireEvent.click(toggle);
    expect(document.activeElement).toBe(input);
  });

  it('after a touch, the next mouse press focuses again (the pointer type is per press)', () => {
    const { input, toggle } = setup();
    press(toggle, 'touch');
    press(toggle, 'touch'); // closes
    press(toggle, 'mouse');
    expect(document.activeElement).toBe(input);
  });

  it('a tapped option is chosen and the list closes', () => {
    const { onChange, toggle } = setup();
    press(toggle, 'touch');
    fireEvent.mouseDown(screen.getByRole('option', { name: 'haiku' }));
    expect(onChange).toHaveBeenCalledWith('haiku');
    expect(screen.queryByRole('listbox')).toBeNull();
  });
});

// F2 (e2e run 5): the list was `position: absolute` inside the modal's scrolling body, so it was
// clipped at the body's edge. On a phone "haiku" sat on the clip line, the tap fell through to the
// body and the click-outside handler closed the list with nothing chosen; in Android Chrome a tap on
// "opus" landed on CANCEL, which sits over the list. The list now lives in <body> like ui/Menu.
describe('Combobox list placement', () => {
  it('renders the list in <body>, outside any clipping ancestor', () => {
    const onChange = vi.fn();
    render(
      <div data-testid="scroller" style={{ overflow: 'auto', height: 40 }}>
        <Combobox value="" onChange={onChange} items={ITEMS} />
      </div>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Toggle dropdown' }));
    const list = screen.getByRole('listbox');
    expect(screen.getByTestId('scroller').contains(list)).toBe(false);
    expect(list.closest('body > *')?.contains(screen.getByRole('combobox'))).toBe(false);
  });

  it('picking from the portaled list still selects; a press elsewhere still closes', () => {
    const { onChange, toggle } = setup();
    press(toggle, 'touch');
    fireEvent.mouseDown(screen.getByRole('option', { name: 'opus' }));
    expect(onChange).toHaveBeenCalledWith('opus');
    press(toggle, 'touch');
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('"No matches" is portaled too', () => {
    render(<Combobox value="zzz" onChange={vi.fn()} items={ITEMS} />);
    fireEvent.change(screen.getByRole('combobox'), { target: { value: 'zzzz' } });
    const empty = screen.getByText('No matches');
    expect(empty.closest('[class*="wrapper"]')).toBeNull();
  });
});

// Oct 23 2026: the New Terminal Session's Working Directory lists every known project and
// had no search — typing in the field filtered only by overwriting the folder already in it.
// `searchable` adds a search box at the top of the open list that leaves the field alone.
describe('Combobox searchable', () => {
  const DIRS = [
    '/Users/me',
    '/Users/me/Documents/valux',
    '/Users/me/Documents/exmouth',
    '/Users/me/Documents/exmouth-3d',
    '/Users/me/Documents/kason-tools/kason-tools',
  ];
  function open(pointerType: 'mouse' | 'touch' = 'mouse') {
    const onChange = vi.fn();
    render(<Combobox value="/Users/me" onChange={onChange} items={DIRS} searchable searchLabel="Search folders" />);
    press(screen.getByRole('button', { name: 'Toggle dropdown' }), pointerType);
    return { onChange, search: screen.getByRole('searchbox', { name: 'Search folders' }) };
  }
  const rows = () => screen.getAllByRole('option').map((o) => o.textContent);

  it('opens with a search box over the whole list, focused for a mouse', () => {
    const { search } = open();
    expect(search).toHaveFocus();
    expect(rows()).toHaveLength(DIRS.length);
  });

  it('a finger opens it without focusing the search box (no soft keyboard over the list)', () => {
    const { search } = open('touch');
    expect(search).not.toHaveFocus();
  });

  it('filters as you type, case-insensitively, without touching the field', () => {
    const { onChange, search } = open();
    fireEvent.change(search, { target: { value: 'EXM' } });
    expect(rows()).toEqual(['/Users/me/Documents/exmouth', '/Users/me/Documents/exmouth-3d']);
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole('combobox')).toHaveValue('/Users/me');
    expect(screen.getByText('2 of 5')).toBeInTheDocument();
  });

  it('marks what matched, with the original casing', () => {
    const { search } = open();
    fireEvent.change(search, { target: { value: 'tools' } });
    const marks = [...screen.getByRole('option').querySelectorAll('mark')].map((m) => m.textContent);
    expect(marks).toEqual(['tools', 'tools']);
  });

  it('↓ and Enter pick the highlighted match into the field and close', () => {
    const { onChange, search } = open();
    fireEvent.change(search, { target: { value: 'exm' } });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    expect(screen.getAllByRole('option')[1]).toHaveAttribute('aria-selected', 'true');
    fireEvent.keyDown(search, { key: 'Enter' });
    expect(onChange).toHaveBeenCalledWith('/Users/me/Documents/exmouth-3d');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('says "No matches" when nothing fits, and Escape closes', () => {
    const { search } = open();
    fireEvent.change(search, { target: { value: 'zzz' } });
    expect(screen.getByText('No matches')).toBeInTheDocument();
    expect(screen.getByText('0 of 5')).toBeInTheDocument();
    fireEvent.keyDown(search, { key: 'Escape' });
    expect(screen.queryByRole('searchbox')).toBeNull();
  });

  it('starts empty each time the list opens', () => {
    const { search } = open();
    fireEvent.change(search, { target: { value: 'exm' } });
    fireEvent.keyDown(search, { key: 'Escape' });
    press(screen.getByRole('button', { name: 'Toggle dropdown' }), 'mouse');
    expect(screen.getByRole('searchbox')).toHaveValue('');
    expect(rows()).toHaveLength(DIRS.length);
  });

  // The search box is portaled out of any modal, so Tab from it would leave an aria-modal dialog
  // with the list still open: Tab closes the list and continues from the field.
  it('Tab from the search box closes the list and returns to the field', () => {
    open();
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'Tab' });
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('combobox')).toHaveFocus();
  });

  it('a list without `searchable` has no search box', () => {
    setup();
    fireEvent.click(screen.getByRole('button', { name: 'Toggle dropdown' }));
    expect(screen.queryByRole('searchbox')).toBeNull();
  });
});

// The rows used `word-break: break-all`, so a long path broke mid-word ("exmout|h").
describe('Combobox rows break at path separators', () => {
  it('offers a break after every "/", and the option keeps its plain name', () => {
    render(<Combobox value="" onChange={vi.fn()} items={['/Users/me/Documents/exmouth']} />);
    fireEvent.click(screen.getByRole('button', { name: 'Toggle dropdown' }));
    const option = screen.getByRole('option', { name: '/Users/me/Documents/exmouth' });
    expect(option.querySelectorAll('wbr')).toHaveLength(4);
  });
});
