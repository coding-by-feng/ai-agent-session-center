// test/serviceUnit.test.ts — `aasc-server install-service` / `uninstall-service` (cli/server/service.ts,
// terminal-editions plan §7.4–7.5).
//
// No systemctl, loginctl or journalctl runs here: every command goes through an injected runner that
// records it. Unit files are written into a temporary folder.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, chmodSync, readFileSync, existsSync, readdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  UNIT_NAME, unitPath, capturePath, buildUnit, writeUnitAtomic, installService, uninstallService,
  type ServiceDeps,
} from '../cli/server/service.js';

let dir = '';
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'aasc-service-')); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function tool(folder: string, name: string): void {
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, name), '#!/bin/sh\n');
  chmodSync(join(folder, name), 0o755);
}

describe('unitPath', () => {
  it('is the systemd user folder, honouring XDG_CONFIG_HOME', () => {
    expect(unitPath('/home/u', {})).toBe('/home/u/.config/systemd/user/aasc-server.service');
    expect(unitPath('/home/u', { XDG_CONFIG_HOME: '/xdg' })).toBe('/xdg/systemd/user/aasc-server.service');
    expect(UNIT_NAME).toBe('aasc-server');
  });
});

describe('capturePath', () => {
  it('puts the folders of node, claude, codex, jq, git and tailscale first, then the rest of PATH, then the system folders', () => {
    const nvm = join(dir, 'nvm', 'bin');
    const local = join(dir, 'local', 'bin');
    tool(nvm, 'node');
    tool(nvm, 'claude');
    tool(local, 'jq');
    tool(local, 'git');
    writeFileSync(join(local, 'codex'), ''); // not executable: doesn't count
    const result = capturePath(`${join(dir, 'missing')}:${nvm}:${local}:${nvm}`);
    expect(result.found).toEqual({ node: join(nvm, 'node'), claude: join(nvm, 'claude'), codex: null, jq: join(local, 'jq'), git: join(local, 'git'), tailscale: null });
    expect(result.missing).toEqual(['codex', 'tailscale']);
    expect(result.path.split(':')).toEqual([nvm, local, join(dir, 'missing'), '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']);
  });

  it('keeps every absolute PATH entry once and drops relative ones', () => {
    const tools = join(dir, 'tools');
    tool(tools, 'claude');
    const result = capturePath(`/nonexistent/a:relative/bin:${tools}:/nonexistent/b:/nonexistent/a`);
    expect(result.path.split(':')).toEqual([tools, '/nonexistent/a', '/nonexistent/b', '/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin']);
  });
});

describe('buildUnit', () => {
  const input = {
    nodePath: '/home/u/.nvm/versions/node/v22.12.0/bin/node',
    cliPath: '/home/u/.nvm/versions/node/v22.12.0/lib/node_modules/ai-agent-session-center/bin/cli.js',
    pathEnv: '/home/u/.nvm/versions/node/v22.12.0/bin:/usr/bin:/bin',
    dataDir: '/home/u/.config/ai-agent-session-center',
  };

  it('is the §7.4 unit: absolute node and cli, captured PATH, the data folder, restart rules', () => {
    const text = buildUnit(input);
    expect(text).toContain('[Unit]\nDescription=AI Agent Session Center (headless)\n');
    expect(text).toContain(`ExecStart="${input.nodePath}" "${input.cliPath}" serve\n`);
    expect(text).toContain(`Environment="PATH=${input.pathEnv}"\n`);
    expect(text).toContain(`Environment="APP_USER_DATA=${input.dataDir}"\n`);
    expect(text).toContain('Type=simple\n');
    expect(text).toContain('WorkingDirectory=%h\n');
    expect(text).toContain('Restart=on-failure\n');
    // 78 = EX_CONFIG (no password, unsafe queue folder), 3 = lock held, 4 = port busy. 1 and a crash restart.
    expect(text).toContain('RestartPreventExitStatus=78 3 4\n');
    expect(text).toContain('RestartSec=3\n');
    expect(text).toContain('TimeoutStopSec=20\n');
    expect(text).toContain('[Install]\nWantedBy=default.target\n');
  });

  it('escapes what systemd would expand or split, and refuses a newline', () => {
    const text = buildUnit({ ...input, cliPath: '/opt/my apps/100%/a"b\\c/$X/cli.js', dataDir: '/d/50%' });
    expect(text).toContain('"/opt/my apps/100%%/a\\"b\\\\c/$$X/cli.js" serve');
    expect(text).toContain('Environment="APP_USER_DATA=/d/50%%"');
    expect(() => buildUnit({ ...input, dataDir: '/d\nExecStartPre=/bin/evil' })).toThrow();
    expect(() => buildUnit({ ...input, nodePath: 'node' })).toThrow(/absolute/);
  });
});

describe('writeUnitAtomic', () => {
  it('writes a temporary file, then renames it over the unit', () => {
    const calls: string[] = [];
    const path = join(dir, 'systemd', 'user', 'aasc-server.service');
    writeUnitAtomic(path, 'x', {
      mkdirSync: (p, o) => { calls.push(`mkdir ${p} ${JSON.stringify(o)}`); return undefined; },
      writeFileSync: (p, data, o) => { calls.push(`write ${p} ${String(data)} ${JSON.stringify(o)}`); },
      renameSync: (a, b) => { calls.push(`rename ${a} ${b}`); },
    });
    expect(calls).toEqual([
      `mkdir ${join(dir, 'systemd', 'user')} {"recursive":true}`,
      `write ${path}.tmp x {"mode":420}`,
      `rename ${path}.tmp ${path}`,
    ]);
  });

  it('leaves only the unit behind on a real disk', () => {
    const path = join(dir, 'u', 'aasc-server.service');
    writeUnitAtomic(path, 'one');
    writeUnitAtomic(path, 'two');
    expect(readFileSync(path, 'utf8')).toBe('two');
    expect(readdirSync(join(dir, 'u'))).toEqual(['aasc-server.service']);
  });
});

describe('installService / uninstallService', () => {
  interface Harness { deps: ServiceDeps; calls: Array<[string, string[]]>; out: string[] }
  const headlessLock = { pid: 777, port: 43210, edition: 'headless' as const, startedAt: 1, dataDir: '/d', listening: true };
  function harness(over: Partial<ServiceDeps> & { fail?: string[]; healthy?: boolean } = {}): Harness {
    const calls: Array<[string, string[]]> = [];
    const out: string[] = [];
    const bin = join(dir, 'bin');
    tool(bin, 'node');
    tool(bin, 'claude');
    const deps: ServiceDeps = {
      platform: 'linux',
      home: join(dir, 'home'),
      env: { PATH: bin },
      user: 'kason',
      nodePath: join(bin, 'node'),
      cliPath: join(dir, 'pkg', 'bin', 'cli.js'),
      dataDir: join(dir, 'home', '.config', 'ai-agent-session-center'),
      port: 43210,
      run: async (cmd, args) => {
        calls.push([cmd, args]);
        const key = `${cmd} ${args.join(' ')}`;
        if (over.fail?.some((f) => key.startsWith(f))) return { code: 1, stdout: '', stderr: 'Access denied' };
        if (key.startsWith('systemctl --user is-active')) return (over.healthy ?? true) ? { code: 0, stdout: 'active\n', stderr: '' } : { code: 3, stdout: 'activating\n', stderr: '' };
        return { code: 0, stdout: key.startsWith('journalctl') ? 'line 1\nline 2\n' : '', stderr: '' };
      },
      readServerLock: () => headlessLock,
      pidAlive: (pid) => pid === 777,
      sleep: async () => {},
      out: (line) => out.push(line),
      healthTimeoutMs: 15_000,
      ...over,
    };
    return { deps, calls, out };
  }

  it('writes the unit, reloads, enables, restarts (an upgrade), lingers and reports the logs command', async () => {
    const h = harness();
    expect(await installService(h.deps)).toBe(0);
    const unit = readFileSync(join(dir, 'home', '.config', 'systemd', 'user', 'aasc-server.service'), 'utf8');
    expect(unit).toContain(`ExecStart="${h.deps.nodePath}" "${h.deps.cliPath}" serve`);
    expect(h.calls).toEqual([
      ['systemctl', ['--user', 'daemon-reload']],
      ['systemctl', ['--user', 'enable', '--now', 'aasc-server']],
      ['systemctl', ['--user', 'restart', 'aasc-server']],
      ['loginctl', ['enable-linger', 'kason']],
      ['systemctl', ['--user', 'is-active', '--quiet', 'aasc-server']],
    ]);
    expect(h.out.join('\n')).toMatch(/Running\. Logs: journalctl --user -u aasc-server -f/);
    // A missing codex/jq/git/tailscale is named; claude was found, so no "no session can start".
    expect(h.out.join('\n')).toMatch(/not on PATH: codex, jq, git, tailscale/);
    expect(h.out.join('\n')).not.toMatch(/no session can start/);
  });

  it('never runs a command through a shell', async () => {
    const h = harness({ healthy: false });
    await installService(h.deps);
    await uninstallService(h.deps);
    for (const [cmd, args] of h.calls) {
      expect(['systemctl', 'loginctl', 'journalctl']).toContain(cmd);
      expect(Array.isArray(args)).toBe(true);
      expect(args).not.toContain('-c');
    }
  });

  it('prints the sudo line when linger is refused, and carries on', async () => {
    const h = harness({ fail: ['loginctl'] });
    expect(await installService(h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/sudo loginctl enable-linger kason/);
  });

  it('warns loudly when claude is not on PATH', async () => {
    const h = harness();
    h.deps.env = { PATH: join(dir, 'nothing') };
    expect(await installService(h.deps)).toBe(0);
    expect(h.out.join('\n')).toMatch(/claude.*no session can start/);
  });

  it('is not fooled by another server on the port: it needs the unit active and a live headless lock', async () => {
    const desktop = harness({ readServerLock: () => ({ ...headlessLock, edition: 'desktop' }) });
    expect(await installService(desktop.deps)).toBe(1);
    const dead = harness({ pidAlive: () => false });
    expect(await installService(dead.deps)).toBe(1);
    const starting = harness({ readServerLock: () => ({ ...headlessLock, listening: undefined }) });
    expect(await installService(starting.deps)).toBe(1);
    const none = harness({ readServerLock: () => null });
    expect(await installService(none.deps)).toBe(1);
  });

  it('prints the last 20 journal lines and exits 1 when the server never answers', async () => {
    const h = harness({ healthy: false });
    expect(await installService(h.deps)).toBe(1);
    expect(h.calls).toContainEqual(['journalctl', ['--user', '-u', 'aasc-server', '-n', '20', '--no-pager']]);
    expect(h.out.join('\n')).toContain('line 2');
  });

  it('stops at the first systemctl failure', async () => {
    const h = harness({ fail: ['systemctl --user daemon-reload'] });
    expect(await installService(h.deps)).toBe(1);
    expect(h.calls).toEqual([['systemctl', ['--user', 'daemon-reload']]]);
  });

  it('is Linux-only', async () => {
    const h = harness({ platform: 'darwin' });
    expect(await installService(h.deps)).toBe(1);
    expect(await uninstallService(h.deps)).toBe(1);
    expect(h.calls).toEqual([]);
    expect(h.out.join('\n')).toMatch(/Linux/);
  });

  it('uninstall disables, removes the unit and reloads, leaving linger and the data folder', async () => {
    const h = harness();
    await installService(h.deps);
    mkdirSync(h.deps.dataDir, { recursive: true });
    h.calls.length = 0;
    expect(await uninstallService(h.deps)).toBe(0);
    expect(h.calls).toEqual([
      ['systemctl', ['--user', 'disable', '--now', 'aasc-server']],
      ['systemctl', ['--user', 'daemon-reload']],
    ]);
    expect(existsSync(join(dir, 'home', '.config', 'systemd', 'user', 'aasc-server.service'))).toBe(false);
    expect(existsSync(h.deps.dataDir)).toBe(true);
  });
});
