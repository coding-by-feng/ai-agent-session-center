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

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/api/terminals', expect.objectContaining({ method: 'POST' })));
    const call = fetchMock.mock.calls.find(([url]) => url === '/api/terminals');
    const body = JSON.parse(String(call?.[1]?.body)) as Record<string, unknown>;
    expect(body.workingDir).toBe('/w/app');
    expect(body.command).toBe('codex');
    const allowed = new Set(['workingDir', 'command', 'forceNew', 'requireExistingDir', 'sessionTitle', 'label', 'model', 'effortLevel']);
    expect(Object.keys(body).filter((k) => !allowed.has(k))).toEqual([]);
  });
});
