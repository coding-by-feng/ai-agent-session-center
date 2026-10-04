import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { launchSession, launchBlocker, shortenPath, MAX_WORKING_DIR_LENGTH } from './launchSession';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';

vi.mock('@/components/ui/ToastContainer', () => ({ showToast: vi.fn() }));

const DIR = '/Users/me/agent-manager';

const reply = (body: unknown) => ({ ok: true, json: async () => body }) as Response;

describe('launchSession', () => {
  let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
  let selectSession: ReturnType<typeof vi.fn>;
  const realSelectSession = useSessionStore.getState().selectSession;

  beforeEach(() => {
    try { localStorage.clear(); } catch { /* ignore */ }
    fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal('fetch', fetchMock);
    selectSession = vi.fn();
    useSessionStore.setState({ selectSession, selectedSessionId: null } as never);
    vi.mocked(showToast).mockClear();
  });

  afterEach(() => {
    useSessionStore.setState({ selectSession: realSelectSession, selectedSessionId: null } as never);
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const sentBody = () => JSON.parse(String(fetchMock.mock.calls[0][1]?.body)) as Record<string, unknown>;

  describe('what it asks the server for', () => {
    it('POSTs the directory and the CLI to /api/terminals', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'claude' });

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('/api/terminals');
      expect(init?.method).toBe('POST');
      expect((init?.headers as Record<string, string>)['Content-Type']).toBe('application/json');
    });

    it('sends no forceNew by default, so a directory already running that CLI is reused', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'codex' });
      expect(sentBody()).toEqual({ workingDir: DIR, command: 'codex' });
    });

    it('sends forceNew when asked, so the server starts a session instead of reusing one', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      expect(sentBody()).toEqual({ workingDir: DIR, command: 'claude', forceNew: true });
    });

    it('sends requireExistingDir when asked, so a directory that is gone is refused rather than swapped for home', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'claude', forceNew: true, requireExistingDir: true });
      expect(sentBody()).toEqual({ workingDir: DIR, command: 'claude', forceNew: true, requireExistingDir: true });
    });

    it('leaves forceNew and requireExistingDir out rather than sending false', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'claude', forceNew: false, requireExistingDir: false });
      expect(sentBody()).toEqual({ workingDir: DIR, command: 'claude' });
    });
  });

  describe('when the server starts the session', () => {
    it('selects it and says so', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 'term-7' }));
      const result = await launchSession({ workingDir: DIR, command: 'claude' });

      expect(result).toEqual({ ok: true, terminalId: 'term-7', deduplicated: false });
      expect(selectSession).toHaveBeenCalledWith('term-7');
      expect(showToast).toHaveBeenCalledWith('Launched claude in agent-manager', 'success');
    });

    it('does not write a per-directory memo: nothing ever read dir-session-configs', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'claude' });
      expect(localStorage.getItem('dir-session-configs')).toBeNull();
    });

    it('does not select anything when the reply carries no terminal id', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true }));
      const result = await launchSession({ workingDir: DIR, command: 'claude' });
      expect(result).toEqual({ ok: true, terminalId: undefined, deduplicated: false });
      expect(selectSession).not.toHaveBeenCalled();
    });
  });

  describe('when the server hands back a session that was already running there', () => {
    it('selects it and says it was already running — nothing new was launched', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 'existing', deduplicated: true }));
      const result = await launchSession({ workingDir: DIR, command: 'claude' });

      expect(result).toEqual({ ok: true, terminalId: 'existing', deduplicated: true });
      expect(selectSession).toHaveBeenCalledWith('existing');
      expect(showToast).toHaveBeenCalledWith('claude is already running in agent-manager', 'info');
      expect(showToast).not.toHaveBeenCalledWith(expect.stringContaining('Launched'), expect.anything());
    });

    it('does not re-select the session you are already viewing: that would make it its own "previous" and break go-back', async () => {
      useSessionStore.setState({ selectedSessionId: 'existing' } as never);
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 'existing', deduplicated: true }));
      await launchSession({ workingDir: DIR, command: 'claude' });

      expect(selectSession).not.toHaveBeenCalled();
      expect(showToast).toHaveBeenCalledWith('claude is already running in agent-manager', 'info');
    });

    it('still selects a new session even when another one is being viewed', async () => {
      useSessionStore.setState({ selectedSessionId: 'something-else' } as never);
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 'brand-new' }));
      await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      expect(selectSession).toHaveBeenCalledWith('brand-new');
    });
  });

  describe('one launch at a time per project and CLI', () => {
    /** A request that stays open until the test lets it go. */
    const hold = () => {
      let release!: (value: Response) => void;
      fetchMock.mockImplementationOnce(() => new Promise<Response>((resolveFetch) => { release = resolveFetch; }));
      return () => release(reply({ ok: true, terminalId: 't1' }));
    };

    it('refuses a second request for the same project and CLI while the first is out, and says why', async () => {
      const finish = hold();
      const first = launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      const second = await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });

      expect(second).toEqual({ ok: false, error: 'Already starting claude in agent-manager' });
      expect(showToast).toHaveBeenCalledWith('Already starting claude in agent-manager', 'info');
      expect(fetchMock).toHaveBeenCalledTimes(1);
      finish();
      await first;
    });

    it('does not hold back a different CLI, or a different project', async () => {
      const finish = hold();
      const first = launchSession({ workingDir: DIR, command: 'claude', forceNew: true });

      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 'other' }));
      const otherCli = await launchSession({ workingDir: DIR, command: 'codex', forceNew: true });
      const otherDir = await launchSession({ workingDir: '/Users/me/kts', command: 'claude', forceNew: true });

      expect(otherCli.ok).toBe(true);
      expect(otherDir.ok).toBe(true);
      finish();
      await first;
    });

    it('lets go when the request finishes, so the next one goes through', async () => {
      fetchMock.mockResolvedValue(reply({ ok: true, terminalId: 't1' }));
      await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      const again = await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      expect(again.ok).toBe(true);
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('lets go after a failure too', async () => {
      fetchMock.mockRejectedValueOnce(new TypeError('Failed to fetch'));
      await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      fetchMock.mockResolvedValueOnce(reply({ ok: true, terminalId: 't1' }));
      const again = await launchSession({ workingDir: DIR, command: 'claude', forceNew: true });
      expect(again.ok).toBe(true);
    });
  });

  describe('when it fails', () => {
    it("shows the server's reason, selects nothing", async () => {
      fetchMock.mockResolvedValue(reply({ ok: false, error: 'Session limit reached' }));
      const result = await launchSession({ workingDir: DIR, command: 'claude' });

      expect(result).toEqual({ ok: false, error: 'Session limit reached' });
      expect(showToast).toHaveBeenCalledWith('Session limit reached', 'error');
      expect(selectSession).not.toHaveBeenCalled();
    });

    it('has a fallback message when the server gives no reason', async () => {
      fetchMock.mockResolvedValue(reply({ ok: false }));
      const result = await launchSession({ workingDir: DIR, command: 'claude' });

      expect(result).toEqual({ ok: false, error: 'Failed to launch session' });
      expect(showToast).toHaveBeenCalledWith('Failed to launch session', 'error');
    });

    it('reports a network failure', async () => {
      fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));
      const result = await launchSession({ workingDir: DIR, command: 'claude' });

      expect(result).toEqual({ ok: false, error: 'Network error launching session' });
      expect(showToast).toHaveBeenCalledWith('Network error launching session', 'error');
      expect(selectSession).not.toHaveBeenCalled();
    });

    it('treats a reply that is not JSON like a network failure', async () => {
      fetchMock.mockResolvedValue({ ok: false, json: async () => { throw new SyntaxError('Unexpected token <'); } } as unknown as Response);
      const result = await launchSession({ workingDir: DIR, command: 'claude' });

      expect(result).toEqual({ ok: false, error: 'Network error launching session' });
      expect(showToast).toHaveBeenCalledWith('Network error launching session', 'error');
    });
  });
});

describe('launchBlocker', () => {
  it('lets an ordinary path through, whatever it holds besides the forbidden characters', () => {
    for (const path of ['/Users/me/agent-manager', '/Users/me/My Projects/site', '/Users/me/项目/app', '/w/app-1.2_x', '~', '~/work/app', 'C:/work/app']) {
      expect(launchBlocker(path)).toBeNull();
    }
  });

  it('names the characters the server will refuse', () => {
    expect(launchBlocker('/Users/me/Projects/site (old)')).toContain('( )');
    expect(launchBlocker('/w/app;rm')).toContain(';');
    expect(launchBlocker('/w/$HOME/app')).toContain('$');
    expect(launchBlocker('C:\\work\\app')).toContain('\\');
    expect(launchBlocker('/w/a\nb')).toContain('\\n');
  });

  it('lists each offending character once', () => {
    const reason = launchBlocker('/w/(a)(b)')!;
    expect(reason.match(/\(/g)).toHaveLength(1);
  });

  it('refuses a path longer than the server allows', () => {
    expect(launchBlocker('/' + 'a'.repeat(MAX_WORKING_DIR_LENGTH - 1))).toBeNull();
    expect(launchBlocker('/' + 'a'.repeat(MAX_WORKING_DIR_LENGTH))).toMatch(/longer than/);
  });

  it('ignores a leading ~, as the server does', () => {
    // ~ itself is not on the forbidden list, but the server strips it before the check anyway.
    expect(launchBlocker('~/app')).toBeNull();
  });

  // The server owns the rule (server/apiRouter.ts: SHELL_META_RE + noShellMetaWorkDir) and this is a copy, because
  // the renderer cannot import from server/. If the two drift, a chip is either disabled for a path the server
  // would accept or enabled for one it refuses — so compare behaviour against the server's own source.
  describe('stays the same rule as the server', () => {
    const source = readFileSync(resolve(__dirname, '../../server/apiRouter.ts'), 'utf8');
    const metaLiteral = source.match(/const SHELL_META_RE = \/(.+)\/;/)?.[1];
    const maxLiteral = source.match(/const noShellMetaWorkDir = z\.string\(\)\.max\((\d+)\)/)?.[1];

    it('finds the server rule to compare against', () => {
      expect(metaLiteral).toBeTruthy();
      expect(maxLiteral).toBeTruthy();
    });

    it('agrees on every ASCII character', () => {
      const server = new RegExp(metaLiteral!);
      const disagreements: string[] = [];
      for (let code = 0; code < 128; code++) {
        const path = `/w/a${String.fromCharCode(code)}b`;
        const serverRefuses = server.test(path.replace(/^~/, ''));
        const clientRefuses = launchBlocker(path) !== null;
        if (serverRefuses !== clientRefuses) disagreements.push(`U+${code.toString(16).padStart(4, '0')}`);
      }
      expect(disagreements).toEqual([]);
    });

    it('agrees on the length limit', () => {
      expect(MAX_WORKING_DIR_LENGTH).toBe(Number(maxLiteral));
    });
  });
});

describe('shortenPath', () => {
  it('keeps the last folder', () => {
    expect(shortenPath('/Users/me/agent-manager')).toBe('agent-manager');
    expect(shortenPath('/Users/me/agent-manager/')).toBe('agent-manager');
  });

  it('leaves the home and root markers alone', () => {
    expect(shortenPath('~')).toBe('~');
    expect(shortenPath('/')).toBe('/');
  });

  it('copes with nothing at all', () => {
    expect(shortenPath('')).toBe('');
  });
});
