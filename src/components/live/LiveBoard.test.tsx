// LiveBoard.test.tsx — the 3D-off LIVE page on a desktop, when sessions exist:
// a card per session, in the rail's order, each opening its session panel.
// Plus the one-time tip above it, which points at how to open one.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import type { Session } from '@/types';

import LiveBoard from './LiveBoard';
import { boardSessions } from '@/lib/liveBoard';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWsStore } from '@/stores/wsStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { ROOM_COLOR_PALETTE } from '@/lib/roomColor';

const s = (id: string, over: Partial<Session> = {}): Session =>
  ({
    sessionId: id,
    title: id,
    projectName: 'agent-manager',
    status: 'idle',
    lastActivityAt: 1,
    events: [],
    promptHistory: [],
    ...over,
  }) as unknown as Session;

function renderBoard(list: Session[], selectedSessionId: string | null = null) {
  useSessionStore.setState({
    sessions: new Map(list.map((x) => [x.sessionId, x])),
    selectedSessionId,
    previousSessionId: null,
    lastSelectedSessionId: null,
  });
  return render(<LiveBoard sessions={boardSessions(list)} />);
}

const cards = () => screen.getAllByRole('button', { name: /^Open / });

beforeEach(() => {
  useUiStore.setState({ detailPanelMinimized: false, liveHintDismissed: false });
  useSettingsStore.setState({ scene3dEnabled: false } as never);
  useWsStore.setState({ snapshotReceived: true });
  useRoomStore.setState({ rooms: [] });
});

describe('LiveBoard — the cards', () => {
  it('shows one card per session, in the order the rail numbers them', () => {
    renderBoard([
      s('Idle one', { status: 'idle' }),
      s('Busy one', { status: 'working' }),
      s('Pinned one', { status: 'idle', pinned: true }),
    ]);
    expect(cards().map((c) => c.getAttribute('data-session-id'))).toEqual(['Pinned one', 'Busy one', 'Idle one']);
  });

  it('counts the sessions in its heading', () => {
    renderBoard([s('a'), s('b'), s('c')]);
    expect(screen.getByRole('heading', { name: /Sessions \(3\)/i })).toBeInTheDocument();
  });

  it('names an untitled session the way the rest of the app does', () => {
    renderBoard([s('x', { title: '', projectName: 'kts' }), s('y', { title: '', projectName: '' })]);
    expect(screen.getByRole('button', { name: /^Open kts/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Open Unnamed/ })).toBeInTheDocument();
  });

  it('says the status in words and shows its icon, not colour alone', () => {
    renderBoard([s('a', { status: 'approval' })]);
    const card = cards()[0];
    expect(within(card).getByText('Approval needed')).toBeInTheDocument();
    expect(card.querySelector('svg')).not.toBeNull();
    expect(card.getAttribute('data-needs-you')).toBe('true');
  });

  // AASC-11: nearly every card is Claude, so "CLAUDE" on each told nobody anything.
  // The mark is kept for the exception (Codex) only.
  it('shows the project, marks only a non-Claude CLI, and skips the project when it is the title', () => {
    renderBoard([
      s('Fix the queue', { projectName: 'agent-manager', cliSource: 'codex' }),
      s('agent-manager', { projectName: 'agent-manager', cliSource: 'claude' }),
    ]);
    const fix = screen.getByRole('button', { name: /^Open Fix the queue/ });
    const sameAsTitle = screen.getByRole('button', { name: /^Open agent-manager/ });
    expect(within(fix).getByText('agent-manager')).toBeInTheDocument();
    expect(within(fix).getByText('Codex')).toBeInTheDocument();
    expect(within(sameAsTitle).getAllByText('agent-manager')).toHaveLength(1);
    expect(within(sameAsTitle).queryByText('Claude')).toBeNull();
  });
});

describe('LiveBoard — the filters', () => {
  const mixed = () => [
    s('w', { status: 'working' }),
    s('p', { status: 'prompting' }),
    s('a', { status: 'approval' }),
    s('i', { status: 'input' }),
    s('d', { status: 'waiting' }),
  ];

  it('shows All by default, with a count on every filter', () => {
    renderBoard(mixed());
    expect(screen.getByRole('button', { name: /^All 5$/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: /^Working 2$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: /^Needs you 2$/ })).toHaveAttribute('aria-pressed', 'false');
    expect(cards()).toHaveLength(5);
  });

  it('Working keeps only sessions that are busy', () => {
    renderBoard(mixed());
    fireEvent.click(screen.getByRole('button', { name: /^Working/ }));
    expect(cards().map((c) => c.getAttribute('data-session-id')).sort()).toEqual(['p', 'w']);
    expect(screen.getByRole('button', { name: /^Working/ })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Needs you keeps only sessions waiting on an approval or an answer', () => {
    renderBoard(mixed());
    fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    expect(cards().map((c) => c.getAttribute('data-session-id')).sort()).toEqual(['a', 'i']);
  });

  it('says so when a filter matches nothing, instead of an empty space', () => {
    renderBoard([s('d', { status: 'waiting' })]);
    fireEvent.click(screen.getByRole('button', { name: /^Needs you/ }));
    expect(screen.queryAllByRole('button', { name: /^Open / })).toHaveLength(0);
    expect(screen.getByText(/Nothing needs you right now/i)).toBeInTheDocument();
  });
});

describe('LiveBoard — opening a session', () => {
  it('a card click opens that session in the panel', () => {
    renderBoard([s('a'), s('b')]);
    act(() => useUiStore.setState({ detailPanelMinimized: true }));
    fireEvent.click(screen.getByRole('button', { name: /^Open b/ }));
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
  });

  it('clicking the card of the minimized session brings it back without re-selecting it', () => {
    renderBoard([s('a'), s('b')], 'a');
    act(() => useUiStore.setState({ detailPanelMinimized: true }));
    const prev = useSessionStore.getState().previousSessionId;
    fireEvent.click(screen.getByRole('button', { name: /^Open a/ }));
    expect(useSessionStore.getState().selectedSessionId).toBe('a');
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
    // Re-selecting the open session would make it its own "previous".
    expect(useSessionStore.getState().previousSessionId).toBe(prev);
  });

  it('a card click retires the tip: the user has found how to open a session', () => {
    renderBoard([s('a')]);
    fireEvent.click(screen.getByRole('button', { name: /^Open a/ }));
    expect(useUiStore.getState().liveHintDismissed).toBe(true);
  });
});

describe('LiveBoard — the one-time tip', () => {
  it('sits above the board until dismissed, and names both ways in', () => {
    renderBoard([s('a')]);
    const tip = screen.getByRole('note', { name: /tip/i });
    expect(tip).toHaveTextContent(/Open a session/i);
    expect(tip).toHaveTextContent(/card/i);
    expect(tip).toHaveTextContent(/LIVE/);
  });

  it('its ✕ retires it for good', () => {
    renderBoard([s('a')]);
    fireEvent.click(screen.getByRole('button', { name: /dismiss tip/i }));
    expect(screen.queryByRole('note', { name: /tip/i })).toBeNull();
    expect(useUiStore.getState().liveHintDismissed).toBe(true);
    expect(localStorage.getItem('live-hint-dismissed')).toBe('1');
  });

  it('is not shown once dismissed', () => {
    useUiStore.setState({ liveHintDismissed: true });
    renderBoard([s('a')]);
    expect(screen.queryByRole('note', { name: /tip/i })).toBeNull();
  });

  it('is not shown while a session panel is open over the page', () => {
    renderBoard([s('a')], 'a');
    expect(screen.queryByRole('note', { name: /tip/i })).toBeNull();
  });

  it('comes back with the board when that panel is minimized, until it is dismissed', () => {
    renderBoard([s('a')], 'a');
    act(() => useUiStore.setState({ detailPanelMinimized: true }));
    expect(screen.getByRole('note', { name: /tip/i })).toBeInTheDocument();
  });

  it('a click elsewhere on the page does not retire it', () => {
    renderBoard([s('a'), s('b', { status: 'working' })]);
    fireEvent.click(screen.getByRole('button', { name: /^Working/ }));
    expect(useUiStore.getState().liveHintDismissed).toBe(false);
    expect(screen.getByRole('note', { name: /tip/i })).toBeInTheDocument();
  });
});

describe('LiveBoard — a card never moves from under the pointer', () => {
  const order = () => cards().map((c) => c.getAttribute('data-session-id'));

  it('holds the order while the pointer is on the cards, and catches up when it leaves', () => {
    const before = [s('beta', { status: 'working' }), s('alpha', { status: 'waiting' })];
    const { rerender } = renderBoard(before);
    expect(order()).toEqual(['beta', 'alpha']);
    fireEvent.pointerEnter(screen.getByRole('list'));
    // beta finishes: the live order is now alpha, beta (same status, by title)
    rerender(<LiveBoard sessions={boardSessions([s('beta', { status: 'waiting' }), s('alpha', { status: 'waiting' })])} />);
    expect(order()).toEqual(['beta', 'alpha']);
    fireEvent.pointerLeave(screen.getByRole('list'));
    expect(order()).toEqual(['alpha', 'beta']);
  });

  it('holds it while keyboard focus is on a card, too', () => {
    const { rerender } = renderBoard([s('beta', { status: 'working' }), s('alpha', { status: 'waiting' })]);
    act(() => cards()[0].focus());
    rerender(<LiveBoard sessions={boardSessions([s('beta', { status: 'waiting' }), s('alpha', { status: 'waiting' })])} />);
    expect(order()).toEqual(['beta', 'alpha']);
    act(() => (document.activeElement as HTMLElement).blur());
    expect(order()).toEqual(['alpha', 'beta']);
  });
});

const room = (id: string, name: string, sessionIds: string[], roomIndex?: number): Room =>
  ({ id, name, sessionIds, collapsed: false, createdAt: 1, roomIndex }) as Room;

const card = (name: RegExp) => screen.getByRole('button', { name });

describe('LiveBoard — the room on a card', () => {
  it('names the room a session is in', () => {
    useRoomStore.setState({ rooms: [room('r1', 'Research A', ['a'], 0)] });
    renderBoard([s('a'), s('b')]);
    expect(within(card(/^Open a/)).getByText('Research A')).toBeInTheDocument();
  });

  it("paints the room's dot in the colour the session strip gives that room", () => {
    useRoomStore.setState({ rooms: [room('r1', 'Research A', ['a'], 2)] });
    renderBoard([s('a')]);
    const chip = within(card(/^Open a/)).getByText('Research A').parentElement as HTMLElement;
    expect(chip.style.getPropertyValue('--room-color')).toBe(ROOM_COLOR_PALETTE[2]);
  });

  it('calls a session in no room "Common Area" once any room exists', () => {
    useRoomStore.setState({ rooms: [room('r1', 'Research A', ['a'], 0)] });
    renderBoard([s('a'), s('b')]);
    expect(within(card(/^Open b/)).getByText('Common Area')).toBeInTheDocument();
    expect(within(card(/^Open a/)).queryByText('Common Area')).toBeNull();
  });

  it('shows no room at all while there are no rooms, so a first run stays quiet', () => {
    renderBoard([s('a')]);
    const c = card(/^Open a/);
    expect(within(c).queryByText('Common Area')).toBeNull();
    // not even an empty chip: a room that is shown is a room that is named in the button's name
    expect(c.getAttribute('aria-label')).not.toMatch(/Room/);
  });

  it("puts the room in the button's name, because its visible text is part of the name", () => {
    useRoomStore.setState({ rooms: [room('r1', 'Research A', ['a'], 0)] });
    renderBoard([s('a', { projectName: 'exmouth' })]);
    expect(screen.getByRole('button', { name: /^Open a — Idle — exmouth — Room Research A/ })).toBeInTheDocument();
  });

  it('follows a session when it is moved to another room', () => {
    useRoomStore.setState({ rooms: [room('r1', 'Research A', ['a'], 0), room('r2', 'Build', [], 1)] });
    renderBoard([s('a')]);
    expect(within(card(/^Open a/)).getByText('Research A')).toBeInTheDocument();
    act(() => useRoomStore.setState({ rooms: [room('r1', 'Research A', [], 0), room('r2', 'Build', ['a'], 1)] }));
    expect(within(card(/^Open a/)).getByText('Build')).toBeInTheDocument();
  });

  it('still opens the session, from the room chip too: the card stays one button', () => {
    useRoomStore.setState({ rooms: [room('r1', 'Research A', ['a'], 0)] });
    renderBoard([s('a'), s('b')]);
    fireEvent.click(within(card(/^Open a/)).getByText('Research A'));
    expect(useSessionStore.getState().selectedSessionId).toBe('a');
    for (const c of cards()) expect(c.querySelector('button, a, [role="button"]')).toBeNull();
  });
});

describe('LiveBoard — the note under the title', () => {
  const asked = (text: string) => [{ text, timestamp: 5 }];

  it('shows the last thing the session was asked', () => {
    renderBoard([s('a', { promptHistory: asked('fix the cart total') })]);
    const note = within(card(/^Open a/)).getByText('fix the cart total');
    expect(note).toHaveAttribute('data-kind', 'prompt');
  });

  it("shows the user's own remark instead, when there is one", () => {
    renderBoard([s('a', { remark: 'waiting on the client', promptHistory: asked('fix the cart total') })]);
    const c = card(/^Open a/);
    expect(within(c).getByText('waiting on the client')).toHaveAttribute('data-kind', 'remark');
    expect(within(c).queryByText('fix the cart total')).toBeNull();
  });

  it('skips a prompt the harness injected and shows the last one a person typed', () => {
    renderBoard([
      s('a', {
        promptHistory: [
          { text: 'fix the cart total', timestamp: 5 },
          { text: '<task-notification>build finished</task-notification>', timestamp: 6 },
        ],
      }),
    ]);
    const c = card(/^Open a/);
    expect(within(c).getByText('fix the cart total')).toBeInTheDocument();
    expect(within(c).queryByText(/task-notification/)).toBeNull();
  });

  it('has no note line when there is nothing to show', () => {
    renderBoard([s('a')]);
    expect(card(/^Open a/).querySelector('[data-kind]')).toBeNull();
  });

  it('describes the card by its note, so a screen reader hears it without it becoming the name', () => {
    renderBoard([s('a', { promptHistory: asked('fix the cart total') })]);
    const c = card(/^Open a/);
    const describedBy = c.getAttribute('aria-describedby');
    expect(describedBy).toBeTruthy();
    expect(document.getElementById(describedBy as string)).toHaveTextContent('fix the cart total');
    expect(c.getAttribute('aria-label')).not.toMatch(/fix the cart total/);
  });

  it('leaves aria-describedby off when there is no note', () => {
    renderBoard([s('a')]);
    expect(card(/^Open a/)).not.toHaveAttribute('aria-describedby');
  });
});

describe('LiveBoard — how long a quiet session has been quiet', () => {
  const T0 = new Date('2026-10-14T00:00:00Z').getTime();
  const quiet = (agoMs: number, over: Partial<Session> = {}) =>
    s('a', { status: 'idle', events: [{ type: 'Stop', timestamp: T0 - agoMs, detail: '' }], ...over });

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(T0);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows it beside the status of an idle session', () => {
    renderBoard([quiet(14 * 60_000)]);
    const c = card(/^Open a/);
    const age = within(c).getByText('14m');
    expect(age.previousElementSibling).toHaveTextContent('Idle');
  });

  it("puts it in the button's name too", () => {
    renderBoard([quiet(14 * 60_000)]);
    expect(screen.getByRole('button', { name: /^Open a — Idle — agent-manager — quiet for 14m/ })).toBeInTheDocument();
  });

  it('is left off a session that is busy', () => {
    renderBoard([quiet(14 * 60_000, { status: 'working' })]);
    expect(within(card(/^Open a/)).queryByText('14m')).toBeNull();
  });

  it('is left off a session with no work to measure from', () => {
    renderBoard([s('a', { status: 'idle', lastActivityAt: T0 })]);
    expect(within(card(/^Open a/)).queryByText(/^(<1m|\d+[mhd])$/)).toBeNull();
  });

  it('reads from the last work, not lastActivityAt, which a restore stamps on every session', () => {
    renderBoard([quiet(3 * 3_600_000, { lastActivityAt: T0 - 1_000 })]);
    expect(within(card(/^Open a/)).getByText('3h')).toBeInTheDocument();
  });

  it('keeps counting while nothing else changes: a minute later it has moved on', () => {
    renderBoard([quiet(14 * 60_000)]);
    expect(within(card(/^Open a/)).getByText('14m')).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(within(card(/^Open a/)).getByText('15m')).toBeInTheDocument();
  });

  it('shows nothing on a restored session: its prompts are older than the restart and say nothing about the last work', () => {
    renderBoard([
      s('a', {
        status: 'idle',
        events: [
          { type: 'TerminalCreated', timestamp: T0 - 60_000, detail: '' },
          { type: 'SessionStart', timestamp: T0 - 59_000, detail: '' },
        ],
        promptHistory: [{ text: 'build the pdf', timestamp: T0 - 3 * 3_600_000 }],
      }),
    ]);
    const c = card(/^Open a/);
    expect(within(c).queryByText(/^(<1m|\d+[mhd])$/)).toBeNull();
    expect(c.getAttribute('aria-label')).not.toMatch(/quiet for/);
  });

  it('stops its clock when the board goes away: the interval it started is the one cleared', () => {
    const clear = vi.spyOn(window, 'clearInterval');
    const { unmount } = renderBoard([quiet(14 * 60_000)]);
    const running = vi.getTimerCount();
    expect(clear).not.toHaveBeenCalled();
    unmount();
    expect(clear).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(running - 1);
    clear.mockRestore();
  });
});

describe('LiveBoard — stays a list of buttons for keyboard users', () => {
  it('every card is a real button inside a list', () => {
    renderBoard([s('a'), s('b')]);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    for (const card of cards()) expect(card.tagName).toBe('BUTTON');
  });
});

// jsdom does no layout, and Playwright's Chromium no longer has the UA rule, so
// neither can see this: the desktop app's Chromium 132 gives <button> an
// `align-items: flex-start`, and a card without its own `stretch` lets a long
// note paint across the next card and leaves the room chip mid-footer.
describe('LiveBoard — the card lays out the same in the desktop app', () => {
  it('the card button declares align-items: stretch itself', () => {
    const css = readFileSync(resolve(__dirname, '../../styles/modules/LiveBoard.module.css'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '');
    const card = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].find((m) => m[1].trim() === '.card');
    expect(card?.[2]).toMatch(/align-items\s*:\s*stretch\s*;/);
  });
});
