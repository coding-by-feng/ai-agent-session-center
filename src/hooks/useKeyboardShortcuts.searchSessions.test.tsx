// ⌘K / Ctrl+K focuses the session strip's search box (Nov 18 2026; `/` before): from a focused terminal on a
// Mac too, not from inside a field, not behind a dialog.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useUiStore } from '@/stores/uiStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { buildBindings, isMac } from '@/lib/shortcutKeys';
import { SESSION_SEARCH_FOCUS_EVENT } from '@/lib/sessionStrip';

function Harness() {
  useKeyboardShortcuts();
  return null;
}

const SEARCH = isMac ? { key: 'k', metaKey: true } : { key: 'k', ctrlKey: true };

describe('the session-search key', () => {
  let fired = 0;
  const onFocus = () => { fired += 1; };

  beforeEach(() => {
    fired = 0;
    useUiStore.setState({ activeModal: null });
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    document.addEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus);
  });

  afterEach(() => {
    document.removeEventListener(SESSION_SEARCH_FOCUS_EVENT, onFocus);
    useUiStore.setState({ activeModal: null });
  });

  it('asks the strip to focus its search box', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, SEARCH);
    expect(fired).toBe(1);
  });

  it('a plain / no longer opens it', () => {
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(fired).toBe(0);
  });

  it('leaves the key to a text field', () => {
    render(<><Harness /><input aria-label="field" /></>);
    const input = document.querySelector('input')!;
    fireEvent.keyDown(input, SEARCH);
    expect(fired).toBe(0);
  });

  it('a focused terminal hands it over only where it is not the shell\'s key', () => {
    render(<><Harness /><div className="xterm"><textarea aria-label="term" /></div></>);
    fireEvent.keyDown(document.querySelector('textarea')!, SEARCH);
    // ⌘K never reaches a shell; Ctrl+K is readline's kill-line, so it stays in the terminal.
    expect(fired).toBe(isMac ? 1 : 0);
  });

  it('does nothing while a dialog is open', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<Harness />);
    fireEvent.keyDown(document.body, SEARCH);
    expect(fired).toBe(0);
  });
});
