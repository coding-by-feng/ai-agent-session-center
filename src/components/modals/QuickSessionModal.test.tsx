import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickSessionModal from './QuickSessionModal';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
import type { CentralSummary } from '@/types';

vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => [] }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

// A pty-* terminal is invisible to the server, so restoring the preload must not make Quick Launch create one.
describe('QuickSessionModal — launch transport', () => {
  beforeEach(() => {
    localStorage.clear();
    useRoomStore.setState({ rooms: [] });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useUiStore.setState({ activeModal: 'quick-session' });
  });

  afterEach(() => {
    useUiStore.setState({ activeModal: null });
    delete window.electronAPI;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('creates the session via POST /api/terminals even when electronAPI.createPty exists', async () => {
    const createPty = vi.fn(async () => ({ ok: true, terminalId: 'pty-never' }));
    window.electronAPI = { createPty } as unknown as Window['electronAPI'];
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return Promise.resolve({
          ok: true,
          json: async () => ({ ok: true, terminalId: 'term-quick' }),
        } as Response);
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);

    render(<QuickSessionModal />);
    fireEvent.click(screen.getByRole('button', { name: 'LAUNCH' }));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ method: 'POST' }));
    });
    expect(createPty).not.toHaveBeenCalled();

    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body.forceNew).toBe(true);
    expect(body.command).toBe('claude');
  });
});

// A central session (server/mcp) from Quick Launch: the same Central picker as the full form, reading the
// room and folder of this form, and the same `central` in the launch.
describe('QuickSessionModal — Central session', () => {
  const NO_PASSWORD = 'No dashboard password: a central can also reach /api directly.';
  const ROOM = { id: 'room-1', name: 'Backend', sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 };
  let fetchMock: ReturnType<typeof vi.fn>;

  const picker = () => screen.queryByRole('combobox', { name: 'Central session' }) as HTMLSelectElement | null;
  const choose = (value: string) => fireEvent.change(picker() as HTMLSelectElement, { target: { value } });
  const labels = () => Array.from((picker() as HTMLSelectElement).options).map((o) => o.textContent);
  const terminalBody = () => {
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    return call ? JSON.parse(String(call[1]?.body)) as Record<string, unknown> : null;
  };
  const launch = async () => {
    fireEvent.click(screen.getByRole('button', { name: 'LAUNCH' }));
    await waitFor(() => expect(terminalBody()).not.toBeNull());
    return terminalBody() as Record<string, unknown>;
  };
  const open = () => {
    useUiStore.setState({ activeModal: 'quick-session' });
    render(<QuickSessionModal />);
  };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('workdir-history', JSON.stringify(['/work/app']));
    vi.mocked(showToast).mockClear();
    useRoomStore.setState({ rooms: [ROOM as never] });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useMcpStore.setState({ centrals: new Map(), available: true, passwordEnabled: true, revision: 0 });
    fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, terminalId: 'term-quick' }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    // Inside act: the form is still mounted here, and each of these stores feeds it.
    act(() => {
      useUiStore.getState().closeModal();
      useMcpStore.setState({ centrals: new Map(), available: null, passwordEnabled: null });
      useRoomStore.setState({ rooms: [] });
    });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers the picker, Off by default, and a plain launch sends no `central`', async () => {
    open();

    expect(picker()?.value).toBe('off');
    const body = await launch();
    expect(body).not.toHaveProperty('central');
    expect(body.workingDir).toBe('/work/app');
  });

  it('sends { kind: "global" } for Global', async () => {
    open();
    choose('global');

    expect((await launch()).central).toEqual({ kind: 'global' });
  });

  it('offers This project for the working folder, and sends that folder', async () => {
    open();
    expect(labels()).toEqual(['Off', 'Global', 'This project']);
    choose('project');

    expect((await launch()).central).toEqual({ kind: 'project', scopeRef: '/work/app' });
  });

  it('offers This room once a room is picked in the Room field, and sends that room', async () => {
    open();
    expect(labels()).toEqual(['Off', 'Global', 'This project']);

    fireEvent.change(screen.getByPlaceholderText('None (corridor)'), { target: { value: 'Backend' } });
    expect(labels()).toEqual(['Off', 'Global', 'This room', 'This project']);
    choose('room');

    expect((await launch()).central).toEqual({ kind: 'room', scopeRef: 'room-1' });
  });

  it('sends no `central` for a scope a central took while the form was open', async () => {
    open();
    choose('global');
    const row: CentralSummary = { centralId: 'c1', kind: 'global', scopeRef: null, cli: 'claude', sessionId: null, toolsets: [], createdAt: 1, workerCount: 0 };
    act(() => useMcpStore.setState({ centrals: new Map([['c1', row]]) }));

    expect(picker()?.value).toBe('off');
    expect(await launch()).not.toHaveProperty('central');
  });

  it('is Off again at the next opening: a central is made on purpose, never carried over', async () => {
    open();
    choose('global');
    act(() => useUiStore.getState().closeModal());
    act(() => useUiStore.setState({ activeModal: 'quick-session' }));

    expect(picker()?.value).toBe('off');
    expect(await launch()).not.toHaveProperty('central');
  });

  it('does not seed a title for a central: the first prompt still names the card', async () => {
    open();
    choose('global');

    expect(await launch()).not.toHaveProperty('sessionTitle');
  });

  it.each([[false], [null]])('shows no picker, and sends none, while available is %s', async (available) => {
    useMcpStore.setState({ available });
    open();

    expect(picker()).toBeNull();
    expect(await launch()).not.toHaveProperty('central');
  });

  it('warns about a missing dashboard password only without one', () => {
    useMcpStore.setState({ passwordEnabled: false });
    open();
    expect(screen.getByText(NO_PASSWORD)).toBeInTheDocument();
    act(() => useMcpStore.setState({ passwordEnabled: true }));
    expect(screen.queryByText(NO_PASSWORD)).toBeNull();
  });

  it('shows the server\'s refusal as it comes, and keeps the form open', async () => {
    const refusal = 'A global central is already running (#card-1)';
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return { ok: false, status: 409, json: async () => ({ ok: false, error: refusal }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    open();
    choose('global');

    fireEvent.click(screen.getByRole('button', { name: 'LAUNCH' }));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(refusal, 'error'));
    expect(useUiStore.getState().activeModal).toBe('quick-session');
  });
});
