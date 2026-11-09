import { afterEach, describe, expect, it, vi } from 'vitest';
import { closeManagedTerminal } from './terminalTransport';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('closeManagedTerminal', () => {
  it('closes a terminal by removing its server registration', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true } as Response);
    vi.stubGlobal('fetch', fetchMock);

    await closeManagedTerminal('term-codex');

    expect(fetchMock).toHaveBeenCalledWith('/api/terminals/term-codex', { method: 'DELETE' });
  });

  it('throws when the server refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false } as Response));

    await expect(closeManagedTerminal('term-codex')).rejects.toThrow('Failed to close terminal registration');
  });
});
