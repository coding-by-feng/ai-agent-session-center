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
});
