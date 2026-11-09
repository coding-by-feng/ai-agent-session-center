// shortcutKeys.test.ts — the `/` session-search key (Nov 9 2026).
import { describe, it, expect } from 'vitest';
import { buildBindings, comboMatchesEvent } from './shortcutKeys';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('the searchSessions shortcut', () => {
  const combo = buildBindings().find((b) => b.actionId === 'searchSessions')?.combo ?? null;

  it('is bound to a plain / by default', () => {
    expect(combo).toEqual({ key: '/' });
  });

  it('matches / typed without modifiers', () => {
    expect(comboMatchesEvent(combo, key({ key: '/' }))).toBe(true);
  });

  it('matches / on layouts that need Shift for it (German: Shift+7)', () => {
    expect(comboMatchesEvent(combo, key({ key: '/', shiftKey: true }))).toBe(true);
  });

  it('does not fire with Cmd, Ctrl or Alt held', () => {
    expect(comboMatchesEvent(combo, key({ key: '/', metaKey: true }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: '/', ctrlKey: true }))).toBe(false);
    expect(comboMatchesEvent(combo, key({ key: '/', altKey: true }))).toBe(false);
  });
});
