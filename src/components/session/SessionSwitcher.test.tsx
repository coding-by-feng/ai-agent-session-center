import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, createEvent } from '@testing-library/react';

import SessionSwitcher from './SessionSwitcher';
import type { Session } from '@/types';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

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
