/**
 * The "go to session #" box (Alt+⌘+0 by default): type a session's badge
 * number and it switches there. Rendered for real against the real stores,
 * with keys dispatched at a focused stand-in "terminal" textarea — the box
 * reads keys at the document and must keep them away from the terminal
 * without ever taking focus.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { render, screen, act } from '@testing-library/react';
import SessionJumpOverlay from './SessionJumpOverlay';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

// 23 idle sessions titled s01…s23: numbered in title order, so #n is s{n}.
const pad = (n: number) => String(n).padStart(2, '0');
const mk = (n: number): Session =>
  ({ sessionId: `id${pad(n)}`, title: `s${pad(n)}`, projectName: 'p', status: 'idle', lastActivityAt: 0, events: [], promptHistory: [] } as unknown as Session);

let terminalKeys: string[] = [];

function setup() {
  const sessions = Array.from({ length: 23 }, (_, i) => mk(i + 1));
  useSessionStore.setState({ sessions: new Map(sessions.map((x) => [x.sessionId, x])), selectedSessionId: null, previousSessionId: null });
  useUiStore.setState({ sessionJumpOpen: false, detailPanelMinimized: false });
  terminalKeys = [];
  render(
    <>
      <textarea aria-label="terminal" onKeyDown={(e) => terminalKeys.push(e.key)} />
      <SessionJumpOverlay />
    </>,
  );
  const terminal = screen.getByLabelText('terminal');
  terminal.focus();
  act(() => { useUiStore.getState().openSessionJump(); });
  return terminal;
}

/** A keydown at the focused terminal, as a real keystroke would arrive. */
function press(target: Element, key: string, code?: string, extra: KeyboardEventInit = {}) {
  act(() => {
    target.dispatchEvent(new KeyboardEvent('keydown', { key, code: code ?? (/^\d$/.test(key) ? `Digit${key}` : key), bubbles: true, cancelable: true, ...extra }));
  });
}

beforeEach(() => {
  useUiStore.setState({ sessionJumpOpen: false });
});

describe('SessionJumpOverlay', () => {
  it('renders nothing until opened', () => {
    useUiStore.setState({ sessionJumpOpen: false });
    render(<SessionJumpOverlay />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('"1" waits (it could be 10–19) and previews #1; "3" then jumps to #13', () => {
    const t = setup();
    press(t, '1');
    expect(screen.getByRole('dialog')).toHaveTextContent('s01');
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    press(t, '3');
    expect(useSessionStore.getState().selectedSessionId).toBe('id13');
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('keeps the digits out of the terminal and never takes focus', () => {
    const t = setup();
    press(t, '1');
    press(t, '3');
    expect(terminalKeys).toEqual([]);
    expect(document.activeElement).toBe(t);
  });

  it('reads Option+digit by its physical key (Option+1 types "¡" on a Mac)', () => {
    const t = setup();
    press(t, '¡', 'Digit1', { altKey: true, metaKey: true });
    press(t, '™', 'Digit3', { altKey: true, metaKey: true });
    expect(useSessionStore.getState().selectedSessionId).toBe('id13');
  });

  it('Enter opens a number that could still grow', () => {
    const t = setup();
    press(t, '2');
    press(t, 'Enter');
    expect(useSessionStore.getState().selectedSessionId).toBe('id02');
  });

  it('an out-of-range number says so and Enter does nothing', () => {
    const t = setup();
    press(t, '4');
    expect(useSessionStore.getState().selectedSessionId).toBe('id04'); // "4" of 23 is final
    act(() => { useUiStore.getState().openSessionJump(); });
    press(t, '2');
    press(t, '9');
    expect(screen.getByRole('dialog')).toHaveTextContent(/No session #29/);
    press(t, 'Enter');
    expect(useSessionStore.getState().selectedSessionId).toBe('id04');
    expect(screen.getByRole('dialog')).toBeInTheDocument();
  });

  it('Backspace edits; Escape closes without switching', () => {
    const t = setup();
    press(t, '2');
    press(t, 'Backspace');
    expect(screen.getByRole('dialog')).not.toHaveTextContent('s02');
    press(t, 'Escape');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(terminalKeys).toEqual([]);
  });

  it('any other key closes the box and reaches the terminal', () => {
    const t = setup();
    press(t, 'a');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(terminalKeys).toEqual(['a']);
  });

  it('a leading 0 is ignored', () => {
    const t = setup();
    press(t, '0');
    expect(screen.getByRole('dialog')).not.toHaveTextContent(/No session/);
    press(t, '7');
    expect(useSessionStore.getState().selectedSessionId).toBe('id07');
  });
});
