// `/` focuses the session strip's search box (Nov 9 2026): not from inside a field, not behind a dialog.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useUiStore } from '@/stores/uiStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { buildBindings } from '@/lib/shortcutKeys';
import { SESSION_SEARCH_FOCUS_EVENT } from '@/lib/sessionStrip';

function Harness() {
  useKeyboardShortcuts();
  return null;
}

describe('the / session-search key', () => {
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
    fireEvent.keyDown(document.body, { key: '/' });
    expect(fired).toBe(1);
  });

  it('types a / into a field instead', () => {
    render(<><Harness /><input aria-label="field" /></>);
    const input = document.querySelector('input')!;
    fireEvent.keyDown(input, { key: '/' });
    expect(fired).toBe(0);
  });

  it('does nothing while a dialog is open', () => {
    useUiStore.setState({ activeModal: 'settings' });
    render(<Harness />);
    fireEvent.keyDown(document.body, { key: '/' });
    expect(fired).toBe(0);
  });
});
