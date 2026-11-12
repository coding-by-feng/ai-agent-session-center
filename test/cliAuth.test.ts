// test/cliAuth.test.ts — reading whether claude / codex are signed in. The runner is a fake: no CLI runs.
import { describe, it, expect, vi } from 'vitest';
import {
  createCliAuth,
  parseClaudeAuthStatus,
  parseCodexLoginStatus,
  CLI_AUTH_TTL_MS,
  CLI_AUTH_MIN_REFRESH_MS,
} from '../server/cliAuth.js';
import type { CliRunResult } from '../server/cliVersions.js';
import { cliLoginsNeeded } from '../src/types/cliAuth.js';

const ok = (stdout: string, code = 0, stderr = ''): CliRunResult => ({ code, stdout, stderr, timedOut: false });

describe('parseClaudeAuthStatus', () => {
  it('reads loggedIn true with its method', () => {
    expect(parseClaudeAuthStatus(ok('{"loggedIn": true, "authMethod": "claude.ai"}'))).toEqual({
      state: 'logged-in', method: 'claude.ai', detail: null,
    });
  });

  it('reads loggedIn false', () => {
    const out = '{\n  "loggedIn": false,\n  "authMethod": "none",\n  "apiProvider": "firstParty"\n}\n';
    expect(parseClaudeAuthStatus(ok(out))).toEqual({ state: 'logged-out', method: null, detail: null });
  });

  it('finds the JSON after a warning line', () => {
    expect(parseClaudeAuthStatus(ok('warning: something\n{"loggedIn": true, "authMethod": "console"}')).state).toBe('logged-in');
  });

  it('is unknown, never logged out, without JSON (an old CLI)', () => {
    expect(parseClaudeAuthStatus(ok('', 1, "error: unknown command 'auth'"))).toEqual({
      state: 'unknown', method: null, detail: "error: unknown command 'auth'",
    });
  });

  it('is missing when the shell cannot find claude', () => {
    expect(parseClaudeAuthStatus(ok('', 127, 'zsh:1: command not found: claude')).state).toBe('missing');
  });
});

describe('parseCodexLoginStatus', () => {
  it('reads "Not logged in"', () => {
    expect(parseCodexLoginStatus(ok('', 1, 'Not logged in\n'))).toEqual({ state: 'logged-out', method: null, detail: null });
  });

  it('reads "Logged in using ChatGPT"', () => {
    expect(parseCodexLoginStatus(ok('Logged in using ChatGPT\n'))).toEqual({ state: 'logged-in', method: 'ChatGPT', detail: null });
  });

  it('never repeats an API key', () => {
    const r = parseCodexLoginStatus(ok('Logged in using an API key - sk-proj-abc***xyz\n'));
    expect(r).toEqual({ state: 'logged-in', method: 'API key', detail: null });
  });

  it('is unknown on a config error, not logged out', () => {
    const r = parseCodexLoginStatus(ok('', 1, 'Error loading configuration: /Users/x/.codex/config.toml:9:1: duplicate key\n'));
    expect(r.state).toBe('unknown');
    expect(r.detail).toContain('duplicate key');
  });

  it('is missing when the shell cannot find codex', () => {
    expect(parseCodexLoginStatus(ok('', 127, 'sh: codex: command not found')).state).toBe('missing');
  });
});

describe('createCliAuth', () => {
  const runner = () => vi.fn(async (cli: 'claude' | 'codex') =>
    cli === 'claude' ? ok('{"loggedIn": false, "authMethod": "none"}') : ok('Logged in using ChatGPT'));

  it('checks only the enabled CLIs', async () => {
    const run = runner();
    const auth = createCliAuth({ run, enabledClis: () => ['claude'], host: () => 'mbp', now: () => 1 });
    const report = await auth.check();
    expect(report.host).toBe('mbp');
    expect(report.clis.map((c) => c.cli)).toEqual(['claude']);
    expect(run).toHaveBeenCalledTimes(1);
    expect(cliLoginsNeeded(report).map((c) => c.cli)).toEqual(['claude']);
  });

  it('caches a reading for the TTL, and one in flight is shared', async () => {
    let t = 1_000;
    const run = runner();
    const auth = createCliAuth({ run, enabledClis: () => ['claude', 'codex'], host: () => 'h', now: () => t });
    await Promise.all([auth.check(), auth.check()]);
    expect(run).toHaveBeenCalledTimes(2);
    t += CLI_AUTH_TTL_MS - 1;
    await auth.check();
    expect(run).toHaveBeenCalledTimes(2);
    t += 2;
    await auth.check();
    expect(run).toHaveBeenCalledTimes(4);
  });

  it('refresh re-reads, but not more often than the minimum gap', async () => {
    let t = 1_000;
    const run = runner();
    const auth = createCliAuth({ run, enabledClis: () => ['codex'], host: () => 'h', now: () => t });
    await auth.check();
    t += CLI_AUTH_MIN_REFRESH_MS - 1;
    await auth.check({ refresh: true });
    expect(run).toHaveBeenCalledTimes(1);
    t += 2;
    await auth.check({ refresh: true });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('a run that throws or times out reads unknown', async () => {
    const run = vi.fn(async (cli: 'claude' | 'codex') => {
      if (cli === 'claude') throw new Error('spawn failed');
      return { code: null, stdout: '', stderr: '', timedOut: true };
    });
    const auth = createCliAuth({ run, enabledClis: () => ['claude', 'codex'], host: () => 'h', now: () => 1 });
    const report = await auth.check();
    expect(report.clis.map((c) => [c.cli, c.state, c.detail])).toEqual([
      ['claude', 'unknown', 'spawn failed'],
      ['codex', 'unknown', 'timed out'],
    ]);
  });
});
