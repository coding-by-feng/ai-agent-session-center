import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import NewSessionModal from './NewSessionModal';
import { useRoomStore } from '@/stores/roomStore';
import { useSessionStore } from '@/stores/sessionStore';
import { useUiStore } from '@/stores/uiStore';

vi.mock('@/hooks/useKnownProjects', () => ({ useKnownProjects: () => [] }));
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
