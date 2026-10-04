// LiveBoard.test.tsx — the 3D-off LIVE page on a desktop, when sessions exist:
// a card per session, in the rail's order, each opening its session panel.
// Plus the one-time tip above it, which points at how to open one.
import { describe, it, expect, beforeEach } from 'vitest';
import { act, render, screen, fireEvent, within } from '@testing-library/react';
import type { Session } from '@/types';

import LiveBoard from './LiveBoard';
import { boardSessions } from '@/lib/liveBoard';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { useWsStore } from '@/stores/wsStore';

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

  it('shows the project and the CLI, and skips the project when it is the title', () => {
    renderBoard([
      s('Fix the queue', { projectName: 'agent-manager', cliSource: 'codex' }),
      s('agent-manager', { projectName: 'agent-manager', cliSource: 'claude' }),
    ]);
    const fix = screen.getByRole('button', { name: /^Open Fix the queue/ });
    const sameAsTitle = screen.getByRole('button', { name: /^Open agent-manager/ });
    expect(within(fix).getByText('agent-manager')).toBeInTheDocument();
    expect(within(fix).getByText('Codex')).toBeInTheDocument();
    expect(within(sameAsTitle).getAllByText('agent-manager')).toHaveLength(1);
    expect(within(sameAsTitle).getByText('Claude')).toBeInTheDocument();
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

describe('LiveBoard — stays a list of buttons for keyboard users', () => {
  it('every card is a real button inside a list', () => {
    renderBoard([s('a'), s('b')]);
    const list = screen.getByRole('list');
    expect(within(list).getAllByRole('listitem')).toHaveLength(2);
    for (const card of cards()) expect(card.tagName).toBe('BUTTON');
  });
});
