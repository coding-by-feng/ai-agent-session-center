// SessionControlBar.lite.test.tsx — Lite keeps the Mute and Alert toggles (Nov 25 2026): Full shows the alert level
// picker instead. Both set the session's one level through the server mapping, so Alert on clears Mute.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';

vi.mock('@/lib/edition', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/edition')>()),
  IS_LITE: true,
}));

import SessionControlBar from './SessionControlBar';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import type { Session } from '@/types';

const makeSession = (overrides: Partial<Session> = {}): Session =>
  ({ sessionId: 's1', status: 'idle', title: 'Session s1', projectPath: '/tmp/test', events: [], promptHistory: [], ...overrides }) as unknown as Session;

function Harness({ sessionId }: { sessionId: string }) {
  const session = useSessionStore((s) => s.sessions.get(sessionId));
  return session ? <SessionControlBar session={session} /> : null;
}

describe('SessionControlBar in Lite — Mute, Share and Alert', () => {
  beforeEach(() => {
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useRoomStore.setState({ rooms: [] });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true }));
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('are Mute, Share and Alert, all off for a fresh session, and no level picker', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    for (const name of ['Mute', 'Share', 'Alert']) {
      expect(screen.getByRole('button', { name })).toHaveAttribute('aria-pressed', 'false');
    }
    expect(screen.queryByRole('button', { name: /^Alert level:/ })).toBeNull();
  });

  it('show on when the session carries them', () => {
    useSessionStore.getState().addSession(makeSession({ muted: true, remoteVisible: true }));
    render(<Harness sessionId="s1" />);
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Share' })).toHaveAttribute('aria-pressed', 'true');
  });

  it('Mute is Silent; Alert is Loud and clears Mute, as one level', () => {
    useSessionStore.getState().addSession(makeSession());
    render(<Harness sessionId="s1" />);
    fireEvent.click(screen.getByRole('button', { name: 'Mute' }));
    expect(useSessionStore.getState().sessions.get('s1')).toMatchObject({ muted: true, alertLevel: 'silent' });
    fireEvent.click(screen.getByRole('button', { name: 'Alert' }));
    const s = useSessionStore.getState().sessions.get('s1');
    expect(s).toMatchObject({ alerted: true, alertLevel: 'loud' });
    expect(s).not.toHaveProperty('muted');
    expect(screen.getByRole('button', { name: 'Mute' })).toHaveAttribute('aria-pressed', 'false');
  });
});
