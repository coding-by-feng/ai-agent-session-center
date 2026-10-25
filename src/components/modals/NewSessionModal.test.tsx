import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NewSessionModal from './NewSessionModal';
import { useMcpStore } from '@/stores/mcpStore';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';
import { showToast } from '@/components/ui/ToastContainer';
import type { CentralSummary } from '@/types';

const knownProjects = vi.hoisted(() => ({ paths: [] as string[] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => knownProjects.paths }));
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const catalog = {
  models: [
    {
      id: 'gpt-newest',
      displayName: 'GPT Newest',
      description: 'Current default.',
      isDefault: true,
    },
    {
      id: 'gpt-fast',
      displayName: 'GPT Fast',
      description: 'Fast model.',
      isDefault: false,
    },
  ],
  refreshedAt: '2026-07-20T00:00:00.000Z',
  source: 'codex-app-server',
  stale: false,
};

function openCodexModal() {
  localStorage.setItem('lastSession', JSON.stringify({
    workingDir: '/tmp/project',
    command: 'codex --dangerously-bypass-approvals-and-sandbox',
  }));
  useUiStore.setState({ activeModal: 'new-session' });
}

describe('NewSessionModal Codex model picker', () => {
  beforeEach(() => {
    localStorage.clear();
    useRoomStore.setState({ rooms: [] });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
  });

  afterEach(() => {
    useUiStore.setState({ activeModal: null });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('loads official models and submits the selected Codex model without Claude effort', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/codex/models') {
        return Promise.resolve({ ok: true, json: async () => catalog } as Response);
      }
      if (url === '/api/terminals' && options?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, terminalId: 'term-codex' }) } as Response);
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    openCodexModal();

    render(<NewSessionModal />);

    expect(screen.getByText(/override OPENAI_API_KEY/)).toBeInTheDocument();
    await screen.findByTitle('Codex model');
    fireEvent.click(screen.getByTitle('Codex model'));
    fireEvent.mouseDown(screen.getByText('GPT Fast'));
    expect(screen.getByText(/Fast model.*gpt-fast/)).toBeInTheDocument();

    fireEvent.click(screen.getByText('CREATE'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ method: 'POST' }));
    });
    const terminalCall = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    const body = JSON.parse(String(terminalCall?.[1]?.body)) as Record<string, unknown>;
    expect(body.model).toBe('gpt-fast');
    expect(body).not.toHaveProperty('effortLevel');
  });

  it('falls back to the Codex default without blocking session creation', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/codex/models') {
        return Promise.resolve({ ok: false, status: 503, json: async () => ({}) } as Response);
      }
      if (url === '/api/terminals' && options?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, terminalId: 'term-default' }) } as Response);
      }
      return Promise.reject(new Error(`Unexpected request: ${url}`));
    });
    vi.stubGlobal('fetch', fetchMock);
    openCodexModal();

    render(<NewSessionModal />);

    await screen.findByText('Catalog unavailable — Codex default will be used.');
    fireEvent.click(screen.getByText('CREATE'));

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ method: 'POST' }));
    });
    const terminalCall = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    const body = JSON.parse(String(terminalCall?.[1]?.body)) as Record<string, unknown>;
    expect(body).not.toHaveProperty('model');
    expect(body).not.toHaveProperty('effortLevel');
  });
});

// AASC-18: in the phone app the form asks only for what a paired phone may send
// (server/mobile/phoneProfile.ts): a project folder, Claude or Codex, a title,
// a room, model and effort.
describe('NewSessionModal in the phone app', () => {
  beforeEach(() => {
    localStorage.clear();
    useRoomStore.setState({ rooms: [] });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)' });
  });

  afterEach(() => {
    useUiStore.setState({ activeModal: null });
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('offers Claude or Codex instead of a command, and none of the fields a phone may not set', () => {
    useUiStore.setState({ activeModal: 'new-session' });
    render(<NewSessionModal />);
    expect(screen.getByRole('button', { name: 'Claude' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Codex' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText(/API Key/i)).toBeNull();
    expect(screen.queryByText(/Commands Terminal/i)).toBeNull();
    expect(screen.queryByText(/Enable Remote Control/i)).toBeNull();
    expect(screen.queryByPlaceholderText('e.g. claude')).toBeNull();
  });

  it('starts with no folder (never the home folder) and sends only the allowed fields', async () => {
    const fetchMock = vi.fn((url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return Promise.resolve({ ok: true, json: async () => ({ ok: true, terminalId: 'term-phone' }) } as Response);
      }
      return Promise.resolve({ ok: true, json: async () => ({ models: [], stale: false }) } as Response);
    });
    vi.stubGlobal('fetch', fetchMock);
    localStorage.setItem('lastSession', JSON.stringify({ workingDir: '~', command: 'claude --resume x' }));
    useUiStore.setState({ activeModal: 'new-session' });
    render(<NewSessionModal />);

    expect(screen.getByText('CREATE').closest('button')).toBeDisabled();
    fireEvent.change(screen.getByPlaceholderText('Choose a project folder'), { target: { value: '/w/app' } });
    fireEvent.click(screen.getByRole('button', { name: 'Codex' }));
    fireEvent.click(screen.getByText('CREATE'));
    // /w/app is a folder no agent has worked in (AASC-54): the phone asks first.
    const confirm = await screen.findByRole('dialog', { name: 'Start in a new folder?' });
    expect(fetchMock).not.toHaveBeenCalledWith('/api/terminals', expect.anything());
    fireEvent.click(within(confirm).getByRole('button', { name: 'Start here' }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body.workingDir).toBe('/w/app');
    expect(body.command).toBe('codex');
    expect(body.requireExistingDir).toBe(true);
    const allowed = new Set(['workingDir', 'command', 'forceNew', 'requireExistingDir', 'sessionTitle', 'label', 'model', 'effortLevel']);
    expect(Object.keys(body).filter((k) => !allowed.has(k))).toEqual([]);
  });
});

// AASC-54: any folder under the Mac's home folder, found by browsing; a new one is confirmed first.
describe('NewSessionModal in the phone app: folders', () => {
  const HOME = '/Users/me';
  let fetchMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    localStorage.clear();
    knownProjects.paths = [];
    useRoomStore.setState({ rooms: [] });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)' });
    fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, terminalId: 'term-phone' }) } as Response;
      }
      if (url === '/api/rooms/ops') return { ok: true, json: async () => ({ success: true }) } as Response;
      if (url.startsWith('/api/folders')) {
        const path = new URL(url, 'http://mac').searchParams.get('path') || HOME;
        const folders = path === HOME ? [{ name: 'idea', path: `${HOME}/idea` }] : [];
        const data = { path, home: HOME, parent: path === HOME ? null : HOME, folders, truncated: false };
        return { ok: true, status: 200, json: async () => ({ success: true, data }) } as Response;
      }
      return { ok: true, json: async () => ({ models: [], stale: false }) } as Response;
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    act(() => useUiStore.getState().closeModal());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const terminalBody = () => {
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    return call ? JSON.parse(String(call[1]?.body)) as Record<string, unknown> : null;
  };

  it('browses the Mac’s folders, uses the chosen one, and confirms it is new before starting', async () => {
    useUiStore.setState({ activeModal: 'new-session' });
    render(<NewSessionModal />);
    fireEvent.click(screen.getByRole('button', { name: 'Browse…' }));
    const browser = await screen.findByRole('dialog', { name: 'Choose a folder' });
    fireEvent.click(await within(browser).findByRole('button', { name: 'Open idea' }));
    fireEvent.click(await within(browser).findByRole('button', { name: 'Use “idea”' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Choose a folder' })).toBeNull());
    expect(screen.getByPlaceholderText('Choose a project folder')).toHaveValue(`${HOME}/idea`);

    fireEvent.click(screen.getByText('CREATE'));
    const confirm = await screen.findByRole('dialog', { name: 'Start in a new folder?' });
    expect(confirm.textContent).toContain('Claude will start there');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(terminalBody()).toBeNull();
    fireEvent.click(screen.getByText('CREATE'));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Start in a new folder?' })).getByRole('button', { name: 'Start here' }));
    await waitFor(() => expect(terminalBody()).toMatchObject({ workingDir: `${HOME}/idea`, command: 'claude', requireExistingDir: true }));
  });

  it('starts a known folder (a typed `~/…` one too, once the home folder is known) without the confirm', async () => {
    knownProjects.paths = [`${HOME}/known`];
    useUiStore.setState({ activeModal: 'new-session' });
    render(<NewSessionModal />);
    fireEvent.change(screen.getByPlaceholderText('Choose a project folder'), { target: { value: `${HOME}/known/` } });
    fireEvent.click(screen.getByText('CREATE'));
    await waitFor(() => expect(terminalBody()).toMatchObject({ workingDir: `${HOME}/known/` }));
    expect(screen.queryByRole('dialog', { name: 'Start in a new folder?' })).toBeNull();
  });

  it('opens with the folder the ＋ sheet chose', () => {
    act(() => useUiStore.getState().openNewSession(`${HOME}/idea`));
    render(<NewSessionModal />);
    expect(screen.getByPlaceholderText('Choose a project folder')).toHaveValue(`${HOME}/idea`);
  });

  it('asks the Mac to put the new session in the room (a phone doesn’t own the room list)', async () => {
    knownProjects.paths = [`${HOME}/known`];
    useRoomStore.setState({ rooms: [{ id: 'r1', name: 'Mobile', sessionIds: [], roomIndex: 0 } as never] });
    const addSession = vi.spyOn(useRoomStore.getState(), 'addSession');
    useUiStore.setState({ activeModal: 'new-session' });
    render(<NewSessionModal />);
    fireEvent.change(screen.getByPlaceholderText('Choose a project folder'), { target: { value: `${HOME}/known` } });
    fireEvent.change(screen.getByPlaceholderText('None (corridor)'), { target: { value: 'Mobile' } });
    fireEvent.click(screen.getByText('CREATE'));
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/rooms/ops', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/rooms/ops');
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({ type: 'move', sessionId: 'term-phone', roomId: 'r1' });
    expect(addSession).not.toHaveBeenCalled();
  });
});

// A central session (server/mcp): the Central picker, the room and folder it takes from the form, and the
// `central` the launch carries. Only this Mac may start one, so the picker shows only while mcpStore says
// this window may (it reads GET /api/mcp/centrals at connect), and never in the phone app.
describe('NewSessionModal — Central session', () => {
  const NO_PASSWORD = 'No dashboard password: a central can also reach /api directly.';
  const ROOM = { id: 'room-1', name: 'Backend', sessionIds: [], collapsed: false, createdAt: 1, roomIndex: 0 };
  let fetchMock: ReturnType<typeof vi.fn>;

  const running = (...rows: CentralSummary[]) => act(() => {
    useMcpStore.setState({ centrals: new Map(rows.map((r) => [r.centralId, r])) });
  });
  const picker = () => screen.queryByRole('combobox', { name: 'Central session' }) as HTMLSelectElement | null;
  const choose = (value: string) => fireEvent.change(picker() as HTMLSelectElement, { target: { value } });
  const labels = () => Array.from((picker() as HTMLSelectElement).options).map((o) => o.textContent);
  const terminalBody = () => {
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    return call ? JSON.parse(String(call[1]?.body)) as Record<string, unknown> : null;
  };
  const create = async () => {
    fireEvent.click(screen.getByText('CREATE'));
    await waitFor(() => expect(terminalBody()).not.toBeNull());
    return terminalBody() as Record<string, unknown>;
  };
  const open = () => {
    useUiStore.setState({ activeModal: 'new-session' });
    render(<NewSessionModal />);
  };

  beforeEach(() => {
    localStorage.clear();
    localStorage.setItem('lastSession', JSON.stringify({ workingDir: '/work/app', command: 'claude' }));
    knownProjects.paths = [];
    vi.mocked(showToast).mockClear();
    useRoomStore.setState({ rooms: [ROOM as never] });
    useSessionStore.setState({ sessions: new Map(), selectedSessionId: null });
    useMcpStore.setState({ centrals: new Map(), available: true, passwordEnabled: true, revision: 0 });
    fetchMock = vi.fn(async (url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return { ok: true, json: async () => ({ ok: true, terminalId: 'term-central' }) } as Response;
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

  it('offers the picker after the Room field, Off by default, and a plain launch sends no `central`', async () => {
    open();

    expect(picker()).not.toBeNull();
    expect(picker()?.value).toBe('off');
    const room = screen.getByPlaceholderText('None (corridor)');
    expect(room.compareDocumentPosition(picker() as HTMLElement) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    const body = await create();
    expect(body).not.toHaveProperty('central');
    expect(body.workingDir).toBe('/work/app');
  });

  it('sends { kind: "global" } for Global', async () => {
    open();
    choose('global');

    expect((await create()).central).toEqual({ kind: 'global' });
  });

  it('offers This project for the working folder, and sends that folder', async () => {
    open();
    expect(labels()).toEqual(['Off', 'Global', 'This project']);
    choose('project');

    expect((await create()).central).toEqual({ kind: 'project', scopeRef: '/work/app' });
  });

  it('follows the working folder: the project is the folder the session starts in', async () => {
    open();
    choose('project');
    fireEvent.change(screen.getByPlaceholderText('~'), { target: { value: '/work/other' } });

    expect((await create()).central).toEqual({ kind: 'project', scopeRef: '/work/other' });
  });

  it('offers This room only once a room is picked in the Room field, and sends that room', async () => {
    open();
    expect(labels()).toEqual(['Off', 'Global', 'This project']);

    fireEvent.change(screen.getByPlaceholderText('None (corridor)'), { target: { value: 'Backend' } });
    expect(labels()).toEqual(['Off', 'Global', 'This room', 'This project']);
    choose('room');

    const body = await create();
    expect(body.central).toEqual({ kind: 'room', scopeRef: 'room-1' });
  });

  it('sends no `central` once the room it was for is cleared', async () => {
    open();
    fireEvent.change(screen.getByPlaceholderText('None (corridor)'), { target: { value: 'Backend' } });
    choose('room');
    expect(picker()?.value).toBe('room');

    fireEvent.change(screen.getByPlaceholderText('None (corridor)'), { target: { value: '' } });

    expect(picker()?.value).toBe('off');
    expect(await create()).not.toHaveProperty('central');
  });

  it('sends no `central` for a scope a central took while the form was open', async () => {
    open();
    choose('global');
    running({ centralId: 'c1', kind: 'global', scopeRef: null, cli: 'claude', sessionId: null, toolsets: [], createdAt: 1, workerCount: 0 });

    expect(Array.from((picker() as HTMLSelectElement).options).find((o) => o.value === 'global')?.disabled).toBe(true);
    expect(picker()?.value).toBe('off');
    expect(await create()).not.toHaveProperty('central');
  });

  it('is Off again at the next opening: a central is made on purpose, never carried over', async () => {
    open();
    choose('global');
    expect(picker()?.value).toBe('global');

    act(() => useUiStore.getState().closeModal());
    act(() => useUiStore.setState({ activeModal: 'new-session' }));

    expect(picker()?.value).toBe('off');
    expect(await create()).not.toHaveProperty('central');
  });

  it('keeps the rest of the launch as it was', async () => {
    open();
    choose('global');

    const body = await create();
    expect(body).toMatchObject({ workingDir: '/work/app', command: 'claude', forceNew: true, central: { kind: 'global' } });
  });

  it('does not seed a title for a central: the first prompt still names the card', async () => {
    open();
    choose('global');

    const body = await create();
    expect(body).not.toHaveProperty('sessionTitle');
  });

  describe('when this window may not start a central', () => {
    it.each([[false], [null]])('shows no picker, and sends none, while available is %s', async (available) => {
      useMcpStore.setState({ available });
      open();

      expect(picker()).toBeNull();
      expect(await create()).not.toHaveProperty('central');
    });

    it('sends none for a choice made before the window lost the right (a reconnect that answered 404)', async () => {
      open();
      choose('global');
      act(() => useMcpStore.setState({ available: false }));

      expect(picker()).toBeNull();
      expect(await create()).not.toHaveProperty('central');
    });

    it('shows no picker in the phone app, whatever mcpStore says', () => {
      vi.stubGlobal('navigator', { ...navigator, userAgent: 'Mozilla/5.0 (iPhone) AppleWebKit/605.1.15 AASC-Mobile/1 (ios)' });
      open();

      expect(picker()).toBeNull();
    });
  });

  describe('the dashboard password warning', () => {
    it('is shown when no password is set', () => {
      useMcpStore.setState({ passwordEnabled: false });
      open();

      expect(screen.getByText(NO_PASSWORD)).toBeInTheDocument();
    });

    it('is not shown with a password, or before it is known', () => {
      useMcpStore.setState({ passwordEnabled: true });
      open();
      expect(screen.queryByText(NO_PASSWORD)).toBeNull();
      act(() => useMcpStore.setState({ passwordEnabled: null }));
      expect(screen.queryByText(NO_PASSWORD)).toBeNull();
    });
  });

  it('shows the server\'s refusal as it comes, and keeps the form open', async () => {
    const refusal = 'A project central needs a project folder, not your home folder: its scope would take in every session';
    fetchMock.mockImplementation(async (url: string, options?: RequestInit) => {
      if (url === '/api/terminals' && options?.method === 'POST') {
        return { ok: false, status: 400, json: async () => ({ ok: false, error: refusal }) } as Response;
      }
      return { ok: true, json: async () => ({}) } as Response;
    });
    open();
    choose('project');

    fireEvent.click(screen.getByText('CREATE'));

    await waitFor(() => expect(showToast).toHaveBeenCalledWith(refusal, 'error'));
    expect(useUiStore.getState().activeModal).toBe('new-session');
    expect(picker()?.value).toBe('project');
  });
});
