// sessionActions.test.ts — the kill and resume requests shared by the desktop
// dialog and the phone header (AASC-18). fetch is stubbed: nothing here reaches
// a real process (see .claude/rules/known-issues.md).
import { describe, it, expect, afterEach, vi } from 'vitest';

vi.mock('@/lib/terminalTransport', () => ({ closeManagedTerminal: vi.fn(async () => undefined) }));

import { requestSessionKill, requestSessionResume } from './sessionActions';
import { closeManagedTerminal } from '@/lib/terminalTransport';

function stubJson(body: unknown) {
  const fetchMock = vi.fn(async () => ({ ok: true, status: 200, json: async () => body }));
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.mocked(closeManagedTerminal).mockReset();
});

describe('requestSessionKill', () => {
  it('posts a confirmed kill and closes the terminal the server names', async () => {
    const fetchMock = stubJson({ ok: true, terminalId: 'term-9', killedPid: 4242 });
    const result = await requestSessionKill('s1', 'term-1');
    expect(fetchMock).toHaveBeenCalledWith('/api/sessions/s1/kill', expect.objectContaining({
      method: 'POST', body: JSON.stringify({ confirm: true }),
    }));
    expect(closeManagedTerminal).toHaveBeenCalledWith('term-9');
    expect(result).toEqual({ ok: true, message: 'PID 4242 terminated', warning: undefined });
  });

  it('falls back to the card terminal and never claims a phantom kill', async () => {
    stubJson({ ok: true });
    const result = await requestSessionKill('s1', 'term-1');
    expect(closeManagedTerminal).toHaveBeenCalledWith('term-1');
    expect(result.message).toBe('Session closed — no running process found');
  });

  it('names a process that survived SIGKILL', async () => {
    stubJson({ ok: false, stillAlivePid: 77 });
    await expect(requestSessionKill('s1')).resolves.toEqual({
      ok: false, message: 'Failed to kill process 77 — it survived SIGKILL',
    });
  });

  it('still succeeds, with a warning, when the terminal will not close', async () => {
    stubJson({ ok: true, terminalId: 'term-9' });
    vi.mocked(closeManagedTerminal).mockRejectedValueOnce(new Error('gone'));
    const result = await requestSessionKill('s1');
    expect(result).toMatchObject({ ok: true, warning: 'Failed to close terminal' });
  });
});

describe('requestSessionResume', () => {
  it('reports the server error', async () => {
    stubJson({ ok: false, error: 'No transcript to resume' });
    await expect(requestSessionResume('s1')).resolves.toEqual({ ok: false, message: 'No transcript to resume' });
  });

  // HISTORY resumes rows the live store no longer holds; the server names the CLI it resumed with.
  it('names the CLI a history row was resumed with, instead of always saying Claude', async () => {
    stubJson({ ok: true, terminalId: 'term-1', cli: 'codex', newTerminal: true });
    await expect(requestSessionResume('s1')).resolves.toEqual({ ok: true, message: 'Resuming the Codex conversation in a new terminal' });
    stubJson({ ok: true, terminalId: 'term-2', cli: 'claude', newTerminal: true });
    await expect(requestSessionResume('s1')).resolves.toEqual({ ok: true, message: 'Resuming the Claude conversation in a new terminal' });
  });

  it('a session that is still running is not resumed again, and says where it is', async () => {
    stubJson({ ok: true, alreadyRunning: true, sessionId: 's1' });
    await expect(requestSessionResume('s1')).resolves.toEqual({ ok: true, alreadyRunning: true, message: 'Already running: open it from LIVE' });
  });

  it('a card resumed in its own terminal names no CLI (a Codex card was told "Claude")', async () => {
    stubJson({ ok: true, terminalId: 'term-3' });
    await expect(requestSessionResume('s1')).resolves.toEqual({ ok: true, message: 'Resuming the session in its terminal' });
  });

  it('a reply that is not JSON (a proxy error page) is a failure, not a throw', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 502, json: async () => { throw new SyntaxError('bad'); } })));
    await expect(requestSessionResume('s1')).resolves.toEqual({ ok: false, message: 'Resume failed' });
  });

  it('uses the fetch it is given (the desktop sends its sign-in token) and encodes the id', async () => {
    const fetcher = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) })) as unknown as typeof fetch;
    await requestSessionResume('a/b', undefined, fetcher);
    expect(vi.mocked(fetcher).mock.calls[0][0]).toBe('/api/sessions/a%2Fb/resume');
  });
});
