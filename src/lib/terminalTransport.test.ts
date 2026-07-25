import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeManagedTerminal } from './terminalTransport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete window.electronAPI;
});

describe('closeManagedTerminal', () => {
  it('kills an Electron-owned PTY before removing its server registration', async () => {
    const killPty = vi.fn().mockResolvedValue({ ok: true });
    window.electronAPI = { killPty } as unknown as typeof window.electronAPI;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await closeManagedTerminal('pty-codex');

    expect(killPty).toHaveBeenCalledWith('pty-codex');
    expect(fetchMock).toHaveBeenCalledWith('/api/terminals/pty-codex', { method: 'DELETE' });
  });

  it('closes a server-owned terminal without invoking Electron IPC', async () => {
    const killPty = vi.fn();
    window.electronAPI = { killPty } as unknown as typeof window.electronAPI;
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await closeManagedTerminal('term-codex');

    expect(killPty).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledWith('/api/terminals/term-codex', { method: 'DELETE' });
  });
});
