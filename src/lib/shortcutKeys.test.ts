// shortcutKeys.test.ts — the session-search key (⌘K / Ctrl+K since Nov 18 2026), the tab keys, the terminal pass-through.
import { describe, it, expect } from 'vitest';
import { buildBindings, comboMatchesEvent, isMac, isTerminalPassThrough, SECTION_ORDER } from './shortcutKeys';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('the searchSessions shortcut (Nov 18 2026)', () => {
  const combo = buildBindings().find((b) => b.actionId === 'searchSessions')?.combo ?? null;

  it('is Cmd+K on a Mac and Ctrl+K elsewhere, not a plain / that a focused terminal swallowed', () => {
    expect(combo).toEqual(isMac ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true });
  });

  it('matches its own combo, and not a plain k, / or Shift+K', () => {
    const mod = isMac ? { metaKey: true } : { ctrlKey: true };
    expect(comboMatchesEvent(combo, key({ key: 'k', ...mod }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: 'K', ...mod }))).toBe(true);
    expect(comboMatchesEvent(combo, key({ key: 'k' }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: '/' }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: 'k', shiftKey: true, ...mod }))).toBe(false);
  });
});

describe('the detail-tab keys (Nov 18 2026)', () => {
  const bindings = buildBindings();
  const tab = (id: string) => bindings.find((b) => b.actionId === id);

  it('number the tabs by their position, AI Popups and Agents included', () => {
    const ids = ['switchTabProject', 'switchTabTerminal', 'switchTabCommands', 'switchTabPrompts', 'switchTabAiPopups', 'switchTabQueue', 'switchTabAgents'];
    expect(ids.map((id) => tab(id)?.combo?.key)).toEqual(['1', '2', '3', '4', '5', '6', '7']);
    expect(tab('switchTabPrompts')?.label).toBe('Switch to Conversation tab');
  });

  it('never use Cmd+Shift on a Mac (macOS keeps Cmd+Shift+3/4/5 for screenshots)', () => {
    for (const b of bindings) {
      if (!b.actionId.startsWith('switchTab')) continue;
      const c = b.combo!;
      if (isMac) expect([c.metaKey, c.ctrlKey, !!c.shiftKey]).toEqual([true, true, false]);
      else expect([!!c.metaKey, c.ctrlKey, c.shiftKey]).toEqual([false, true, true]);
    }
  });

  it('no two actions share a default key', () => {
    const keys = bindings.filter((b) => b.combo).map((b) => JSON.stringify(b.combo));
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('the page-wide fullscreen binding is gone (Alt+F11 is the terminal\'s own key)', () => {
    expect(bindings.map((b) => b.actionId as string)).not.toContain('toggleFullscreen');
  });
});

describe('isTerminalPassThrough: which keys a focused terminal hands to the app', () => {
  it('passes Cmd/Ctrl with Alt or Shift, and Ctrl+Cmd', () => {
    expect(isTerminalPassThrough({ metaKey: true, altKey: true, ctrlKey: false, shiftKey: false }, false)).toBe(true);
    expect(isTerminalPassThrough({ ctrlKey: true, shiftKey: true, metaKey: false, altKey: false }, false)).toBe(true);
    expect(isTerminalPassThrough({ ctrlKey: true, metaKey: true, altKey: false, shiftKey: false }, true)).toBe(true);
  });

  it('passes Cmd alone on a Mac only (⌘K); a bare Ctrl key stays the shell\'s (Ctrl+K kills the line)', () => {
    expect(isTerminalPassThrough({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, true)).toBe(true);
    expect(isTerminalPassThrough({ metaKey: true, ctrlKey: false, altKey: false, shiftKey: false }, false)).toBe(false);
    expect(isTerminalPassThrough({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, true)).toBe(false);
    expect(isTerminalPassThrough({ ctrlKey: true, metaKey: false, altKey: false, shiftKey: false }, false)).toBe(false);
  });
});

// Nov 17 2026: the ＋ New menu's key, and Alt+letter on a Mac.
describe('newSession (the ＋ New menu)', () => {
  it('is bound by default, in its own section listed first', () => {
    const binding = buildBindings().find((b) => b.actionId === 'newSession');
    expect(binding?.section).toBe('Create');
    expect(binding?.combo?.key).toBe('n');
    expect(binding?.combo?.altKey).toBe(true);
    expect(SECTION_ORDER[0]).toBe('Create');
  });

  it('matches the physical key when Alt turns the letter into a dead key (macOS Alt+N)', () => {
    const combo = { key: 'n', altKey: true, metaKey: true };
    const event = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);
    expect(comboMatchesEvent(combo, event({ key: 'Dead', code: 'KeyN', altKey: true, metaKey: true }))).toBe(true);
    expect(comboMatchesEvent(combo, event({ key: 'n', code: 'KeyN', altKey: true, metaKey: true }))).toBe(true);
    expect(comboMatchesEvent(combo, event({ key: 'Dead', code: 'KeyE', altKey: true, metaKey: true }))).toBe(false);
    expect(comboMatchesEvent(combo, event({ key: 'Dead', code: 'KeyN', altKey: true }))).toBe(false);
  });
});
