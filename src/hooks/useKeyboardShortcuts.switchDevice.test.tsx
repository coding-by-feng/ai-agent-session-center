// The switchDevice key (⇧⌘S / Ctrl+Shift+S) asks the devices panel for its Switch part: from the page and from a
// focused terminal, not from inside a text field, not behind a dialog, and not in a window that has no switcher.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { fireEvent, render } from '@testing-library/react';

import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useUiStore } from '@/stores/uiStore';
import { useShortcutStore } from '@/stores/shortcutStore';
import { buildBindings, isMac } from '@/lib/shortcutKeys';
import { DEVICES_SWITCH_EVENT } from '@/lib/devicesSwitcher';

function Harness() {
  useKeyboardShortcuts();
  return null;
}

const KEY = isMac ? { key: 's', shiftKey: true, metaKey: true } : { key: 'S', shiftKey: true, ctrlKey: true };

describe('the switchDevice key', () => {
  let asked = 0;
  const onAsk = () => { asked += 1; };

  function withAccountChannels(): void {
    window.electronAPI = { remotes: { accountMachines: () => Promise.resolve({ ok: true, data: { state: 'signed-out' } }) } } as unknown as typeof window.electronAPI;
    useShortcutStore.setState({ bindings: buildBindings() } as never);
  }

  beforeEach(() => {
    asked = 0;
    useUiStore.setState({ activeModal: null });
    document.addEventListener(DEVICES_SWITCH_EVENT, onAsk);
  });

  afterEach(() => {
    document.removeEventListener(DEVICES_SWITCH_EVENT, onAsk);
    delete window.electronAPI;
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    useUiStore.setState({ activeModal: null });
  });

  it('asks the devices panel for its Switch part, and takes the key', () => {
    withAccountChannels();
    render(<Harness />);
    expect(fireEvent.keyDown(document.body, KEY)).toBe(false);
    expect(asked).toBe(1);
    // Again: the panel decides what a second press does (it closes).
    fireEvent.keyDown(document.body, KEY);
    expect(asked).toBe(2);
  });

  it('fires from a focused terminal: the key types nothing there', () => {
    withAccountChannels();
    render(<><Harness /><div className="xterm"><textarea aria-label="term" /></div></>);
    expect(fireEvent.keyDown(document.querySelector('textarea')!, KEY)).toBe(false);
    expect(asked).toBe(1);
  });

  it('leaves the key to a text field', () => {
    withAccountChannels();
    render(<><Harness /><input aria-label="field" /></>);
    expect(fireEvent.keyDown(document.querySelector('input')!, KEY)).toBe(true);
    expect(asked).toBe(0);
  });

  it('does nothing while a dialog is open', () => {
    withAccountChannels();
    useUiStore.setState({ activeModal: 'settings' });
    render(<Harness />);
    fireEvent.keyDown(document.body, KEY);
    expect(asked).toBe(0);
  });

  it('is nobody’s key in a window with no switcher: it passes through untouched', () => {
    useShortcutStore.setState({ bindings: buildBindings() } as never);
    render(<Harness />);
    expect(fireEvent.keyDown(document.body, KEY)).toBe(true);
    expect(asked).toBe(0);
  });

  it('does not answer to Save (the same letter without Shift)', () => {
    withAccountChannels();
    render(<Harness />);
    const save = isMac ? { key: 's', metaKey: true } : { key: 's', ctrlKey: true };
    expect(fireEvent.keyDown(document.body, save)).toBe(true);
    expect(asked).toBe(0);
  });
});
