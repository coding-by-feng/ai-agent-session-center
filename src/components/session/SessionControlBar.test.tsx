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
import { useAlertConfigStore } from '@/stores/alertConfigStore';
import { DEFAULT_ALERT_CONFIG } from '@/lib/attention';
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

describe('SessionControlBar — the alert level and Share (AASC-11; levels Nov 25 2026)', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useRoomStore.setState({ rooms: [] });
    useAlertConfigStore.setState({ config: DEFAULT_ALERT_CONFIG });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const levelTrigger = () => screen.getByRole('button', { name: /^Alert level:/ });

  // Full: one picker in place of Mute and Alert (Lite keeps those: SessionControlBar.lite.test.tsx).
  it('shows the alert level and Share; a fresh session follows the default level', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    expect(levelTrigger()).toHaveAccessibleName('Alert level: Normal, from its default');
    expect(screen.getByRole('button', { name: 'Share' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByRole('button', { name: 'Mute' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Alert' })).toBeNull();
  });

  it('names the session\'s own level, and an old Alert as Loud', () => {
    useSessionStore.getState().addSession(makeSession({ alertLevel: 'urgent' }));
    useSessionStore.getState().addSession(makeSession({ sessionId: 's2', alerted: true }));
    const { unmount } = render(<Harness sessionId="s1" />);
    expect(levelTrigger()).toHaveAccessibleName('Alert level: Urgent');
    unmount();
    render(<Harness sessionId="s2" />);
    expect(levelTrigger()).toHaveAccessibleName('Alert level: Loud');
  });

  it('choosing a level writes it, and Follow clears it', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    fireEvent.click(levelTrigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Quiet' }));
    expect(useSessionStore.getState().sessions.get('s1')?.alertLevel).toBe('quiet');
    const fetchMock = vi.mocked(fetch);
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/s1/alert-level', expect.objectContaining({ method: 'PUT', body: JSON.stringify({ level: 'quiet' }) }));

    fireEvent.click(levelTrigger());
    fireEvent.click(screen.getByRole('menuitemradio', { name: 'Follow default (Normal)' }));
    expect(useSessionStore.getState().sessions.get('s1')).not.toHaveProperty('alertLevel');
    expect(fetchMock).toHaveBeenLastCalledWith('/api/sessions/s1/alert-level', expect.objectContaining({ body: JSON.stringify({ level: null }) }));
  });

  it('a room level is what the session follows', () => {
    useRoomStore.setState({ rooms: [{ id: 'r1', name: 'Ops', sessionIds: ['s1'], alertLevel: 'loud' } as never] });
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    expect(levelTrigger()).toHaveAccessibleName('Alert level: Loud, from its room');
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

  it('Share does not touch the alert level', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(levelTrigger()).toHaveAccessibleName('Alert level: Normal, from its default');
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

describe('SessionControlBar — how the last turn was stopped', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useRoomStore.setState({ rooms: [] });
  });

  it('names a usage limit with its reset, as a limit rather than a transient failure', () => {
    useSessionStore.getState().addSession(makeSession({
      interruption: { kind: 'usage_limit', line: "You've hit your 5-hour limit · resets 1:30pm (Pacific/Auckland)", detectedAt: 1 },
    }));
    render(<Harness sessionId="s1" />);
    const badge = screen.getByText(/usage limit/);
    expect(badge.textContent).toBe(' usage limit · resets 1:30pm');
    expect(badge.querySelector('svg')).not.toBeNull(); // the rail's hourglass, not a character a font may lack
    expect(badge.getAttribute('title')).toContain('until the plan');
  });

  it('keeps the warning sign for a transient failure', () => {
    useSessionStore.getState().addSession(makeSession({
      interruption: { kind: 'api_error', line: 'API Error: 529 Overloaded', detectedAt: 1 },
    }));
    render(<Harness sessionId="s1" />);
    expect(screen.getByText(/API error/).textContent).toBe('⚠ API error');
  });
});
