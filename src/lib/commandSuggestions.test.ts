import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_SESSION_COMMANDS,
  getCommandSuggestions,
  saveCommand,
} from './commandSuggestions';

describe('commandSuggestions', () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      get length() { return store.size; },
      clear() { store.clear(); },
      getItem(key: string) { return store.get(key) ?? null; },
      key(index: number) { return [...store.keys()][index] ?? null; },
      removeItem(key: string) { store.delete(key); },
      setItem(key: string, value: string) { store.set(key, String(value)); },
    } satisfies Storage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('includes the Codex bypass preset in the shared defaults', () => {
    expect(DEFAULT_SESSION_COMMANDS).toContain(
      'codex --dangerously-bypass-approvals-and-sandbox',
    );
  });

  it('sorts used commands first and does not duplicate defaults', () => {
    saveCommand('codex --dangerously-bypass-approvals-and-sandbox');
    saveCommand('claude');
    saveCommand('codex --dangerously-bypass-approvals-and-sandbox');

    const suggestions = getCommandSuggestions();

    expect(suggestions[0]).toBe('codex --dangerously-bypass-approvals-and-sandbox');
    expect(suggestions[1]).toBe('claude');
    expect(
      suggestions.filter((cmd) => cmd === 'codex --dangerously-bypass-approvals-and-sandbox'),
    ).toHaveLength(1);
  });
});
