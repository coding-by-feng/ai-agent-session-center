import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import NewSessionModal from './NewSessionModal';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

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
