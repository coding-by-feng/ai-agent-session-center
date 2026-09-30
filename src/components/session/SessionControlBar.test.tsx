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

describe('SessionControlBar — remote visibility button', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useRoomStore.setState({ rooms: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('reads "HOST ONLY" (no emoji) when the session is not shared', () => {
    useSessionStore.getState().addSession(makeSession({ remoteVisible: false }));
    render(<Harness sessionId="s1" />);
    // Plain text, matching the row's own convention (KILL/MUTE/ALERT carry
    // no icon) — the previous version prefixed this with "📡 ".
    expect(screen.getByRole('button', { name: 'HOST ONLY' })).toBeInTheDocument();
  });

  it('reads "SHARED" when the session is opted in', () => {
    useSessionStore.getState().addSession(makeSession({ remoteVisible: true }));
    render(<Harness sessionId="s1" />);
    expect(screen.getByRole('button', { name: 'SHARED' })).toBeInTheDocument();
  });

  it('flips the label on click — the exact bug being fixed', () => {
    // Before this fix: the click handler awaited a fetch and only ever
    // showed a toast — the store never changed, so DetailPanel's selector
    // never re-ran, and this assertion would have timed out seeing "HOST
    // ONLY" forever. This is the test that would have caught it.
    useSessionStore.getState().addSession(makeSession({ remoteVisible: false }));
    render(<Harness sessionId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: 'HOST ONLY' }));

    expect(screen.getByRole('button', { name: 'SHARED' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'HOST ONLY' })).not.toBeInTheDocument();
  });

  it('flips back on a second click', () => {
    useSessionStore.getState().addSession(makeSession({ remoteVisible: false }));
    render(<Harness sessionId="s1" />);

    const btn = () => screen.getByRole('button', { name: /HOST ONLY|SHARED/ });
    fireEvent.click(btn());
    expect(screen.getByRole('button', { name: 'SHARED' })).toBeInTheDocument();
    fireEvent.click(btn());
    expect(screen.getByRole('button', { name: 'HOST ONLY' })).toBeInTheDocument();
  });

  it('sets aria-pressed to reflect the current state', () => {
    useSessionStore.getState().addSession(makeSession({ remoteVisible: false }));
    render(<Harness sessionId="s1" />);

    const btn = screen.getByRole('button', { name: 'HOST ONLY' });
    expect(btn).toHaveAttribute('aria-pressed', 'false');
    fireEvent.click(btn);
    expect(screen.getByRole('button', { name: 'SHARED' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('applies the shared-state highlight class only once opted in', () => {
    useSessionStore.getState().addSession(makeSession({ remoteVisible: false }));
    render(<Harness sessionId="s1" />);

    const hostOnlyBtn = screen.getByRole('button', { name: 'HOST ONLY' });
    expect(hostOnlyBtn.className).not.toMatch(/remoteShared/);

    fireEvent.click(hostOnlyBtn);

    expect(screen.getByRole('button', { name: 'SHARED' }).className).toMatch(/remoteShared/);
  });

  it('does not affect the neighboring MUTE/ALERT buttons', () => {
    // Guards against a selector or key collision silently coupling the three
    // toggles — each must move independently.
    useSessionStore.getState().addSession(
      makeSession({ remoteVisible: false, muted: false, alerted: false }),
    );
    render(<Harness sessionId="s1" />);

    fireEvent.click(screen.getByRole('button', { name: 'HOST ONLY' }));

    expect(screen.getByRole('button', { name: 'SHARED' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'MUTE' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'ALERT' })).toBeInTheDocument();
  });
});
