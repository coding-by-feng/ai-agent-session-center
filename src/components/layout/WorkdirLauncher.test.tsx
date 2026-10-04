import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';

import WorkdirLauncher from './WorkdirLauncher';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';

// The DIRS launcher: a recent directory, a CLI button, one POST. NavBar's tests stub the whole
// component out, so nothing else pins what a click here actually sends.
vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));
// One array for every render: the component re-runs its effect whenever the list's identity changes, so a
// factory returning a fresh literal each call re-renders it forever.
const { KNOWN } = vi.hoisted(() => ({ KNOWN: ['/Users/me/agent-manager'] }));
vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => KNOWN }));

const DIR = '/Users/me/agent-manager';

const jsonResponse = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('WorkdirLauncher', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let selectSession: ReturnType<typeof vi.fn>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    selectSession = vi.fn();
    useSessionStore.setState({ selectSession } as never);
    vi.mocked(showToast).mockClear();
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession } as never);
    vi.unstubAllGlobals();
  });

  const launch = (label: 'Claude' | 'Codex') => {
    render(<WorkdirLauncher />);
    fireEvent.click(screen.getByRole('button', { name: 'DIRS' }));
    fireEvent.click(screen.getByRole('button', { name: `Launch ${label} in agent-manager` }));
  };

  it('starts the chosen CLI in the directory with a plain { workingDir, command } body', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-1' }));
    launch('Codex');

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe('/api/terminals');
    expect(init?.method).toBe('POST');
    // No forceNew: re-launching a directory that already runs the CLI reuses that session.
    expect(JSON.parse(String(init?.body))).toEqual({ workingDir: DIR, command: 'codex' });
  });

  it('selects the new session and says so', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, terminalId: 'term-9' }));
    launch('Claude');

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('term-9'));
    expect(showToast).toHaveBeenCalledWith('Launched claude in agent-manager', 'success');
    // The dropdown closes on launch.
    expect(screen.queryByText('Recent Directories')).toBeNull();
  });

  it('says so, rather than claiming a launch, when the server hands back the session already running there', async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: true, terminalId: 'existing', deduplicated: true }));
    launch('Claude');

    await waitFor(() => expect(selectSession).toHaveBeenCalledWith('existing'));
    expect(showToast).toHaveBeenCalledWith('claude is already running in agent-manager', 'info');
  });

  it("shows the server's reason when it refuses, and selects nothing", async () => {
    fetchMock.mockResolvedValue(jsonResponse({ ok: false, error: 'Session limit reached' }));
    launch('Claude');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Session limit reached', 'error'));
    expect(selectSession).not.toHaveBeenCalled();
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
    launch('Claude');

    await waitFor(() => expect(showToast).toHaveBeenCalledWith('Network error launching session', 'error'));
    expect(selectSession).not.toHaveBeenCalled();
  });
});
