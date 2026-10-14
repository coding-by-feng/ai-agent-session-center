/**
 * Render-check for the 📡 remote-visibility button.
 *
 * The store-level tests (sessionStore.test.ts) already prove
 * `toggleRemoteVisible` flips synchronously. This test exists for a
 * different reason: that action being correct doesn't guarantee the button
 * is WIRED to it correctly, or that the label/class actually reflects
 * `session.remoteVisible` in the rendered DOM — the button previously typechecked
 * and lint-passed while doing nothing visible on click, because the bug was
 * entirely in composition, not in either piece alone. This renders the real
 * component against the real Zustand store and clicks it, the way a user
 * would, rather than asserting on store state directly.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

import SessionControlBar from './SessionControlBar';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import type { Session } from '@/types';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 's1',
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'test-project',
    projectPath: '/tmp/test',
    title: 'Session s1',
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

/**
 * `SessionControlBar` takes `session` as a plain prop — it does not read the
 * store itself. In the real app, `DetailPanel` is what makes a store update
 * visible: it subscribes with `useSessionStore((s) => s.sessions.get(id))`
 * (`DetailPanel.tsx:112`) and passes the fresh object down, so a `set()` in
 * the store re-renders the parent, which re-renders this component with a
 * new prop.
 *
 * Rendering `<SessionControlBar session={staticObject} />` directly — the
 * first version of this test did exactly that — never reflects a store
 * update at all, pass or fail, regardless of whether the fix is correct: RTL
 * has no reason to re-render a component whose props never change. That is
 * not a faithful test of "does clicking this button work"; it can only prove
 * the initial render matches the initial prop. This harness closes that gap
 * by mirroring DetailPanel's exact subscription, so a click here exercises
 * the same path production does.
 */
function Harness({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  if (!session) return null;
  return <SessionControlBar session={session} />;
}

describe('SessionControlBar — the three toggles (AASC-11)', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useRoomStore.setState({ rooms: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // One label each, whatever the state: the state is aria-pressed and the "on"
  // fill. The old labels mixed verbs (MUTE/UNMUTE) with states (HOST ONLY/SHARED,
  // ALERT ON), so a label could not be read as either.
  it('are Mute, Share and Alert, all off for a fresh session', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    for (const name of ['Mute', 'Share', 'Alert']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
  });

  it('show each one on when the session carries it', () => {
    useSessionStore.getState().addSession(makeSession({ muted: true, remoteVisible: true, alerted: true }));
    render(<Harness sessionId="s1" />);
    for (const name of ['Mute', 'Share', 'Alert']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'true');
    }
  });

  it('Share flips on click and back — the store, not just the label (the original remote-visibility bug)', () => {
    useSessionStore.getState().addSession(makeSession({ remoteVisible: false }));
    render(<Harness sessionId="s1" />);
    const share = () => screen.getByRole('button', { name: 'Share' });
    fireEvent.click(share());
    expect(useSessionStore.getState().sessions.get('s1')?.remoteVisible).toBe(true);
    expect(share()).toHaveAttribute('aria-pressed', 'true');
    fireEvent.click(share());
    expect(useSessionStore.getState().sessions.get('s1')?.remoteVisible).toBe(false);
    expect(share()).toHaveAttribute('aria-pressed', 'false');
  });

  it('Share does not touch its neighbours', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.getByRole('button', { name: 'Alert' })).toHaveAttribute('aria-pressed', 'false');
  });

  it('Mute and Alert flip their own flags', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    fireEvent.click(screen.getByRole('button', { name: 'Alert' }));
    const s = useSessionStore.getState().sessions.get('s1');
    expect(s?.muted).toBe(true);
    expect(s?.alerted).toBe(true);
  });

  it('holds no Kill: it is in the title row, away from the toggles', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    expect(screen.queryByRole('button', { name: /kill/i })).toBeNull();
  });

  it('offers Resume only for an ended session', () => {
    useSessionStore.getState().addSession(makeSession({ status: 'idle' }));
    const { unmount } = render(<Harness sessionId="s1" />);
    expect(screen.queryByRole('button', { name: /resume/i })).toBeNull();
    unmount();
    useSessionStore.setState({ sessions: new Map() });
    useSessionStore.getState().addSession(makeSession({ status: 'ended' }));
    render(<Harness sessionId="s1" />);
    expect(screen.getByRole('button', { name: /resume/i })).toBeInTheDocument();
  });
});
