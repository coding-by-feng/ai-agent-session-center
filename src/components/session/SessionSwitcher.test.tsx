import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';

import SessionSwitcher from './SessionSwitcher';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { useQueueStore } from '@/stores/queueStore';

/**
 * Progress remark — the note icon in the title row is the entry point for the
 * empty state, and the row below the title only exists once there is something
 * to show. See SessionSwitcher.tsx "Progress remark" block.
 */
describe('SessionSwitcher — progress remark', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: 's1',
    title: 'AASC Promotion',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: 'approval',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  const renderSwitcher = (session: Session) =>
    render(
      <SessionSwitcher
        currentSession={session}
        sessions={new Map([[session.sessionId, session]])}
        onSwitch={vi.fn()}
      />,
    );

  // The real store action, captured before any test swaps it out.
  const realSetSessionRemark = useSessionStore.getState().setSessionRemark;
  let setSessionRemark: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    // Swap a fresh mock in per test rather than vi.spyOn(getState(), ...):
    // Zustand's set() copies the action onto a NEW state object, so a spy
    // survives restoreAllMocks() on the old one and leaks calls between tests.
    setSessionRemark = vi.fn();
    useSessionStore.setState({ setSessionRemark } as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useSessionStore.setState({ sessions: new Map(), setSessionRemark: realSetSessionRemark } as never);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers the note icon as the entry point when the session has no remark', () => {
    renderSwitcher(makeSession());
    expect(screen.getByLabelText('Add a session remark')).toBeInTheDocument();
  });

  it('renders no remark row until there is a remark (bar stays one line)', () => {
    renderSwitcher(makeSession({ remark: undefined }));
    // The old "+ add remark" placeholder is gone — nothing but the icon.
    expect(screen.queryByText('+ add remark')).not.toBeInTheDocument();
    expect(screen.queryByLabelText(/^Remark:/)).not.toBeInTheDocument();
  });

  it('opens a focused editor when the note icon is clicked', () => {
    renderSwitcher(makeSession());
    fireEvent.click(screen.getByLabelText('Add a session remark'));

    const input = screen.getByLabelText('Session remark') as HTMLInputElement;
    expect(input).toBeInTheDocument();
    expect(document.activeElement).toBe(input);
  });

  it('saves the remark on Enter', () => {
    renderSwitcher(makeSession());

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'waiting on design review' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(setSessionRemark).toHaveBeenCalledWith('s1', 'waiting on design review');
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('saves the remark on blur (click-away)', () => {
    renderSwitcher(makeSession());

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'blurred note' } });
    fireEvent.blur(input);

    expect(setSessionRemark).toHaveBeenCalledWith('s1', 'blurred note');
  });

  it('discards the draft on Escape', () => {
    renderSwitcher(makeSession());

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'never mind' } });
    fireEvent.keyDown(input, { key: 'Escape' });

    expect(setSessionRemark).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('renders an existing remark as a clickable row below the title', () => {
    renderSwitcher(makeSession({ remark: 'blocked on review' }));
    expect(screen.getByText('blocked on review')).toBeInTheDocument();
  });

  it('seeds the editor with the existing remark when the row is clicked', () => {
    renderSwitcher(makeSession({ remark: 'blocked on review' }));
    fireEvent.click(screen.getByText('blocked on review'));

    expect((screen.getByLabelText('Session remark') as HTMLInputElement).value)
      .toBe('blocked on review');
  });

  it('clears the remark when the editor is emptied and committed', () => {
    renderSwitcher(makeSession({ remark: 'blocked on review' }));

    fireEvent.click(screen.getByText('blocked on review'));
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    // Clearing is a legitimate edit — it must reach the store, not be swallowed
    // by a truthiness guard.
    expect(setSessionRemark).toHaveBeenCalledWith('s1', '');
  });

  it('closing via the note icon saves rather than discarding', () => {
    renderSwitcher(makeSession());

    const icon = screen.getByLabelText('Add a session remark');
    fireEvent.click(icon);
    const input = screen.getByLabelText('Session remark');
    fireEvent.change(input, { target: { value: 'typed then clicked the icon' } });

    fireEvent.click(icon);

    // Proves the commit branch of toggleRemarkEdit (remarkEditing === true).
    expect(setSessionRemark).toHaveBeenCalledWith('s1', 'typed then clicked the icon');
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('suppresses the note icon mousedown so the open editor never blurs first', () => {
    // The guard the test above RELIES ON but cannot observe: jsdom does not
    // shift focus on mousedown, so a blur→click sequence would pass even with
    // the guard deleted. Assert the preventDefault directly instead.
    renderSwitcher(makeSession());
    const icon = screen.getByLabelText('Add a session remark');
    fireEvent.click(icon); // open the editor

    const md = createEvent.mouseDown(icon);
    fireEvent(icon, md);
    expect(md.defaultPrevented).toBe(true);
  });

  it('does not hijack into the rename editor on a double-click of the note icon', () => {
    // The note button sits inside .switcherName, which renames on double-click.
    // Its onDoubleClick stopPropagation must keep a double-click from opening
    // the title editor (which would mount with the title pre-selected, so the
    // next keystroke would overwrite it).
    renderSwitcher(makeSession());
    const icon = screen.getByLabelText('Add a session remark');

    fireEvent.click(icon);
    fireEvent.click(icon);
    fireEvent.doubleClick(icon);

    expect(screen.queryByLabelText('Session title')).not.toBeInTheDocument();
  });

  it('caps the remark at 200 chars to match the server schema', () => {
    renderSwitcher(makeSession());
    fireEvent.click(screen.getByLabelText('Add a session remark'));

    expect(screen.getByLabelText('Session remark')).toHaveAttribute('maxlength', '200');
  });

  it('abandons an open editor when the session changes', () => {
    const a = makeSession({ sessionId: 'a', title: 'A' });
    const b = makeSession({ sessionId: 'b', title: 'B' });
    const { rerender } = render(
      <SessionSwitcher currentSession={a} sessions={new Map([['a', a]])} onSwitch={vi.fn()} />,
    );

    fireEvent.click(screen.getByLabelText('Add a session remark'));
    fireEvent.change(screen.getByLabelText('Session remark'), { target: { value: 'draft for A' } });

    rerender(
      <SessionSwitcher currentSession={b} sessions={new Map([['b', b]])} onSwitch={vi.fn()} />,
    );

    // A's draft must not be sitting in an editor pointed at B.
    expect(screen.queryByLabelText('Session remark')).not.toBeInTheDocument();
  });

  it('shows the note icon in the docked-left rail too', () => {
    useUiStore.setState({ navPosition: 'left', maximized: false, navRailCollapsed: false });
    renderSwitcher(makeSession());

    expect(screen.getByLabelText('Add a session remark')).toBeInTheDocument();
  });
});

/**
 * Queue-hint badge — the session tab card shows a cyan list-glyph + count when
 * that session has queued prompts (source: client queueStore). See the
 * `.sessionTabQueueBadge` block in SessionSwitcher.tsx.
 */
describe('SessionSwitcher — queue hint badge', () => {
  const makeSession = (over: Partial<Session> = {}): Session => ({
    sessionId: 's1',
    title: 'AASC Promotion',
    projectName: 'agent-manager',
    projectPath: '/Users/me/agent-manager',
    status: 'approval',
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    ...over,
  } as Session);

  // The tab strip shows the *other* sessions (the current one lives in the detail
  // view), so the badge is exercised on a non-current session's card.
  const renderWithCard = (carded: Session) => {
    const current = makeSession({ sessionId: 'cur', title: 'Current' });
    return render(
      <SessionSwitcher
        currentSession={current}
        sessions={new Map([[current.sessionId, current], [carded.sessionId, carded]])}
        onSwitch={vi.fn()}
      />,
    );
  };

  const queue = (sessionId: string, n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: i + 1,
      sessionId,
      text: `prompt ${i + 1}`,
      position: i,
      createdAt: i + 1,
      type: 'once' as const,
    }));

  beforeEach(() => {
    useUiStore.setState({ navPosition: 'top', maximized: false });
    useQueueStore.setState({ queues: new Map() } as never);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
    try { localStorage.clear(); } catch { /* ignore */ }
  });

  afterEach(() => {
    useSessionStore.setState({ sessions: new Map() } as never);
    useQueueStore.setState({ queues: new Map() } as never);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows the badge with the count when the session has queued prompts', () => {
    useQueueStore.getState().setQueue('s2', queue('s2', 2) as never);
    renderWithCard(makeSession({ sessionId: 's2', title: 'Queued Agent' }));
    expect(screen.getByLabelText('2 queued prompts')).toBeInTheDocument();
  });

  it('singularizes the label for a single queued prompt', () => {
    useQueueStore.getState().setQueue('s2', queue('s2', 1) as never);
    renderWithCard(makeSession({ sessionId: 's2', title: 'Queued Agent' }));
    expect(screen.getByLabelText('1 queued prompt')).toBeInTheDocument();
  });

  it('shows no badge when the queue is empty (no "0")', () => {
    renderWithCard(makeSession({ sessionId: 's2', title: 'Idle Agent' }));
    expect(screen.queryByLabelText(/queued prompt/)).not.toBeInTheDocument();
  });
});
