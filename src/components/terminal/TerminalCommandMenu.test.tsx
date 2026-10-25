/**
 * The terminal's `/` list, driven through the same tap the real terminal calls
 * (useTerminal's key handler and onData), with the command index stubbed.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, act, waitFor, fireEvent } from '@testing-library/react';
import type { CommandEntry } from '@/lib/commandIndex';
import type { TerminalInputTap } from '@/hooks/useTerminal';

const entries: CommandEntry[] = [
  { name: 'teleport', description: 'Send this session to the cloud', cli: 'claude', kind: 'command', source: 'builtin' },
  { name: 'terminal-setup', description: 'Install Shift+Enter', cli: 'claude', kind: 'command', source: 'builtin' },
  { name: 'clear', description: 'Clear the conversation', cli: 'claude', kind: 'command', source: 'builtin' },
  { name: 'krt-tel', description: 'A skill', cli: 'claude', kind: 'skill', source: 'global' },
  { name: 'imagegen', description: 'Codex skill', cli: 'codex', kind: 'skill', source: 'builtin' },
  { name: 'review', description: 'Codex prompt', cli: 'codex', kind: 'command', source: 'builtin' },
];

vi.mock('@/lib/commandIndex', async (orig) => {
  const actual = await orig<typeof import('@/lib/commandIndex')>();
  return {
    ...actual,
    fetchCommandIndex: vi.fn(async (cli: string) => entries.filter((e) => e.cli === cli)),
  };
});

import TerminalCommandMenu from './TerminalCommandMenu';

const midPrompt = { charBefore: ' ', lineBefore: '❯ hello ' };

function key(k: string, type = 'keydown', extra: Partial<KeyboardEvent> = {}): KeyboardEvent {
  return { key: k, type, shiftKey: false, metaKey: false, ctrlKey: false, altKey: false, isComposing: false, ...extra } as KeyboardEvent;
}

function setup(cli: 'claude' | 'codex' = 'claude') {
  let tap: TerminalInputTap | null = null;
  const sendKeys = vi.fn();
  const utils = render(
    <TerminalCommandMenu
      cli={cli}
      projectPath="/p"
      setInputTap={(t) => { tap = t; }}
      getCaretRect={() => ({ left: 100, top: 500, bottom: 518 })}
      sendKeys={sendKeys}
    />,
  );
  const type = async (data: string, caret = midPrompt) => {
    await act(async () => {
      for (const ch of data) tap!.onData(ch, caret);
    });
  };
  return { ...utils, sendKeys, type, tap: () => tap! };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('TerminalCommandMenu', () => {
  it('lists every matching command and skill for a `/` typed mid-prompt', async () => {
    const { type } = setup();
    await type('/te');
    expect(await screen.findByText('/teleport')).toBeTruthy();
    expect(screen.getByText('/terminal-setup')).toBeTruthy();
    expect(screen.getByText('/krt-tel')).toBeTruthy(); // a skill, matched inside its name
    expect(screen.queryByText('/clear')).toBeNull();
    expect(screen.getByRole('listbox', { name: 'Commands and skills' })).toBeTruthy();
  });

  it('stays shut where the CLI opens its own list (the first character of the input)', async () => {
    const { type } = setup();
    await type('/te', { charBefore: ' ', lineBefore: '❯ ' });
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('Tab types the rest of the highlighted name and a space, and closes', async () => {
    const { type, tap, sendKeys } = setup();
    await type('/te');
    await screen.findByText('/teleport');
    let taken = false;
    act(() => { taken = tap().onKey(key('Tab')); });
    expect(taken).toBe(true);
    expect(sendKeys).toHaveBeenCalledWith('leport ');
    expect(screen.queryByRole('listbox')).toBeNull();
    // Its keyup is swallowed too; the next one is not.
    expect(tap().onKey(key('Tab', 'keyup'))).toBe(true);
    expect(tap().onKey(key('Tab', 'keyup'))).toBe(false);
  });

  it('↓ then Enter picks the next row; a pick matched mid-name erases the typed text first', async () => {
    const { type, tap, sendKeys } = setup();
    await type('/tel');
    await screen.findByText('/krt-tel');
    act(() => { tap().onKey(key('ArrowDown')); });
    const selected = screen.getByRole('option', { selected: true });
    expect(selected.textContent).toContain('/krt-tel');
    act(() => { tap().onKey(key('Enter')); });
    expect(sendKeys).toHaveBeenCalledWith('\x7f\x7f\x7f\x7f/krt-tel ');
  });

  it('Esc closes the list and is never sent (it would interrupt a Claude turn)', async () => {
    const { type, tap, sendKeys } = setup();
    await type('/te');
    await screen.findByText('/teleport');
    let taken = false;
    act(() => { taken = tap().onKey(key('Escape')); });
    expect(taken).toBe(true);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(sendKeys).not.toHaveBeenCalled();
    // With the list shut, Esc goes to the CLI again.
    expect(tap().onKey(key('Escape'))).toBe(false);
  });

  it('untouched, Enter submits the prompt as typed — even a partial name', async () => {
    // Matching is substring-wide: a prompt ending in `/te` must not become `/teleport`.
    for (const typed of ['/te', '/clear']) {
      const { type, tap, sendKeys, unmount } = setup();
      await type(typed);
      await screen.findByRole('listbox');
      let taken = true;
      act(() => { taken = tap().onKey(key('Enter')); });
      expect(taken).toBe(false);
      expect(sendKeys).not.toHaveBeenCalled();
      expect(screen.queryByRole('listbox')).toBeNull();
      unmount();
    }
  });

  it('the footer names the keys that insert', async () => {
    const { type } = setup();
    await type('/te');
    expect(await screen.findByText('↑↓ move · Tab insert · Esc close')).toBeTruthy();
  });

  it('leaves modified keys alone (Shift+Tab cycles Claude modes)', async () => {
    const { type, tap } = setup();
    await type('/te');
    await screen.findByText('/teleport');
    expect(tap().onKey(key('Tab', 'keydown', { shiftKey: true }))).toBe(false);
    expect(tap().onKey(key('Enter', 'keydown', { metaKey: true }))).toBe(false);
  });

  it('a space or Backspace past the `/` closes it; Backspace inside narrows again', async () => {
    const { type } = setup();
    await type('/tex');
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole('listbox')).toBeNull(); // no match
    await type('\x7f');
    expect(await screen.findByText('/teleport')).toBeTruthy();
    await type(' ');
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('opens on a quick `space /` whose echo has not reached the screen yet', async () => {
    const { type } = setup();
    // The screen lags one keystroke behind: it never shows the space.
    await type(' ', { charBefore: 'e', lineBefore: '❯ more' });
    await type('/te', { charBefore: 'e', lineBefore: '❯ more' });
    expect(await screen.findByText('/teleport')).toBeTruthy();
  });

  it('stays shut for a `/` typed right after Enter (a fresh input), even on a stale screen', async () => {
    const { type } = setup();
    await type('\r', midPrompt);
    await type('/te', midPrompt);
    await act(async () => { await new Promise((r) => setTimeout(r, 20)); });
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('closes when input goes where it cannot follow (blur, paste, Shift+Enter)', async () => {
    const { type, tap } = setup();
    await type('/te');
    await screen.findByText('/teleport');
    act(() => tap().onReset());
    expect(screen.queryByRole('listbox')).toBeNull();
  });

  it('a mouse pick types the completion', async () => {
    const { type, sendKeys } = setup();
    await type('/te');
    fireEvent.mouseDown(await screen.findByText('/terminal-setup'));
    expect(sendKeys).toHaveBeenCalledWith('rminal-setup ');
  });

  it('on Codex lists commands and its skills, skills as `$name` (Codex lists nothing mid-prompt)', async () => {
    const { type } = setup('codex');
    await type('/');
    await waitFor(() => expect(screen.getByText('/review')).toBeTruthy());
    expect(screen.getByText('$imagegen')).toBeTruthy();
    expect(screen.queryByText('/imagegen')).toBeNull();
  });

  it('on Codex a picked skill replaces the typed `/…` with `$name`', async () => {
    const { type, tap, sendKeys } = setup('codex');
    await type('/ima');
    await screen.findByText('$imagegen');
    act(() => { tap().onKey(key('Tab')); });
    expect(sendKeys).toHaveBeenCalledWith('\x7f\x7f\x7f\x7f$imagegen ');
  });

  it('removes its tap on unmount', () => {
    const setInputTap = vi.fn();
    const { unmount } = render(
      <TerminalCommandMenu cli="claude" setInputTap={setInputTap} getCaretRect={() => null} sendKeys={vi.fn()} />,
    );
    expect(setInputTap).toHaveBeenLastCalledWith(expect.objectContaining({ onKey: expect.any(Function) }));
    unmount();
    expect(setInputTap).toHaveBeenLastCalledWith(null);
  });
});
