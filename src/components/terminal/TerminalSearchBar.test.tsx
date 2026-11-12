// TerminalSearchBar.test.tsx — find in the terminal's output (Nov 6 2026).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useState } from 'react';
import { act, fireEvent, render, screen } from '@testing-library/react';
import type { SearchAddon } from '@xterm/addon-search';
import TerminalSearchBar, { type TerminalSearchBarProps, type TerminalSearchState } from './TerminalSearchBar';
import { TERMINAL_SEARCH_DEBOUNCE_MS } from '@/lib/terminalSearch';

type ResultsListener = (r: { resultIndex: number; resultCount: number }) => void;

function fakeAddon() {
  let listener: ResultsListener | null = null;
  const addon = {
    findNext: vi.fn(() => true),
    findPrevious: vi.fn(() => true),
    clearDecorations: vi.fn(),
    onDidChangeResults: vi.fn((fn: ResultsListener) => {
      listener = fn;
      return { dispose: vi.fn(() => { listener = null; }) };
    }),
  };
  return { addon, emit: (r: Parameters<ResultsListener>[0]) => act(() => listener?.(r)) };
}

type BarOverrides = Partial<Omit<TerminalSearchBarProps, keyof TerminalSearchState>> & Partial<TerminalSearchState>;

/** The parent owns the query and toggles (TerminalContainer); this holds them the same way. */
function Harness({ initial, ...props }: Omit<TerminalSearchBarProps, keyof TerminalSearchState | 'onChange'> & { initial: TerminalSearchState }) {
  const [state, setState] = useState(initial);
  return <TerminalSearchBar {...props} {...state} onChange={(patch) => setState((s) => ({ ...s, ...patch }))} />;
}

function renderBar(over: BarOverrides = {}) {
  const fake = fakeAddon();
  const onClose = vi.fn();
  const { query = '', caseSensitive = false, regex = false, ...rest } = over;
  const props = {
    getAddon: () => fake.addon as unknown as SearchAddon,
    terminalId: 'term-1' as string | null,
    openSeq: 1,
    onClose,
    ...rest,
  };
  const utils = render(<Harness {...props} initial={{ query, caseSensitive, regex }} />);
  const rerenderWith = (next: Partial<typeof props>) =>
    utils.rerender(<Harness {...props} {...next} initial={{ query, caseSensitive, regex }} />);
  return { ...utils, ...fake, onClose, rerenderWith, input: screen.getByRole<HTMLInputElement>('textbox', { name: 'Find in terminal' }) };
}

const settle = () => act(() => { vi.advanceTimersByTime(TERMINAL_SEARCH_DEBOUNCE_MS + 10); });

describe('TerminalSearchBar', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('opens focused, and searches as you type after a short pause', () => {
    const { input, addon } = renderBar();
    expect(input).toHaveFocus();
    fireEvent.change(input, { target: { value: 'ssh' } });
    expect(addon.findNext).not.toHaveBeenCalled();
    settle();
    expect(addon.findNext).toHaveBeenCalledWith('ssh', expect.objectContaining({ incremental: true, caseSensitive: false, regex: false }));
  });

  it('shows the count the addon reports, and No results', () => {
    const { input, emit } = renderBar();
    fireEvent.change(input, { target: { value: 'ssh' } });
    settle();
    emit({ resultIndex: 2, resultCount: 12 });
    expect(screen.getByRole('status')).toHaveTextContent('3/12');
    emit({ resultIndex: -1, resultCount: 0 });
    expect(screen.getByRole('status')).toHaveTextContent('No results');
  });

  it('steps with Enter / Shift+Enter and the arrow buttons', () => {
    const { input, addon } = renderBar({ query: 'ssh' });
    settle();
    addon.findNext.mockClear();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(addon.findNext).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(input, { key: 'Enter', shiftKey: true });
    expect(addon.findPrevious).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'Previous match (Shift+Enter)' }));
    expect(addon.findPrevious).toHaveBeenCalledTimes(2);
    fireEvent.click(screen.getByRole('button', { name: 'Next match (Enter)' }));
    expect(addon.findNext).toHaveBeenCalledTimes(2);
  });

  it('searches the query it was opened with', () => {
    const { input, addon } = renderBar({ query: 'BatchMode' });
    expect(input).toHaveValue('BatchMode');
    settle();
    expect(addon.findNext).toHaveBeenCalledWith('BatchMode', expect.anything());
  });

  it('passes the case and regex toggles, and never searches a regex that does not compile', () => {
    const { input, addon } = renderBar();
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    fireEvent.click(screen.getByRole('button', { name: 'Use regular expression' }));
    expect(screen.getByRole('button', { name: 'Match case' })).toHaveAttribute('aria-pressed', 'true');
    fireEvent.change(input, { target: { value: '(unclosed' } });
    settle();
    expect(addon.findNext).not.toHaveBeenCalled();
    expect(input).toHaveAttribute('aria-invalid', 'true');
    expect(screen.getByRole('status')).toHaveTextContent('Bad regex');
    fireEvent.change(input, { target: { value: 'ssh.*HOST' } });
    settle();
    expect(addon.findNext).toHaveBeenCalledWith('ssh.*HOST', expect.objectContaining({ caseSensitive: true, regex: true }));
    // Case-blind again: the regex goes as (?i:…), so the addon never lowercases its escapes.
    fireEvent.click(screen.getByRole('button', { name: 'Match case' }));
    settle();
    expect(addon.findNext).toHaveBeenLastCalledWith('(?i:ssh.*HOST)', expect.objectContaining({ caseSensitive: true, regex: true }));
  });

  it('closes on Esc without letting it reach the page, and clears the highlights', () => {
    const { input, addon, onClose, unmount } = renderBar();
    const pageEsc = vi.fn();
    document.addEventListener('keydown', pageEsc);
    fireEvent.keyDown(input, { key: 'Escape' });
    document.removeEventListener('keydown', pageEsc);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pageEsc).not.toHaveBeenCalled();
    unmount();
    expect(addon.clearDecorations).toHaveBeenCalled();
  });

  it('disables stepping with nothing to step through', () => {
    renderBar();
    expect(screen.getByRole('button', { name: 'Next match (Enter)' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Close find (Esc)' })).toBeEnabled();
  });
  it('closes on Esc from a toggle or arrow too, before the page sees it (the panel keeps its size)', () => {
    const { onClose } = renderBar({ query: 'ssh' });
    const pageEsc = vi.fn();
    window.addEventListener('keydown', pageEsc);
    const next = screen.getByRole('button', { name: 'Next match (Enter)' });
    next.focus();
    fireEvent.keyDown(next, { key: 'Escape' });
    window.removeEventListener('keydown', pageEsc);
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(pageEsc).not.toHaveBeenCalled();
  });

  it('keeps ⌘F inside the bar: re-selects the field and never reaches find in file', () => {
    const { input } = renderBar({ query: 'ssh' });
    const pageFind = vi.fn();
    document.addEventListener('keydown', pageFind);
    const isMac = /Mac|iPhone|iPad|iPod/i.test(navigator.platform);
    const toggle = screen.getByRole('button', { name: 'Match case' });
    toggle.focus();
    const ev = fireEvent.keyDown(toggle, { key: 'f', metaKey: isMac, ctrlKey: !isMac });
    document.removeEventListener('keydown', pageFind);
    expect(ev).toBe(false); // default prevented
    expect(pageFind).not.toHaveBeenCalled();
    expect(input).toHaveFocus();
    expect(input.selectionStart).toBe(0);
    expect(input.selectionEnd).toBe(3);
  });

  it('does not step while an IME is composing (Enter picks the candidate)', () => {
    const { input, addon } = renderBar({ query: 'ssh' });
    settle();
    addon.findNext.mockClear();
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(addon.findNext).not.toHaveBeenCalled();
  });

  it('never shows the previous terminal\'s count after a re-attach', () => {
    const { emit, rerenderWith } = renderBar({ query: 'ssh' });
    settle();
    emit({ resultIndex: 2, resultCount: 12 });
    expect(screen.getByRole('status')).toHaveTextContent('3/12');
    rerenderWith({ terminalId: 'term-2' });
    expect(screen.getByRole('status')).toHaveTextContent('');
  });
});
