import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, act } from '@testing-library/react';

/** Click a button and flush the async kill loop + trailing state updates inside
 *  act(), so assertions run against fully-settled state with no act() warnings. */
const clickAndSettle = async (label: string | HTMLElement) => {
  const el = typeof label === 'string' ? screen.getByText(label) : label;
  await act(async () => {
    fireEvent.click(el);
    // onClick fires the async handler without awaiting it; a macrotask tick lets
    // the whole kill loop (fetch → Promise.all → trailing setState) settle while
    // still inside act(), so no update escapes it.
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
};

import RoomKillConfirmModal from './RoomKillConfirmModal';
import { useSessionStore } from '@/stores/sessionStore';
import { useRoomStore } from '@/stores/roomStore';
import { useUiStore, ROOM_KILL_MODAL_ID } from '@/stores/uiStore';
import type { Session } from '@/types';

const toast = vi.hoisted(() => vi.fn());
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: toast }));

const mk = (over: Partial<Session>): Session => ({
  sessionId: 'x',
  title: 'X',
  projectName: 'proj',
  projectPath: '/p',
  status: 'idle',
  startedAt: Date.now(),
  lastActivityAt: Date.now(),
  ...over,
} as Session);

/** fetch stub: kill → {ok}, terminal DELETE → {}. `failIds` return ok:false;
 *  `rejectIds` make the kill fetch REJECT (network error → killOne's catch). */
function stubFetch(failIds: Set<string> = new Set(), rejectIds: Set<string> = new Set()) {
  return vi.fn((url: string, opts?: RequestInit) => {
    const killMatch = /\/api\/sessions\/([^/]+)\/kill$/.exec(url);
    if (killMatch && opts?.method === 'POST') {
      const id = killMatch[1];
      if (rejectIds.has(id)) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: true,
        json: async () => (failIds.has(id) ? { ok: false, stillAlivePid: 999 } : { ok: true, killedPid: 111 }),
      } as Response);
    }
    // terminal DELETE
    return Promise.resolve({ ok: true, json: async () => ({}) } as Response);
  });
}

const openModalForRoom = (roomId: string) =>
  useUiStore.setState({ activeModal: ROOM_KILL_MODAL_ID, roomKillTargetId: roomId });

describe('RoomKillConfirmModal', () => {
  const realDeselect = useSessionStore.getState().deselectSession;
  let deselect: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    toast.mockClear();
    deselect = vi.fn();
    useSessionStore.setState({ deselectSession: deselect, selectedSessionId: null } as never);
    useRoomStore.setState({ rooms: [] });
  });

  afterEach(() => {
    useUiStore.setState({ activeModal: null, roomKillTargetId: null });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null, deselectSession: realDeselect } as never);
    useRoomStore.setState({ rooms: [] });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const seed = (opts: { sessions: Session[]; roomSessionIds: string[]; selected?: string }) => {
    useSessionStore.setState({
      sessions: new Map(opts.sessions.map((s) => [s.sessionId, s])),
      selectedSessionId: opts.selected ?? null,
    } as never);
    useRoomStore.setState({
      rooms: [{ id: 'r1', name: 'Android', sessionIds: opts.roomSessionIds, collapsed: false, createdAt: 0, roomIndex: 0 }],
    });
    openModalForRoom('r1');
  };

  it('kills only live sessions and skips ended ones', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    seed({
      sessions: [
        mk({ sessionId: 'a', status: 'idle', terminalId: 't-a' }),
        mk({ sessionId: 'b', status: 'working', terminalId: 't-b' }),
        mk({ sessionId: 'c', status: 'ended' }),
      ],
      roomSessionIds: ['a', 'b', 'c'],
    });
    render(<RoomKillConfirmModal />);

    // Button reflects live count (2), not total (3).
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalled();
    const killedUrls = fetchMock.mock.calls
      .filter(([, o]) => (o as RequestInit)?.method === 'POST')
      .map(([u]) => u as string);
    expect(killedUrls).toEqual(['/api/sessions/a/kill', '/api/sessions/b/kill']);
    // No kill for the ended session c.
    expect(killedUrls.some((u) => u.includes('/c/'))).toBe(false);
  });

  it('closes each killed session\'s terminal', async () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    seed({
      sessions: [mk({ sessionId: 'a', terminalId: 't-a' }), mk({ sessionId: 'b' /* no terminal */ })],
      roomSessionIds: ['a', 'b'],
    });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalled();
    const deletes = fetchMock.mock.calls.filter(([, o]) => (o as RequestInit)?.method === 'DELETE').map(([u]) => u);
    expect(deletes).toEqual(['/api/terminals/t-a']); // only the one with a terminalId
  });

  it('reports a success summary when all die', async () => {
    vi.stubGlobal('fetch', stubFetch());
    seed({ sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' })], roomSessionIds: ['a', 'b'] });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalledWith('Terminated 2 sessions in Android', 'success');
  });

  it('reports a partial-failure summary when some survive', async () => {
    vi.stubGlobal('fetch', stubFetch(new Set(['b'])));
    seed({ sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' })], roomSessionIds: ['a', 'b'] });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalledWith('Terminated 1 of 2 in Android — 1 survived', 'error');
  });

  it('reports a full failure when none die', async () => {
    vi.stubGlobal('fetch', stubFetch(new Set(['a', 'b'])));
    seed({ sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' })], roomSessionIds: ['a', 'b'] });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalledWith('Failed to kill 2 sessions in Android', 'error');
  });

  it('deselects when the open session was among the killed', async () => {
    vi.stubGlobal('fetch', stubFetch());
    seed({ sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' })], roomSessionIds: ['a', 'b'], selected: 'b' });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(deselect).toHaveBeenCalled();
  });

  it('does NOT deselect when the open session survived the kill (ok:false)', async () => {
    // The open session B fails to die; A dies. Deselect must be gated on the
    // actual result, not mere targeting — B stays selected.
    vi.stubGlobal('fetch', stubFetch(new Set(['b'])));
    seed({ sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' })], roomSessionIds: ['a', 'b'], selected: 'b' });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalledWith('Terminated 1 of 2 in Android — 1 survived', 'error');
    expect(deselect).not.toHaveBeenCalled();
  });

  it('treats a network error as a survivor: counts failed and keeps selection', async () => {
    // killOne's catch returns false on a rejected fetch — covers that branch and
    // proves the open session (which errored) is not deselected.
    vi.stubGlobal('fetch', stubFetch(new Set(), new Set(['b'])));
    seed({ sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' })], roomSessionIds: ['a', 'b'], selected: 'b' });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalledWith('Terminated 1 of 2 in Android — 1 survived', 'error');
    expect(deselect).not.toHaveBeenCalled();
  });

  it('does not deselect when the open session is in another room', async () => {
    vi.stubGlobal('fetch', stubFetch());
    seed({
      sessions: [mk({ sessionId: 'a' }), mk({ sessionId: 'b' }), mk({ sessionId: 'z' })],
      roomSessionIds: ['a', 'b'],
      selected: 'z',
    });
    render(<RoomKillConfirmModal />);
    await clickAndSettle('KILL 2');

    expect(toast).toHaveBeenCalled();
    expect(deselect).not.toHaveBeenCalled();
  });

  it('disables the action and kills nothing when the room has no live sessions', () => {
    const fetchMock = stubFetch();
    vi.stubGlobal('fetch', fetchMock);
    seed({ sessions: [mk({ sessionId: 'a', status: 'ended' })], roomSessionIds: ['a'] });
    render(<RoomKillConfirmModal />);

    expect(screen.getByText('This room has no live sessions to kill.')).toBeInTheDocument();
    const btn = screen.getByRole('button', { name: 'KILL' });
    expect(btn).toBeDisabled();
    fireEvent.click(btn);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('lists session names and caps the list at 8 with a +N more row', () => {
    const many = Array.from({ length: 11 }, (_, i) => mk({ sessionId: `s${i}`, title: `Session ${i}` }));
    vi.stubGlobal('fetch', stubFetch());
    seed({ sessions: many, roomSessionIds: many.map((s) => s.sessionId) });
    render(<RoomKillConfirmModal />);

    expect(screen.getByText('Session 0')).toBeInTheDocument();
    expect(screen.getByText('Session 7')).toBeInTheDocument();
    expect(screen.queryByText('Session 8')).not.toBeInTheDocument();
    expect(screen.getByText('+3 more')).toBeInTheDocument();
    expect(screen.getByText('KILL 11')).toBeInTheDocument();
  });

  it('renders nothing when the target room no longer exists', () => {
    useSessionStore.setState({ sessions: new Map() } as never);
    useRoomStore.setState({ rooms: [] });
    openModalForRoom('gone');
    const { container } = render(<RoomKillConfirmModal />);
    expect(container).toBeEmptyDOMElement();
  });

  it('renders nothing when its modal is not the active one', () => {
    seed({ sessions: [mk({ sessionId: 'a' })], roomSessionIds: ['a'] });
    useUiStore.setState({ activeModal: 'some-other-modal' });
    const { container } = render(<RoomKillConfirmModal />);
    expect(container).toBeEmptyDOMElement();
  });
});
