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
