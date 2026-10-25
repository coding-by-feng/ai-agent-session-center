// KillConfirmModal.test.tsx — the one kill confirm, opened two ways: the
// panel's skull (the selected session, KILL_MODAL_ID) and a LIVE board card's
// skull (any session, SESSION_KILL_MODAL_ID + sessionKillTargetId).
// A test must never reach a real process: every kill here goes to a stubbed fetch.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

import KillConfirmModal, { KILL_MODAL_ID } from './KillConfirmModal';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import type { Session } from '@/types';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: toast }));

const mk = (id: string, over: Partial<Session> = {}): Session =>
  ({
    sessionId: id,
    title: id,
    projectName: 'shop',
    projectPath: '/w/shop',
    status: 'idle',
    startedAt: 1,
    lastActivityAt: 1,
    ...over,
  }) as Session;

let fetchStub: ReturnType<typeof vi.fn>;

/** `opened`: the sessions opened in the panel, oldest first; the last is the selected one. */
function setup(list: Session[], selectedSessionId: string | null, opened: string[] = []) {
  useSessionStore.setState({
    sessions: new Map(list.map((x) => [x.sessionId, x])),
    selectedSessionId: null,
    previousSessionId: null,
    lastSelectedSessionId: null,
    recentSelectedIds: [],
  });
  for (const id of opened) useSessionStore.getState().selectSession(id);
  useSessionStore.setState({ selectedSessionId });
  return render(<KillConfirmModal />);
}

const confirmKill = async () => {
  await act(async () => {
    fireEvent.click(screen.getByRole('button', { name: 'KILL' }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

beforeEach(() => {
  toast.mockClear();
  fetchStub = vi.fn(async () => ({ ok: true, json: async () => ({ ok: true, killedPid: 4242 }) }) as Response);
  vi.stubGlobal('fetch', fetchStub);
  useUiStore.setState({ activeModal: null, sessionKillTargetId: null, roomKillTargetId: null, detailPanelMinimized: false });
});
afterEach(() => vi.unstubAllGlobals());

describe('KillConfirmModal — from the panel (the selected session)', () => {
  it('names the selected session by its title and kills it', async () => {
    useUiStore.getState().openModal(KILL_MODAL_ID);
    setup([mk('a', { title: 'Fix the cart' }), mk('b', { title: 'Write docs' })], 'a');
    expect(screen.getByRole('dialog')).toHaveTextContent(/"Fix the cart"/);
    await confirmKill();
    expect(fetchStub.mock.calls[0][0]).toBe('/api/sessions/a/kill');
  });

  it('closes the panel on the session it killed', async () => {
    useUiStore.getState().openModal(KILL_MODAL_ID);
    setup([mk('a')], 'a');
    await confirmKill();
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(useUiStore.getState().activeModal).toBeNull();
  });

  it('draws nothing with no session selected', () => {
    useUiStore.getState().openModal(KILL_MODAL_ID);
    setup([mk('a')], null);
    expect(screen.queryByRole('dialog')).toBeNull();
  });
});

describe('KillConfirmModal — the panel steps back to the session opened before', () => {
  it('opens the previous session instead of closing the panel, and says so', async () => {
    useUiStore.getState().openModal(KILL_MODAL_ID);
    setup([mk('a', { title: 'Fix the cart' }), mk('b', { title: 'Write docs' })], 'a', ['b', 'a']);
    await confirmKill();
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    expect(toast).toHaveBeenCalledWith('Switched to Write docs', 'info', 1500);
  });

  it('steps back again on the next kill', async () => {
    useUiStore.getState().openModal(KILL_MODAL_ID);
    const { unmount } = setup([mk('a'), mk('b'), mk('c')], 'a', ['c', 'b', 'a']);
    await confirmKill();
    unmount();
    expect(useSessionStore.getState().selectedSessionId).toBe('b');
    useSessionStore.getState().updateSession(mk('a', { status: 'ended' }));
    useUiStore.getState().openModal(KILL_MODAL_ID);
    render(<KillConfirmModal />);
    await confirmKill();
    expect(fetchStub.mock.calls.map((c) => c[0])).toEqual(['/api/sessions/a/kill', '/api/sessions/b/kill']);
    expect(useSessionStore.getState().selectedSessionId).toBe('c');
  });

  it('skips a session that has ended and closes when nothing is left', async () => {
    useUiStore.getState().openModal(KILL_MODAL_ID);
    setup([mk('a'), mk('b', { status: 'ended' })], 'a', ['b', 'a']);
    await confirmKill();
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    expect(toast).not.toHaveBeenCalledWith(expect.stringMatching(/^Switched to/), 'info', 1500);
  });

  it('stays on the session when the kill fails', async () => {
    fetchStub.mockImplementation(async () => ({ ok: true, json: async () => ({ ok: false, error: 'nope' }) }) as Response);
    useUiStore.getState().openModal(KILL_MODAL_ID);
    setup([mk('a'), mk('b')], 'a', ['b', 'a']);
    await confirmKill();
    expect(useSessionStore.getState().selectedSessionId).toBe('a');
  });

  it('a kill from a board card does not switch: it closes the minimized panel on that session', async () => {
    useUiStore.setState({ detailPanelMinimized: true });
    useUiStore.getState().openSessionKill('a');
    setup([mk('a'), mk('b')], 'a', ['b', 'a']);
    await confirmKill();
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
    // no "Restore: a" chip left behind for a session that is gone
    expect(useUiStore.getState().detailPanelMinimized).toBe(false);
  });
});

describe('KillConfirmModal — from a LIVE board card (any session)', () => {
  it('kills the card it was opened for, not the selected session', async () => {
    useUiStore.getState().openSessionKill('b');
    setup([mk('a', { title: 'Fix the cart' }), mk('b', { title: 'Write docs' })], 'a');
    expect(screen.getByRole('dialog')).toHaveTextContent(/"Write docs"/);
    await confirmKill();
    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(fetchStub.mock.calls[0][0]).toBe('/api/sessions/b/kill');
    // the panel's own session was not the one killed, so it stays
    expect(useSessionStore.getState().selectedSessionId).toBe('a');
  });

  it('closes the panel when the card killed was its session', async () => {
    useUiStore.getState().openSessionKill('a');
    setup([mk('a')], 'a');
    await confirmKill();
    expect(useSessionStore.getState().selectedSessionId).toBeNull();
  });

  it('says where the session runs when its title does not', () => {
    useUiStore.getState().openSessionKill('a');
    setup([mk('a', { title: 'Fix the cart', projectName: 'shop' })], null);
    expect(screen.getByRole('dialog')).toHaveTextContent(/"Fix the cart" in shop/);
  });

  it('closing it forgets the target, so a stale id cannot reach the next open', () => {
    useUiStore.getState().openSessionKill('a');
    setup([mk('a')], null);
    fireEvent.click(screen.getByRole('button', { name: 'CANCEL' }));
    expect(useUiStore.getState().sessionKillTargetId).toBeNull();
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it('a target that has gone still names it by id rather than drawing an empty name', () => {
    useUiStore.getState().openSessionKill('0123456789abcdef');
    setup([], null);
    expect(screen.getByRole('dialog')).toHaveTextContent(/"01234567"/);
  });
});
