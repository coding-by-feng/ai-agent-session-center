/**
 * The session-number shortcuts, through the real useKeyboardShortcuts hook:
 * Alt+⌘+0 (Alt+Ctrl+0 off macOS) opens the "go to session #" box, from the
 * terminal too; Alt+⌘+1…9 switch using the same numbering as the badges.
 * The modifier follows the real `isMac`, like SessionSwitchOverlay.test.tsx.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, act } from '@testing-library/react';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useUiStore } from '@/stores/uiStore';
import { useSessionStore } from '@/stores/sessionStore';
import { isMac } from '@/lib/shortcutKeys';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

function Harness() {
  useKeyboardShortcuts();
  return (
    <div className="xterm">
      <textarea aria-label="terminal input" />
    </div>
  );
}

const mod = isMac ? { metaKey: true } : { ctrlKey: true };

function press(target: EventTarget, code: string, key: string) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { code, key, altKey: true, ...mod, bubbles: true, cancelable: true }));
  });
}

const mk = (id: string, title: string, status = 'idle'): Session =>
  ({ sessionId: id, title, projectName: 'p', status, lastActivityAt: 0, events: [], promptHistory: [] } as unknown as Session);

beforeEach(() => {
  useUiStore.setState({ sessionJumpOpen: false, detailPanelMinimized: false, activeModal: null });
  const list = [mk('a', 'alpha'), mk('b', 'bravo', 'working'), mk('c', 'charlie')];
  useSessionStore.setState({ sessions: new Map(list.map((s) => [s.sessionId, s])), selectedSessionId: null, previousSessionId: null });
});

describe('session-number shortcuts', () => {
  it('Alt+⌘+0 opens the go-to-session box', () => {
    render(<Harness />);
    press(document.body, 'Digit0', isMac ? 'º' : '0');
    expect(useUiStore.getState().sessionJumpOpen).toBe(true);
  });

  it('works while the terminal has focus', () => {
    const { getByLabelText } = render(<Harness />);
    const input = getByLabelText('terminal input');
    input.focus();
    press(input, 'Digit0', isMac ? 'º' : '0');
    expect(useUiStore.getState().sessionJumpOpen).toBe(true);
  });

  it('Alt+⌘+1 goes to badge #1 — the working session sorts first', () => {
    render(<Harness />);
    press(document.body, 'Digit1', isMac ? '¡' : '1');
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
  });

  it('Alt+⌘+N on the session already open only un-minimizes it', () => {
    useSessionStore.getState().selectSession('b');
    useUiStore.setState({ detailPanelMinimized: true });
    const prev = useSessionStore.getState().previousSessionId;
    render(<Harness />);
    press(document.body, 'Digit1', isMac ? '¡' : '1');
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
    expect(useSessionStore.getState().previousSessionId).toBe(prev);
  });
});
