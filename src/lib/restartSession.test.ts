// restartSession.test.ts — the client half of the terminal toolbar's "Restart session".
import { describe, it, expect, vi, afterEach } from 'vitest';
import { restartNeedsConfirm, restartConfirmMessage, requestSessionRestart } from './restartSession';

afterEach(() => { vi.unstubAllGlobals(); });

describe('restartNeedsConfirm', () => {
  it.each(['prompting', 'working', 'approval', 'input'])('asks first while the session is %s, because a restart kills that turn', (status) => {
    expect(restartNeedsConfirm(status)).toBe(true);
  });

  it.each(['idle', 'waiting', 'connecting', 'ended'])('restarts a %s session without asking', (status) => {
    expect(restartNeedsConfirm(status)).toBe(false);
  });

  it('does not ask about a session it knows nothing about', () => {
    expect(restartNeedsConfirm(undefined)).toBe(false);
  });
});

describe('restartConfirmMessage', () => {
  it('names the session and says what is lost and what is kept', () => {
    const msg = restartConfirmMessage('Release notes');
    expect(msg).toContain('Release notes');
    expect(msg).toMatch(/running/i);
    expect(msg).toMatch(/resume/i);
  });
});

describe('requestSessionRestart', () => {
  it('POSTs to the session\'s restart-terminal route and returns the new terminal id', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, terminalId: 'term-new' }) });
    vi.stubGlobal('fetch', fetchMock);

    await expect(requestSessionRestart('abc-123')).resolves.toEqual({ ok: true, terminalId: 'term-new' });
    // A JSON body, like /kill: a body-less POST is a "simple" cross-site request that needs no preflight.
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/abc-123/restart-terminal', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
  });

  it('encodes the id into the path', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ ok: true, terminalId: 't' }) });
    vi.stubGlobal('fetch', fetchMock);
    await requestSessionRestart('a/b');
    expect(fetchMock.mock.calls[0][0]).toBe('/api/sessions/a%2Fb/restart-terminal');
  });

  it('hands back the server\'s own reason when it refuses', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false, status: 409, json: async () => ({ error: 'Restart is not available for tmux sessions' }),
    }));
    await expect(requestSessionRestart('s')).resolves.toEqual({ ok: false, error: 'Restart is not available for tmux sessions' });
  });

  it('falls back to the status code when the refusal has no body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 502, json: async () => { throw new Error('not json'); } }));
    const result = await requestSessionRestart('s');
    expect(result).toMatchObject({ ok: false });
    expect(result.ok === false && result.error).toContain('502');
  });

  it('reports a network failure instead of throwing', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('offline')));
    await expect(requestSessionRestart('s')).resolves.toEqual({ ok: false, error: 'offline' });
  });
});
