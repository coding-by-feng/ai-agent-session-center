// SessionSwitcher.search.test.tsx — the search box above the session list (Nov 9 2026).
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act, within } from '@testing-library/react';

import SessionSwitcher from './SessionSwitcher';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useRoomStore, type Room } from '@/stores/roomStore';
import { useCentralFeatureStore } from '@/stores/centralFeatureStore';
import { SESSION_SEARCH_FOCUS_EVENT } from '@/lib/sessionStrip';

// See SessionSwitcher.test.tsx: the recent-directories menu's fetch, held still.
const { KNOWN_PROJECTS } = vi.hoisted(() => ({ KNOWN_PROJECTS: [] as string[] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN_PROJECTS }));

const makeSession = (over: Partial<Session>): Session => ({
  sessionId: 's',
  title: 'Session',
  projectName: 'agent-manager',
  projectPath: '/Users/me/agent-manager',
  status: 'idle',
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  ...over,
} as Session);

const room = (over: Partial<Room>): Room => ({
  id: 'r', name: 'Room', sessionIds: [], collapsed: false, createdAt: 0, ...over,
});

const current = makeSession({ sessionId: 'cur', title: 'Current work' });
const alpha = makeSession({ sessionId: 'a', title: 'Alpha fixes', pinned: true });
const beta = makeSession({ sessionId: 'b', title: 'Beta docs', projectName: 'website', projectPath: '/w/website' });
const gamma = makeSession({ sessionId: 'g', title: 'Gamma tests', remark: 'flaky login' });

function renderStrip(onSwitch = vi.fn()) {
  const all = [current, alpha, beta, gamma];
  render(
    <SessionSwitcher
      currentSession={current}
      sessions={new Map(all.map((s) => [s.sessionId, s]))}
      onSwitch={onSwitch}
    />,
  );
  return { onSwitch, box: screen.getByRole('textbox', { name: /search sessions/i }) as HTMLInputElement };
}

const strip = () => document.querySelector('[class*="sessionTabStrip"]') as HTMLElement;
const cardTitles = () =>
  within(strip()).queryAllByRole('button').map((b) => b.textContent ?? '');
const listed = (title: string) => cardTitles().some((t) => t.includes(title));

describe('SessionSwitcher — search box', () => {
  beforeEach(() => {
    useCentralFeatureStore.setState({ on: true });
    useSessionStore.setState({ sessions: new Map() } as never);
    useUiStore.setState({
      activeModal: null, sessionSortMode: 'room', navPosition: 'left',
      maximized: false, navRailCollapsed: false, pinnedRoomHidden: false, selectedRoomIds: new Set(),
    });
    useRoomStore.setState({
      rooms: [
        room({ id: 'r1', name: 'Front', sessionIds: ['cur', 'a'], listOrder: 0 }),
        room({ id: 'r2', name: 'Back', sessionIds: ['b', 'g'], listOrder: 1, collapsed: true }),
      ],
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useRoomStore.setState({ rooms: [] });
    useUiStore.setState({ navPosition: 'top', navRailCollapsed: false, maximized: false });
    vi.unstubAllGlobals();
  });

  it('narrows the cards to the matches as you type, and counts them', () => {
    const { box } = renderStrip();
    fireEvent.change(box, { target: { value: 'website' } });
    expect(listed('Beta docs')).toBe(true);
    expect(listed('Alpha fixes')).toBe(false);
    expect(listed('Gamma tests')).toBe(false);
    expect(screen.getByText('1 of 4 sessions match')).toBeInTheDocument();
  });

  it('matches the remark too, and every word must match', () => {
    const { box } = renderStrip();
    fireEvent.change(box, { target: { value: 'flaky' } });
    expect(listed('Gamma tests')).toBe(true);
    fireEvent.change(box, { target: { value: 'flaky beta' } });
    expect(listed('Gamma tests')).toBe(false);
  });

  it('opens a folded room while searching, and lists each match once (no PINNED copy)', () => {
    const { box } = renderStrip();
    // Back is folded: its cards are hidden until a search reaches into it.
    expect(listed('Gamma tests')).toBe(false);
    expect(screen.getByText('Pinned')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'a' } });
    expect(listed('Gamma tests')).toBe(true);
    expect(screen.queryByText('Pinned')).not.toBeInTheDocument();
    expect(cardTitles().filter((t) => t.includes('Alpha fixes'))).toHaveLength(1);
  });

  it('hides room reordering while a search hides rooms', () => {
    const { box } = renderStrip();
    expect(screen.getAllByLabelText(/^Move room .* down$/).length).toBeGreaterThan(0);
    fireEvent.change(box, { target: { value: 'alpha' } });
    expect(screen.queryAllByLabelText(/^Move room .* down$/)).toHaveLength(0);
  });

  it('Enter opens the first match that is not the open session', () => {
    const { box, onSwitch } = renderStrip();
    fireEvent.change(box, { target: { value: 'e' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSwitch).toHaveBeenCalledTimes(1);
    expect(onSwitch.mock.calls[0][0]).not.toBe('cur');
  });

  it('Enter in an empty box switches nowhere', () => {
    const { box, onSwitch } = renderStrip();
    fireEvent.keyDown(box, { key: 'Enter' });
    fireEvent.change(box, { target: { value: '   ' } });
    fireEvent.keyDown(box, { key: 'Enter' });
    expect(onSwitch).not.toHaveBeenCalled();
  });

  it('ignores Enter and Escape while an IME is composing (pinyin, kana)', () => {
    const { box, onSwitch } = renderStrip();
    fireEvent.change(box, { target: { value: 'beta' } });
    fireEvent.keyDown(box, { key: 'Enter', isComposing: true });
    fireEvent.keyDown(box, { key: 'Enter', keyCode: 229 });
    fireEvent.keyDown(box, { key: 'Escape', isComposing: true });
    expect(onSwitch).not.toHaveBeenCalled();
    expect(box.value).toBe('beta');
  });

  it('hides the fold toggles while a search holds every frame open', () => {
    const { box } = renderStrip();
    expect(screen.getByLabelText('Expand room Back')).toBeInTheDocument();
    fireEvent.change(box, { target: { value: 'gamma' } });
    expect(screen.queryByLabelText(/^(Expand|Collapse) room /)).not.toBeInTheDocument();
  });

  it('finds a remark set after the list first drew', () => {
    const all = [current, alpha, beta, gamma];
    const { rerender } = render(
      <SessionSwitcher currentSession={current} sessions={new Map(all.map((s) => [s.sessionId, s]))} onSwitch={vi.fn()} />,
    );
    const box = screen.getByRole('textbox', { name: /search sessions/i });
    const beta2 = { ...beta, remark: 'needs-rebase' };
    rerender(
      <SessionSwitcher currentSession={current} sessions={new Map([current, alpha, beta2, gamma].map((s) => [s.sessionId, s]))} onSwitch={vi.fn()} />,
    );
    fireEvent.change(box, { target: { value: 'needs-rebase' } });
    expect(listed('Beta docs')).toBe(true);
  });

  it('Escape clears the box and brings every card back', () => {
    const { box } = renderStrip();
    fireEvent.change(box, { target: { value: 'website' } });
    fireEvent.keyDown(box, { key: 'Escape' });
    expect(box.value).toBe('');
    expect(listed('Alpha fixes')).toBe(true);
  });

  it('says so when nothing matches, and keeps the box', () => {
    const { box } = renderStrip();
    fireEvent.change(box, { target: { value: 'zzz' } });
    expect(screen.getByText(/No session matches “zzz”/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /search sessions/i })).toBe(box);
  });

  it('the searchSessions shortcut opens a folded rail and focuses the box', () => {
    useUiStore.setState({ navRailCollapsed: true });
    render(
      <SessionSwitcher currentSession={current} sessions={new Map([[current.sessionId, current], [alpha.sessionId, alpha]])} onSwitch={vi.fn()} />,
    );
    expect(screen.queryByRole('textbox', { name: /search sessions/i })).not.toBeInTheDocument();
    act(() => { document.dispatchEvent(new CustomEvent(SESSION_SEARCH_FOCUS_EVENT)); });
    expect(useUiStore.getState().navRailCollapsed).toBe(false);
    expect(document.activeElement).toBe(screen.getByRole('textbox', { name: /search sessions/i }));
  });

  it('leads the strip in the top bar, where the rail row does not exist', () => {
    useUiStore.setState({ navPosition: 'top' });
    renderStrip();
    expect(within(strip()).getByRole('textbox', { name: /search sessions/i })).toBeInTheDocument();
  });
});
