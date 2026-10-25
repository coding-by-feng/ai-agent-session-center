import { describe, it, expect, vi } from 'vitest';
import {
  createCliVersions,
  parseVersion,
  isNewer,
  lastLine,
  maskHome,
  CLI_UPDATE_TIMEOUT_MS,
  LOG_ANNOUNCE_MS,
  type CliRunResult,
  type CliVersionsDeps,
} from '../server/cliVersions.js';

const ok = (stdout: string): CliRunResult => ({ code: 0, stdout, stderr: '', timedOut: false });

/** A fake world: versions per CLI, an update that bumps it, a registry answer. No real process runs. */
function world(overrides: Partial<CliVersionsDeps> = {}) {
  const installed: Record<string, string> = { claude: '2.1.310', codex: '0.163.0' };
  const latest: Record<string, string | null> = { claude: '2.1.310', codex: '0.164.0' };
  let now = 1_000;
  const run = vi.fn(async (cli: 'claude' | 'codex', action: 'version' | 'update'): Promise<CliRunResult> => {
    if (action === 'version') return ok(cli === 'claude' ? `${installed.claude} (Claude Code)\n` : `codex-cli ${installed.codex}\n`);
    installed[cli] = latest[cli] ?? installed[cli];
    return ok(`Updating…\nDone\n`);
  });
  const fetchLatest = vi.fn(async (cli: 'claude' | 'codex') => latest[cli]);
  const onChange = vi.fn();
  const deps: CliVersionsDeps = { run, fetchLatest, now: () => now, maskError: (t) => maskHome(t, '/Users/me'), onChange, ...overrides };
  return { deps, run, fetchLatest, onChange, installed, latest, advance: (ms: number) => { now += ms; } };
}

describe('parseVersion', () => {
  it('reads both CLIs’ --version lines', () => {
    expect(parseVersion('2.1.310 (Claude Code)\n')).toBe('2.1.310');
    expect(parseVersion('codex-cli 0.163.0\n')).toBe('0.163.0');
    expect(parseVersion('codex-cli 0.164.0-alpha.2')).toBe('0.164.0-alpha.2');
  });
  it('takes the last version line, past a login profile’s own output', () => {
    expect(parseVersion('nvm 0.39.7 loaded\n2.1.310 (Claude Code)\n')).toBe('2.1.310');
  });
  it('is null for anything else', () => {
    expect(parseVersion('command not found: codex')).toBeNull();
    expect(parseVersion('')).toBeNull();
  });
});

describe('isNewer', () => {
  it('compares each part as a number', () => {
    expect(isNewer('0.164.0', '0.163.0')).toBe(true);
    expect(isNewer('2.1.310', '2.1.99')).toBe(true);
    expect(isNewer('2.1.310', '2.1.310')).toBe(false);
    expect(isNewer('2.0.0', '2.1.0')).toBe(false);
  });
  it('ranks a release above its prerelease, and is false when either side is unknown', () => {
    expect(isNewer('1.0.0', '1.0.0-beta.1')).toBe(true);
    expect(isNewer('1.0.0-beta.1', '1.0.0')).toBe(false);
    expect(isNewer(null, '1.0.0')).toBe(false);
    expect(isNewer('1.0.0', null)).toBe(false);
  });
});

describe('lastLine', () => {
  it('is the last non-empty output line, ANSI stripped and capped', () => {
    expect(lastLine('a\n\x1b[31mnpm ERR! EACCES\x1b[0m\n\n')).toBe('npm ERR! EACCES');
    expect(lastLine('x'.repeat(500))).toHaveLength(200);
    expect(lastLine('  \n')).toBe('');
  });
});

describe('maskHome', () => {
  it('writes the home folder as ~ and leaves other text alone', () => {
    expect(maskHome('EACCES /Users/me/.npm/_cacache', '/Users/me')).toBe('EACCES ~/.npm/_cacache');
    expect(maskHome('EACCES /opt/homebrew/lib', '/Users/me')).toBe('EACCES /opt/homebrew/lib');
    expect(maskHome('/x', '/')).toBe('/x');
  });
});

describe('createCliVersions', () => {
  it('lists both CLIs with installed, latest and whether an update is there', async () => {
    const w = world();
    const list = await createCliVersions(w.deps).list();
    expect(list).toEqual([
      expect.objectContaining({ cli: 'claude', installed: '2.1.310', latest: '2.1.310', updateAvailable: false, update: { state: 'idle' } }),
      expect.objectContaining({ cli: 'codex', installed: '0.163.0', latest: '0.164.0', updateAvailable: true }),
    ]);
  });

  it('caches the reads for an hour unless refreshed', async () => {
    const w = world();
    const svc = createCliVersions(w.deps);
    await svc.list();
    await svc.list();
    expect(w.fetchLatest).toHaveBeenCalledTimes(2); // once per CLI
    w.advance(59 * 60_000);
    await svc.list();
    expect(w.fetchLatest).toHaveBeenCalledTimes(2);
    await svc.list(true);
    expect(w.fetchLatest).toHaveBeenCalledTimes(4);
    w.advance(61 * 60_000);
    await svc.list();
    expect(w.fetchLatest).toHaveBeenCalledTimes(6);
  });

  it('shares one read between callers asking at the same time', async () => {
    const w = world();
    const svc = createCliVersions(w.deps);
    await Promise.all([svc.list(), svc.list(), svc.list(true)]);
    expect(w.fetchLatest).toHaveBeenCalledTimes(2);
  });

  it('reports a CLI that is not installed, and a registry it could not reach', async () => {
    const w = world({
      run: vi.fn(async () => ({ code: 127, stdout: '', stderr: 'command not found', timedOut: false })),
      fetchLatest: vi.fn(async () => { throw new Error('offline'); }),
    });
    const list = await createCliVersions(w.deps).list();
    expect(list[0]).toMatchObject({ installed: null, latest: null, updateAvailable: false });
  });

  it('runs an update, announces updating then updated, and re-reads the version', async () => {
    const w = world();
    const svc = createCliVersions(w.deps);
    expect(svc.startUpdate('codex')).toBe('started');
    await svc.idle();
    expect(w.run).toHaveBeenCalledWith('codex', 'update', CLI_UPDATE_TIMEOUT_MS, expect.any(Function));
    const states = w.onChange.mock.calls.map((c) => c[0].update.state);
    expect(states).toEqual(['updating', 'updated']);
    const last = w.onChange.mock.calls.at(-1)![0];
    expect(last).toMatchObject({ cli: 'codex', installed: '0.164.0', updateAvailable: false, update: { state: 'updated', from: '0.163.0', to: '0.164.0' } });
  });

  it('streams the update’s output into its status, at most every LOG_ANNOUNCE_MS, and keeps it after', async () => {
    vi.useFakeTimers();
    try {
      const w = world();
      let release!: () => void;
      w.run.mockImplementation(async (cli, action, _timeout, onOutput) => {
        if (action === 'version') return ok(cli === 'claude' ? `${w.installed.claude} (Claude Code)` : `codex-cli ${w.installed.codex}`);
        onOutput?.('stdout', 'Updating Codex via `npm install -g @openai/codex`\n');
        onOutput?.('stderr', 'npm WARN /Users/me/.npmrc\n');
        await new Promise<void>((r) => { release = r; });
        onOutput?.('stdout', 'changed 2 packages in 6s\n');
        w.installed[cli] = '0.164.0';
        return ok('');
      });
      const svc = createCliVersions(w.deps);
      svc.startUpdate('codex');
      await vi.waitFor(() => expect(release).toBeTypeOf('function'));
      // Two chunks, one announce after the gap.
      expect(w.onChange.mock.calls.map((c) => c[0].update.log)).toEqual([[]]);
      await vi.advanceTimersByTimeAsync(LOG_ANNOUNCE_MS);
      const live = w.onChange.mock.calls.at(-1)![0].update;
      expect(live).toMatchObject({ state: 'updating', from: '0.163.0', startedAt: 1_000 });
      expect(live.log).toEqual(['Updating Codex via `npm install -g @openai/codex`', 'npm WARN ~/.npmrc']);
      release();
      await svc.idle();
      await vi.advanceTimersByTimeAsync(LOG_ANNOUNCE_MS);
      const states = w.onChange.mock.calls.map((c) => c[0].update.state);
      expect(states).toEqual(['updating', 'updating', 'updated']);
      expect(w.onChange.mock.calls.at(-1)![0].update).toMatchObject({ state: 'updated', startedAt: 1_000 });
      expect(w.onChange.mock.calls.at(-1)![0].update.log).toHaveLength(3);
      expect((await svc.list()).find((i) => i.cli === 'codex')!.update.log).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('says current when the update leaves the version unchanged', async () => {
    const w = world();
    const svc = createCliVersions(w.deps);
    svc.startUpdate('claude');
    await svc.idle();
    expect(w.onChange.mock.calls.at(-1)![0].update).toMatchObject({ state: 'current', from: '2.1.310', to: '2.1.310' });
  });

  it('fails with the CLI’s last output line when it exits non-zero', async () => {
    const w = world();
    w.run.mockImplementation(async (_cli, action) => (action === 'version'
      ? ok('codex-cli 0.163.0')
      : { code: 1, stdout: 'Updating Codex via `npm install -g @openai/codex`\n', stderr: 'npm ERR! code EACCES\n', timedOut: false }));
    const svc = createCliVersions(w.deps);
    svc.startUpdate('codex');
    await svc.idle();
    expect(w.onChange.mock.calls.at(-1)![0].update).toMatchObject({ state: 'failed', error: 'npm ERR! code EACCES' });
  });

  it('fails with a timeout message when the update runs too long', async () => {
    const w = world();
    w.run.mockImplementation(async (_cli, action) => (action === 'version' ? ok('codex-cli 0.163.0') : { code: null, stdout: '', stderr: '', timedOut: true }));
    const svc = createCliVersions(w.deps);
    svc.startUpdate('codex');
    await svc.idle();
    expect(w.onChange.mock.calls.at(-1)![0].update.error).toMatch(/5 minutes/);
  });

  it('fails cleanly when the update cannot start at all', async () => {
    const w = world();
    w.run.mockImplementation(async (_cli, action) => {
      if (action === 'update') throw new Error('spawn ENOENT');
      return ok('codex-cli 0.163.0');
    });
    const svc = createCliVersions(w.deps);
    svc.startUpdate('codex');
    await svc.idle();
    expect(w.onChange.mock.calls.at(-1)![0].update).toMatchObject({ state: 'failed', error: 'spawn ENOENT' });
  });

  it('masks the home folder in a failure it broadcasts', async () => {
    const w = world();
    w.run.mockImplementation(async (_cli, action) => (action === 'version'
      ? ok('codex-cli 0.163.0')
      : { code: 1, stdout: '', stderr: 'npm ERR! EACCES /Users/me/.npm/_logs/x.log\n', timedOut: false }));
    const svc = createCliVersions(w.deps);
    svc.startUpdate('codex');
    await svc.idle();
    expect(w.onChange.mock.calls.at(-1)![0].update.error).toBe('npm ERR! EACCES ~/.npm/_logs/x.log');
  });

  it('never lets a refresh that started mid-update replace what the update read', async () => {
    const w = world();
    const svc = createCliVersions(w.deps);
    await svc.list();
    // The refresh's --version runs while the binary is being swapped and reads the old version late.
    let releaseStale!: () => void;
    let releaseUpdate!: () => void;
    w.run.mockImplementation(async (cli, action) => {
      if (action === 'update') { await new Promise<void>((r) => { releaseUpdate = r; }); w.installed[cli] = '0.164.0'; return ok('done'); }
      if (cli === 'codex' && !releaseStale) { await new Promise<void>((r) => { releaseStale = r; }); return ok('codex-cli 0.163.0'); }
      return ok(cli === 'claude' ? `${w.installed.claude} (Claude Code)` : `codex-cli ${w.installed.codex}`);
    });
    svc.startUpdate('codex');
    await vi.waitFor(() => expect(releaseUpdate).toBeTypeOf('function'));
    const refresh = svc.list(true);
    await vi.waitFor(() => expect(releaseStale).toBeTypeOf('function'));
    releaseUpdate();
    await svc.idle();
    releaseStale();
    const answered = await refresh;
    expect(answered.find((i) => i.cli === 'codex')!.installed).toBe('0.164.0');
    expect((await svc.list()).find((i) => i.cli === 'codex')!.installed).toBe('0.164.0');
  });

  it('runs one update at a time, across both CLIs', async () => {
    const w = world();
    let release!: () => void;
    w.run.mockImplementation(async (cli, action) => {
      if (action === 'version') return ok(cli === 'claude' ? '2.1.310 (Claude Code)' : 'codex-cli 0.163.0');
      await new Promise<void>((r) => { release = r; });
      return ok('done');
    });
    const svc = createCliVersions(w.deps);
    expect(svc.startUpdate('codex')).toBe('started');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    expect(svc.startUpdate('codex')).toBe('busy');
    expect(svc.startUpdate('claude')).toBe('busy');
    expect(svc.busy()).toBe('codex');
    release();
    await svc.idle();
    expect(svc.busy()).toBeNull();
    expect(svc.startUpdate('claude')).toBe('started');
    await vi.waitFor(() => expect(svc.busy()).toBe('claude'));
    release();
    await svc.idle();
  });

  it('shows the running update on a list read', async () => {
    const w = world();
    let release!: () => void;
    w.run.mockImplementation(async (_cli, action) => {
      if (action === 'version') return ok('codex-cli 0.163.0');
      await new Promise<void>((r) => { release = r; });
      return ok('done');
    });
    const svc = createCliVersions(w.deps);
    svc.startUpdate('codex');
    await vi.waitFor(() => expect(release).toBeTypeOf('function'));
    const during = await svc.list();
    expect(during.find((i) => i.cli === 'codex')!.update.state).toBe('updating');
    release();
    await svc.idle();
  });
});
