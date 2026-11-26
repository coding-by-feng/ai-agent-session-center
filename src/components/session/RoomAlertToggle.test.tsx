// RoomAlertToggle.test.tsx — Lite's room Alert (Full has RoomAlertLevelPicker): one click sets Alert on every live
// session in the room, writing only the ones that change; with levels (Nov 25 2026) Alert on is Loud, off follows.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import RoomAlertToggle from './RoomAlertToggle';
import { useSessionStore } from '@/stores/sessionStore';
import type { Session } from '@/types';

const mk = (sessionId: string, over: Partial<Session> = {}) =>
  ({ sessionId, status: 'waiting', title: sessionId, events: [], ...over }) as unknown as Session;

function renderAlpha(over: { aAlerted?: boolean; bAlerted?: boolean } = {}) {
  const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) });
  vi.stubGlobal('fetch', fetchMock);
  const list = [
    mk('a', { alerted: over.aAlerted ?? true }),
    mk('b', { status: 'working', alerted: over.bAlerted ?? false }),
    mk('c', { status: 'ended' }),
  ];
  const sessions = new Map(list.map((s) => [s.sessionId, s]));
  useSessionStore.setState({ sessions } as never);
  render(<RoomAlertToggle roomName="Alpha" sessionIds={['a', 'b', 'c']} sessions={sessions} />);
  const puts = () => fetchMock.mock.calls
    .filter(([, init]) => (init as RequestInit | undefined)?.method === 'PUT')
    .map(([url, init]) => [url, JSON.parse(String((init as RequestInit).body))]);
  return { puts };
}

const bell = () => screen.getByRole('button', { name: /^(Alert all|Stop alerts for all) \d+ sessions? in Alpha$/ });

describe('RoomAlertToggle (Lite)', () => {
  beforeEach(() => useSessionStore.setState({ sessions: new Map() } as never));
  afterEach(() => vi.unstubAllGlobals());

  it('shows mixed when some live sessions are alerted, and counts only live ones', () => {
    renderAlpha();
    expect(bell()).toHaveAccessibleName('Alert all 2 sessions in Alpha');
    expect(bell()).toHaveAttribute('aria-pressed', 'mixed');
  });

  it('one click alerts every live session in the room, writing only the ones that change', () => {
    const { puts } = renderAlpha();
    fireEvent.click(bell());
    const store = useSessionStore.getState().sessions;
    expect(store.get('b')).toMatchObject({ alerted: true, alertLevel: 'loud' });
    expect(store.get('c')?.alerted).toBeUndefined();
    expect(puts()).toEqual([['/api/sessions/b/alerted', { alerted: true }]]);
  });

  it('when every live session is alerted, a click turns Alert off for all of them', () => {
    const { puts } = renderAlpha({ bAlerted: true });
    expect(bell()).toHaveAttribute('aria-pressed', 'true');
    expect(bell()).toHaveAccessibleName('Stop alerts for all 2 sessions in Alpha');
    fireEvent.click(bell());
    expect(puts()).toEqual([
      ['/api/sessions/a/alerted', { alerted: false }],
      ['/api/sessions/b/alerted', { alerted: false }],
    ]);
    // Off is absence, as the server writes it: the session follows its room again.
    expect(useSessionStore.getState().sessions.get('a')).not.toHaveProperty('alerted');
  });
});
