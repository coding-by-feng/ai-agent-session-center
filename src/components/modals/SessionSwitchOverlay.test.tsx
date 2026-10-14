/**
 * Render-check for the Cmd+Tab-style session switcher (hold Cmd/Ctrl, tap E
 * to cycle, release to switch).
 *
 * These render the REAL SessionSwitchOverlay against the REAL
 * useSessionSwitchHold hook and the real sessionStore, then dispatch actual
 * KeyboardEvents at `document` — the same "wire the composition, not just
 * the isolated logic" approach as QueueTab.test.tsx / SessionControlBar.test.tsx
 * in this codebase, and the only way to catch a bug in how the hook and the
 * component are wired together rather than in either alone.
 *
 * The modifier is derived from the real `isMac` export rather than hardcoded,
 * so this suite passes under whatever platform string the test runner's
 * jsdom reports.
 */
import { describe, it, expect, beforeEach, beforeAll } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';
import SessionSwitchOverlay from './SessionSwitchOverlay';
import { useSessionStore } from '@/stores/sessionStore';
import { isMac } from '@/lib/shortcutKeys';
import type { Session } from '@/types';

beforeAll(() => {
  // jsdom has no layout engine and doesn't implement scrollIntoView.
  Element.prototype.scrollIntoView ??= () => {};
});

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'test-project',
    projectPath: '/tmp/test',
    title: '',
    source: 'terminal',
    model: 'claude-sonnet-4-5-20250514',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...overrides,
  };
}

// KeyboardEvent inits for the ONE modifier this feature cares about — Meta
// on macOS, Control everywhere else — mirroring useSessionSwitchHold's own
// isMac branch exactly.
const holdDownInit = isMac ? { key: 'e', metaKey: true } : { key: 'e', ctrlKey: true };
const releaseModifierInit = isMac ? { key: 'Meta' } : { key: 'Control' };

function tapE() {
  fireEvent.keyDown(document, holdDownInit);
}

function releaseModifier() {
  fireEvent.keyUp(document, releaseModifierInit);
}

// The arrows are pressed while the modifier is still held, so the events carry it.
const heldModifier = isMac ? { metaKey: true } : { ctrlKey: true };
function arrow(key: 'ArrowDown' | 'ArrowUp', extra: KeyboardEventInit = {}) {
  fireEvent.keyDown(document, { key, ...heldModifier, ...extra });
}

describe('SessionSwitchOverlay — hold-to-cycle session switcher', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null, previousSessionId: null });
  });

  it('renders nothing until the modifier+E is pressed', () => {
    useSessionStore.getState().addSession(makeSession({ sessionId: 'a', title: 'Session A' }));
    render(<SessionSwitchOverlay />);
    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
  });

  it('opens on hold+tap, listing other live sessions most-recently-active first, excluding the current one', () => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'older', title: 'Older', lastActivityAt: 500 }));
    store.addSession(makeSession({ sessionId: 'newer', title: 'Newer', lastActivityAt: 900 }));
    store.addSession(makeSession({ sessionId: 'gone', title: 'Ended', status: 'ended', lastActivityAt: 2000 }));
    store.selectSession('current');

    render(<SessionSwitchOverlay />);
    tapE();

    expect(screen.getByText('SWITCH SESSION')).toBeInTheDocument();
    expect(screen.queryByText('Current')).not.toBeInTheDocument();
    expect(screen.queryByText('Ended')).not.toBeInTheDocument();
    const rows = screen.getAllByRole('button');
    expect(rows.map((r) => r.textContent).join('|')).toMatch(/Newer.*Older/);
  });

  it('does not open when there is no other live session to switch to', () => {
    useSessionStore.getState().addSession(makeSession({ sessionId: 'only', title: 'Only' }));
    useSessionStore.getState().selectSession('only');
    render(<SessionSwitchOverlay />);
    tapE();
    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
  });

  it('each tap while held advances the highlight, wrapping at the end', () => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.addSession(makeSession({ sessionId: 'c', title: 'C', lastActivityAt: 800 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE(); // open — highlight on B (most recent other)
    expect(screen.getByRole('button', { name: 'Switch to B' })).toHaveAttribute('aria-current', 'true');

    tapE(); // advance — highlight on C
    expect(screen.getByRole('button', { name: 'Switch to C' })).toHaveAttribute('aria-current', 'true');

    tapE(); // wrap — highlight back on B
    expect(screen.getByRole('button', { name: 'Switch to B' })).toHaveAttribute('aria-current', 'true');
  });

  it('OS auto-repeat while E is held does not keep advancing the highlight', () => {
    // "Repeat to click E" means discrete taps, not holding the key down — a
    // held key firing native OS auto-repeat keydowns must not fly the
    // highlight past the intended target.
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.addSession(makeSession({ sessionId: 'c', title: 'C', lastActivityAt: 800 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE(); // real, discrete press — opens, highlight on B
    // Exactly ONE repeat event, on a 2-item list: with the guard, this is a
    // no-op (stays on B). Without it, this would be indistinguishable from a
    // second real tap and advance to C — two repeats would wrap back to B by
    // coincidence and silently pass either way, which is what the first
    // version of this test did.
    fireEvent.keyDown(document, { ...holdDownInit, repeat: true });

    expect(screen.getByRole('button', { name: 'Switch to B' })).toHaveAttribute('aria-current', 'true');
  });

  it('releasing the modifier commits the highlighted session and closes the popup', () => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.addSession(makeSession({ sessionId: 'c', title: 'C', lastActivityAt: 800 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE(); // open, highlight B
    tapE(); // advance, highlight C
    releaseModifier();

    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
    expect(useSessionStore.getState().selectedSessionId).toBe('c');
  });

  it('Escape cancels without switching', () => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE();
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
    expect(useSessionStore.getState().selectedSessionId).toBe('current');
  });

  it('losing window focus while open cancels without switching', () => {
    // Guards the "stuck open" hazard: if a keyup can be swallowed by the OS
    // (e.g. genuinely Cmd-Tabbing away with E still held), the popup must not
    // stay open forever with no way to close it.
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE();
    expect(screen.getByText('SWITCH SESSION')).toBeInTheDocument();

    // A raw dispatchEvent (unlike RTL's fireEvent) isn't auto-wrapped in
    // act() — the resulting setState needs it.
    act(() => {
      window.dispatchEvent(new Event('blur'));
    });

    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
    expect(useSessionStore.getState().selectedSessionId).toBe('current');
  });

  it('the tab being hidden (visibilitychange) while open also cancels', () => {
    // Distinct code path from 'blur' — covers minimize / switching virtual
    // desktops, which don't always fire a window blur event.
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE();
    expect(screen.getByText('SWITCH SESSION')).toBeInTheDocument();

    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    act(() => {
      document.dispatchEvent(new Event('visibilitychange'));
    });

    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
    expect(useSessionStore.getState().selectedSessionId).toBe('current');

    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });

  it('clicking a row commits it directly, without waiting for modifier release', () => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B', lastActivityAt: 900 }));
    store.addSession(makeSession({ sessionId: 'c', title: 'C', lastActivityAt: 800 }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    tapE(); // open — B highlighted
    fireEvent.click(screen.getByRole('button', { name: 'Switch to C' }));

    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
    expect(useSessionStore.getState().selectedSessionId).toBe('c');
  });

  it('an unrelated keydown (no modifier) neither opens nor interferes', () => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current' }));
    store.addSession(makeSession({ sessionId: 'b', title: 'B' }));
    store.selectSession('current');
    render(<SessionSwitchOverlay />);

    fireEvent.keyDown(document, { key: 'e' }); // plain "e", no modifier
    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
  });
});

// ↑ and ↓ move the highlight while the popup is open, so the row you want can be
// reached in either direction, not only by tapping E forward.
describe('SessionSwitchOverlay — ↑ / ↓ move the highlight', () => {
  const seed = (...ids: string[]) => {
    const store = useSessionStore.getState();
    store.addSession(makeSession({ sessionId: 'current', title: 'Current', lastActivityAt: 1000 }));
    ids.forEach((id, i) => store.addSession(makeSession({ sessionId: id, title: id.toUpperCase(), lastActivityAt: 900 - i * 100 })));
    store.selectSession('current');
  };
  const highlighted = (name: string) =>
    expect(screen.getByRole('button', { name: `Switch to ${name}` })).toHaveAttribute('aria-current', 'true');

  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null, previousSessionId: null });
  });

  it('↓ moves to the next row and ↑ back to the previous one', () => {
    seed('b', 'c', 'd');
    render(<SessionSwitchOverlay />);
    tapE(); // open on B
    arrow('ArrowDown');
    highlighted('C');
    arrow('ArrowDown');
    highlighted('D');
    arrow('ArrowUp');
    highlighted('C');
  });

  it('wraps: ↑ on the first row goes to the last, ↓ on the last goes to the first', () => {
    seed('b', 'c', 'd');
    render(<SessionSwitchOverlay />);
    tapE(); // B is first
    arrow('ArrowUp');
    highlighted('D');
    arrow('ArrowDown');
    highlighted('B');
  });

  it('releasing the modifier commits the row chosen with the arrows', () => {
    seed('b', 'c', 'd');
    render(<SessionSwitchOverlay />);
    tapE();
    arrow('ArrowDown');
    arrow('ArrowDown'); // D
    releaseModifier();
    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
    expect(useSessionStore.getState().selectedSessionId).toBe('d');
  });

  it('mixes with E: E still steps forward from wherever the arrows left the highlight', () => {
    seed('b', 'c', 'd');
    render(<SessionSwitchOverlay />);
    tapE(); // B
    arrow('ArrowDown'); // C
    tapE(); // D
    highlighted('D');
    arrow('ArrowUp'); // C
    highlighted('C');
  });

  it('holding an arrow keeps moving (unlike E, an auto-repeating arrow is deliberate)', () => {
    seed('b', 'c', 'd');
    render(<SessionSwitchOverlay />);
    tapE(); // B
    arrow('ArrowDown', { repeat: true });
    highlighted('C');
    arrow('ArrowDown', { repeat: true });
    highlighted('D');
  });

  it('moves whatever else is held with the modifier (a stray Shift or Alt must not leak the key to the terminal)', () => {
    seed('b', 'c');
    render(<SessionSwitchOverlay />);
    tapE(); // B
    arrow('ArrowDown', { shiftKey: true });
    highlighted('C');
    arrow('ArrowUp', { altKey: true });
    highlighted('B');
  });

  it('with a single other session the arrows change nothing and break nothing', () => {
    seed('b');
    render(<SessionSwitchOverlay />);
    tapE();
    arrow('ArrowDown');
    arrow('ArrowUp');
    highlighted('B');
  });

  it('while open, the arrows are swallowed: the focused input never sees them and the default is prevented', () => {
    seed('b', 'c');
    render(
      <>
        <SessionSwitchOverlay />
        <textarea data-testid="field" />
      </>,
    );
    const field = screen.getByTestId('field') as HTMLTextAreaElement;
    const seen: string[] = [];
    field.addEventListener('keydown', (e) => seen.push(e.key));
    field.focus();

    tapE();
    const notPrevented = fireEvent.keyDown(field, { key: 'ArrowDown', ...heldModifier });

    expect(seen).toEqual([]); // a terminal or an autocomplete list would have moved
    expect(notPrevented).toBe(false); // so no caret jump or page scroll either
    highlighted('C');
  });

  it('while closed, the arrows are left alone: the focused input sees them and the default stands', () => {
    seed('b', 'c');
    render(
      <>
        <SessionSwitchOverlay />
        <textarea data-testid="field" />
      </>,
    );
    const field = screen.getByTestId('field') as HTMLTextAreaElement;
    const seen: string[] = [];
    field.addEventListener('keydown', (e) => seen.push(e.key));
    field.focus();

    const notPrevented = fireEvent.keyDown(field, { key: 'ArrowDown' });

    expect(seen).toEqual(['ArrowDown']);
    expect(notPrevented).toBe(true);
    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();
  });

  it('once cancelled or committed the arrows are released again', () => {
    seed('b', 'c');
    render(
      <>
        <SessionSwitchOverlay />
        <textarea data-testid="field" />
      </>,
    );
    const field = screen.getByTestId('field') as HTMLTextAreaElement;
    tapE();
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(fireEvent.keyDown(field, { key: 'ArrowUp' })).toBe(true);

    tapE();
    releaseModifier();
    expect(fireEvent.keyDown(field, { key: 'ArrowUp' })).toBe(true);
  });

  it('tells the user about the arrows in the header', () => {
    seed('b');
    render(<SessionSwitchOverlay />);
    tapE();
    expect(screen.getByText(/tap E or ↑↓/)).toBeInTheDocument();
  });

  it('an arrow still held when the modifier is released does not keep typing into the new session', () => {
    seed('b', 'c');
    render(
      <>
        <SessionSwitchOverlay />
        <textarea data-testid="field" />
      </>,
    );
    const field = screen.getByTestId('field') as HTMLTextAreaElement;
    const seen: string[] = [];
    field.addEventListener('keydown', (e) => seen.push(e.key));
    field.focus();

    tapE();
    arrow('ArrowDown'); // the real press, held down
    releaseModifier(); // commits; the held key is now a bare auto-repeat
    expect(screen.queryByText('SWITCH SESSION')).not.toBeInTheDocument();

    expect(fireEvent.keyDown(field, { key: 'ArrowDown', repeat: true })).toBe(false); // swallowed
    expect(fireEvent.keyDown(field, { key: 'ArrowDown', repeat: true })).toBe(false);
    expect(seen).toEqual([]);

    // the next key that is not a repeat ends it: a fresh press is the user's again
    expect(fireEvent.keyDown(field, { key: 'ArrowDown' })).toBe(true);
    expect(seen).toEqual(['ArrowDown']);
    expect(fireEvent.keyDown(field, { key: 'ArrowDown', repeat: true })).toBe(true);
  });

  it('leaves the arrows to an IME candidate list that is open', () => {
    seed('b', 'c');
    render(<SessionSwitchOverlay />);
    tapE(); // B
    arrow('ArrowDown', { isComposing: true });
    highlighted('B');
  });
});

