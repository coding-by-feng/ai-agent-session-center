import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import QuickSessionModal from './QuickSessionModal';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

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
