// test/cliLogin.test.ts — setup's login reading (hooks/cliLogin.js) must agree with the server's
// (server/cliAuth.ts), and its offer asks only for a definite "logged out". No CLI runs here.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseClaudeAuthStatus, parseCodexLoginStatus } from '../server/cliAuth.js';

const spawnSync = vi.fn();
vi.mock('child_process', () => ({ spawnSync: (...args: unknown[]) => spawnSync(...args) }));

const { loginStateOf, loginLineOf, offerLogins } = await import('../hooks/cliLogin.js');

const r = (stdout: string, code = 0, stderr = '') => ({ code, stdout, stderr, timedOut: false });

const CASES: Array<['claude' | 'codex', ReturnType<typeof r>]> = [
  ['claude', r('{"loggedIn": true, "authMethod": "claude.ai"}')],
  ['claude', r('{"loggedIn": false, "authMethod": "none"}')],
  ['claude', r('note\n{"loggedIn": true, "authMethod": "console"}')],
  ['claude', r('', 1, "error: unknown command 'auth'")],
  ['claude', r('', 127, 'zsh:1: command not found: claude')],
  ['codex', r('', 1, 'Not logged in\n')],
  ['codex', r('Logged in using ChatGPT\n')],
  ['codex', r('Logged in using an API key - sk-proj-***\n')],
  ['codex', r('', 1, 'Error loading configuration: x.toml:9:1: duplicate key')],
  ['codex', r('', 127, 'sh: codex: command not found')],
];

describe('loginStateOf agrees with server/cliAuth.ts', () => {
  it.each(CASES)('%s %#', (cli, result) => {
    const server = cli === 'claude' ? parseClaudeAuthStatus(result) : parseCodexLoginStatus(result);
    expect(loginStateOf(cli, result)).toEqual(server);
  });
});

describe('loginLineOf', () => {
  it('uses the device code for Codex over ssh or headless', () => {
    expect(loginLineOf('codex', { remote: true })).toBe('codex login --device-auth');
    expect(loginLineOf('codex', { remote: false })).toBe('codex login');
    expect(loginLineOf('claude', { remote: true })).toBe('claude auth login');
  });
});

describe('offerLogins', () => {
  const out = { ok: vi.fn(), warn: vi.fn(), info: vi.fn() };
  const io = (answer: string) => ({ ask: vi.fn(async () => answer), pause: vi.fn(), resume: vi.fn(), out, remote: true });
  const status = (stdout: string, status = 0, stderr = '') => ({ status, stdout, stderr });

  beforeEach(() => {
    spawnSync.mockReset();
    Object.values(out).forEach((f) => f.mockReset());
  });

  it('asks nothing when the CLI is logged in', async () => {
    spawnSync.mockReturnValue(status('{"loggedIn": true, "authMethod": "claude.ai"}'));
    const opts = io('y');
    await offerLogins(['claude'], opts);
    expect(opts.ask).not.toHaveBeenCalled();
    expect(out.ok).toHaveBeenCalledWith('Claude Code: logged in (claude.ai)');
  });

  it('runs the login in the terminal on yes, handing the terminal over and back', async () => {
    spawnSync
      .mockReturnValueOnce(status('', 1, 'Not logged in'))
      .mockReturnValueOnce({ status: 0 })
      .mockReturnValueOnce(status('Logged in using ChatGPT'));
    const opts = io('');
    await offerLogins(['codex'], opts);
    expect(spawnSync.mock.calls[1][1]).toEqual(['-lc', 'codex login --device-auth']);
    expect(spawnSync.mock.calls[1][2]).toEqual({ stdio: 'inherit' });
    expect(opts.pause).toHaveBeenCalledTimes(1);
    expect(opts.resume).toHaveBeenCalledTimes(1);
    expect(out.ok).toHaveBeenCalledWith('Codex: logged in (ChatGPT)');
  });

  it('skips the login on no', async () => {
    spawnSync.mockReturnValue(status('{"loggedIn": false}'));
    await offerLogins(['claude'], io('n'));
    expect(spawnSync).toHaveBeenCalledTimes(1);
    expect(out.info).toHaveBeenCalled();
  });

  it('never asks on an unclear answer or a missing CLI, and ignores CLIs it does not know', async () => {
    spawnSync
      .mockReturnValueOnce(status('', 1, 'Error loading configuration: duplicate key'))
      .mockReturnValueOnce(status('', 127, 'command not found: codex'));
    const opts = io('y');
    await offerLogins(['claude', 'codex', 'gemini'], opts);
    expect(opts.ask).not.toHaveBeenCalled();
    expect(out.warn).toHaveBeenCalledTimes(2);
  });
});
