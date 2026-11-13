// test/adminStatusDoctor.test.ts — `aasc-server status`, `doctor` and `logs` (terminal-editions §8.1, §8.4, §8.5).
//
// Every system command goes through an injected `run` that records it and answers from a table:
// no systemctl, loginctl, journalctl, jq or tailscale is ever started. Folders are temporary.
import { describe, it, expect, afterAll } from 'vitest';
import { mkdirSync, writeFileSync, chmodSync } from 'fs';
import { join } from 'path';
import { runStatus } from '../cli/server/status.js';
import { runChecks, runDoctor, cloudCredential, hookState, CLOUD_RECONNECT, type DoctorDeps } from '../cli/server/doctor.js';
import { runLogs, journalArgs } from '../cli/server/logs.js';
import { EXIT, type AdminClient } from '../cli/server/http.js';
import { scratch, cleanScratch } from './helpers/headlessBundle.js';

afterAll(() => cleanScratch());

const NOW = 1_800_000_000_000;
const SECRET_REF = '0b3d8f8e-1c2a-4f57-9a55-0d3c7c1e2a10';

function dataFolder(config: Record<string, unknown> = { passwordHash: 'salt:hash', enabledClis: ['claude', 'codex'] }): string {
  const dir = join(scratch('data'), 'aasc');
  mkdirSync(dir, { mode: 0o700 });
  writeFileSync(join(dir, 'server-config.json'), JSON.stringify(config));
  return dir;
}

/** The desktop's encrypted cloud sign-in (base64 of safeStorage bytes), or headless's plaintext one. */
function cloudSignIn(dir: string, kind: 'encrypted' | 'plain'): void {
  mkdirSync(join(dir, 'cloud', 'secrets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(dir, 'cloud', 'connection.json'), JSON.stringify({ version: 1, generation: 1, connection: { generation: 1 }, secretRef: SECRET_REF }));
  writeFileSync(join(dir, 'cloud', 'secrets', SECRET_REF), kind === 'encrypted'
    ? Buffer.from('v11\u0000ÿ opaque ciphertext').toString('base64')
    : JSON.stringify({ version: 1, secretRef: SECRET_REF, token: 'x' }));
}

function installHooks(home: string, clis: string[]): void {
  if (clis.includes('claude')) {
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.claude', 'hooks', 'dashboard-hook.sh'), '');
    writeFileSync(join(home, '.claude', 'settings.json'), '{"hooks":{"Stop":[{"hooks":[{"command":"~/.claude/hooks/dashboard-hook.sh"}]}]}}');
  }
  if (clis.includes('codex')) {
    mkdirSync(join(home, '.codex', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.codex', 'hooks', 'dashboard-hook.sh'), '');
    writeFileSync(join(home, '.codex', 'config.toml'), 'command = "~/.codex/hooks/dashboard-hook.sh"');
  }
}

describe('cloudCredential', () => {
  it('tells a desktop-encrypted sign-in from one this server can read', () => {
    const none = dataFolder();
    expect(cloudCredential(none)).toBe('none');
    const enc = dataFolder();
    cloudSignIn(enc, 'encrypted');
    expect(cloudCredential(enc)).toBe('encrypted');
    const plain = dataFolder();
    cloudSignIn(plain, 'plain');
    expect(cloudCredential(plain)).toBe('readable');
  });
});

describe('hookState', () => {
  it('checks each enabled CLI\'s script and its registration', () => {
    const home = scratch('home');
    installHooks(home, ['claude']);
    expect(hookState(home, ['claude', 'codex'])).toEqual({ claude: true, codex: false });
  });
});

function fakeClient(over: Record<string, unknown> = {}): { client: AdminClient; paths: string[] } {
  const paths: string[] = [];
  const answers: Record<string, unknown> = {
    '/api/auth/status': { passwordRequired: true, authenticated: false },
    '/api/sessions': {
      a: { status: 'working', remoteVisible: true },
      b: { status: 'approval' },
      c: { status: 'idle', remoteVisible: true },
      d: { status: 'ended', remoteVisible: true },
    },
    '/api/mobile/devices': { data: { devices: [
      { platform: 'desktop', status: 'active', online: true },
      { platform: 'ios', status: 'active', online: false },
      { platform: 'desktop', status: 'pending' },
    ] } },
    '/api/mobile/pairing/addresses': { data: { lan: null, tailnet: '100.64.0.5', public: '203.0.113.9' } },
    '/api/presence': { data: { devices: [{ clientId: 'mac', label: 'Kason\u001b[2J MacBook' }], workspaceWriter: 'mac' } },
    ...over,
  };
  return {
    paths,
    client: { async request(_method, path) { paths.push(path); return { status: 200, body: answers[path] ?? {} }; } },
  };
}

describe('aasc-server status', () => {
  const lock = { pid: 4121, port: 3333, edition: 'headless' as const, startedAt: NOW - (3 * 60 + 12) * 60_000, dataDir: '', listening: true };

  it('prints the plan\'s summary lines', async () => {
    const dir = dataFolder();
    const home = scratch('home');
    installHooks(home, ['claude', 'codex']);
    const lines: string[] = [];
    const code = await runStatus({ client: fakeClient().client, dataDir: dir, port: 3333, version: '2.10.64', home, env: { AASC_REMOTE_LISTENER_PORT: '3334' }, lock, json: false, now: () => NOW, out: (l) => lines.push(l) });
    const text = lines.join('\n');
    expect(code).toBe(EXIT.OK);
    expect(text).toMatch(/^AASC 2\.10\.64 · headless · pid 4121 · up 3 h 12 min/);
    expect(text).toMatch(/Listening\s+\*:3333 · remote-only 127\.0\.0\.1:3334/);
    expect(text).toMatch(/Reachable\s+Tailscale 100\.64\.0\.5 · public IP 203\.0\.113\.9 \(plain HTTP\)/);
    expect(text).toMatch(/Password\s+set · remote devices allowed/);
    expect(text).toMatch(/Sessions\s+3 · 1 working · 1 needs approval · 1 idle · 2 shared/);
    expect(text).toMatch(/Devices\s+2 paired · 1 computer, 1 phone · 1 online · 1 waiting for Allow/);
    expect(text).toMatch(/Hooks\s+claude ✓ · codex ✓/);
    // A device label is attacker-controlled text: no escape sequence reaches the terminal.
    expect(text).toMatch(/Automation runs in Kason\[2J MacBook/);
    expect(text).not.toContain('\u001b');
  });

  it('says automation is paused with no dashboard connected', async () => {
    const lines: string[] = [];
    await runStatus({ client: fakeClient({ '/api/presence': { data: { devices: [], workspaceWriter: null } } }).client, dataDir: dataFolder(), port: 3333, version: 'x', home: scratch('home'), env: {}, lock, json: false, now: () => NOW, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toMatch(/Automation\s+paused: no dashboard is connected/);
    expect(lines.join('\n')).toMatch(/run only in a connected dashboard/);
  });

  it('asks to reconnect AASC Cloud when the desktop encrypted its sign-in', async () => {
    const dir = dataFolder();
    cloudSignIn(dir, 'encrypted');
    const lines: string[] = [];
    await runStatus({ client: fakeClient().client, dataDir: dir, port: 3333, version: 'x', home: scratch('home'), env: {}, lock, json: false, now: () => NOW, out: (l) => lines.push(l) });
    expect(lines.join('\n')).toContain(`Cloud      ${CLOUD_RECONNECT}`);
  });

  it('exits 2 when the server is not running, and still reports the files', async () => {
    const lines: string[] = [];
    const code = await runStatus({ client: null, dataDir: dataFolder(), port: 3333, version: '2.10.64', home: scratch('home'), env: {}, lock: null, json: false, now: () => NOW, out: (l) => lines.push(l) });
    expect(code).toBe(EXIT.NOT_RUNNING);
    expect(lines[0]).toBe('AASC 2.10.64 · not running');
    expect(lines.join('\n')).toMatch(/Password\s+set/);
  });

  it('prints JSON with --json', async () => {
    const lines: string[] = [];
    await runStatus({ client: fakeClient().client, dataDir: dataFolder(), port: 3333, version: '2.10.64', home: scratch('home'), env: {}, lock, json: true, now: () => NOW, out: (l) => lines.push(l) });
    expect(JSON.parse(lines.join('\n'))).toMatchObject({ version: '2.10.64', running: true, edition: 'headless', pid: 4121, sessions: { live: 3, shared: 2 }, automation: { writer: 'Kason[2J MacBook' } });
  });
});

describe('aasc-server status: Login', () => {
  const lock = { pid: 1, port: 3333, edition: 'headless' as const, startedAt: NOW, dataDir: '', listening: true };

  it('prints each enabled CLI\'s sign-in, as the server reads it', async () => {
    const lines: string[] = [];
    const report = { host: 'mbp', clis: [
      { cli: 'claude', state: 'logged-out', method: null, detail: null, checkedAt: 1 },
      { cli: 'codex', state: 'logged-in', method: 'ChatGPT', detail: null, checkedAt: 1 },
    ] };
    const { client, paths } = fakeClient({ '/api/cli-auth': { success: true, data: report } });
    await runStatus({ client, dataDir: dataFolder(), port: 3333, version: 'x', home: scratch('home'), env: {}, lock, json: false, now: () => NOW, out: (l) => lines.push(l) });
    expect(paths).toContain('/api/cli-auth');
    expect(lines.join('\n')).toMatch(/Login\s+claude ✗ not logged in · codex ✓ ChatGPT/);
  });

  it('leaves the row out when the server has no such route (an older server)', async () => {
    const lines: string[] = [];
    const client: AdminClient = { async request(_m, path) { return path === '/api/cli-auth' ? { status: 404, body: {} } : { status: 200, body: {} }; } };
    await runStatus({ client, dataDir: dataFolder(), port: 3333, version: 'x', home: scratch('home'), env: {}, lock, json: false, now: () => NOW, out: (l) => lines.push(l) });
    expect(lines.join('\n')).not.toMatch(/^Login/m);
  });
});

describe('aasc-server doctor', () => {
  function deps(over: Partial<DoctorDeps> = {}) {
    const dir = dataFolder({ passwordHash: 'salt:hash', enabledClis: ['claude'] });
    writeFileSync(join(dir, 'owner.token'), `${'a'.repeat(64)}\n`, { mode: 0o600 });
    const home = scratch('home');
    installHooks(home, ['claude']);
    const bin = scratch('bin');
    writeFileSync(join(bin, 'claude'), '');
    const calls: string[][] = [];
    const lines: string[] = [];
    const d: DoctorDeps = {
      dataDir: dir,
      packageRoot: '/opt/aasc server',
      home,
      platform: 'linux',
      env: { PATH: bin, XDG_CONFIG_HOME: join(home, '.config') },
      user: 'kason',
      uid: process.getuid?.() ?? null,
      nodeVersion: 'v22.12.0',
      port: 3333,
      async run(command, args) {
        calls.push([command, ...args]);
        if (command === 'jq') return { code: 0, stdout: 'jq-1.7\n', stderr: '' };
        if (command === 'loginctl') return { code: 0, stdout: 'Linger=yes\n', stderr: '' };
        if (command === 'tailscale') return { code: 0, stdout: '100.64.0.5\n', stderr: '' };
        return { code: 1, stdout: '', stderr: 'unexpected' };
      },
      load: () => function FakeDatabase() { return { close() {} }; },
      spawnHelperPath: () => null,
      readServerLock: () => null,
      lockLive: async () => false,
      portAnswers: async () => false,
      out: (l) => lines.push(l),
      ...over,
    };
    return { d, calls, lines };
  }

  it('passes on a healthy box and runs only the probes it names', async () => {
    const { d, calls, lines } = deps();
    expect(await runDoctor(d)).toBe(EXIT.OK);
    expect(calls).toEqual([['jq', '--version'], ['loginctl', 'show-user', 'kason', '--property=Linger'], ['tailscale', 'ip', '-4']]);
    expect(lines.join('\n')).toMatch(/run only in a connected dashboard/);
  });

  it('fails with the fix for each missing piece', async () => {
    const { d } = deps({
      nodeVersion: 'v20.11.1',
      env: { PATH: '/nonexistent' },
      async run(command) { return command === 'loginctl' ? { code: 0, stdout: 'Linger=no\n', stderr: '' } : { code: 1, stdout: '', stderr: '' }; },
      load: () => { throw new Error('was compiled against a different Node.js version'); },
    });
    chmodSync(d.dataDir, 0o755);
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results.Node).toMatchObject({ state: 'fail', fix: expect.stringMatching(/Node 22/) });
    expect(results.jq).toMatchObject({ state: 'fail', fix: 'sudo apt install jq' });
    expect(results.claude).toMatchObject({ state: 'fail' });
    expect(results['better-sqlite3']).toMatchObject({ state: 'fail', fix: 'cd "/opt/aasc server" && npm rebuild better-sqlite3' });
    expect(results['node-pty']).toMatchObject({ state: 'fail', fix: 'cd "/opt/aasc server" && npm rebuild node-pty' });
    expect(results['Data folder']).toMatchObject({ state: 'fail', fix: `chmod 700 ${d.dataDir}` });
    expect(results.Linger).toMatchObject({ state: 'warn', fix: 'sudo loginctl enable-linger kason' });
    expect(results.Tailscale).toMatchObject({ state: 'warn' });
    expect(await runDoctor(d)).toBe(EXIT.FAILED);
  });

  it('reads the tools from the service\'s PATH once the unit is installed', async () => {
    const { d } = deps();
    const unitDir = join(d.home, '.config', 'systemd', 'user');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(join(unitDir, 'aasc-server.service'), '[Service]\nEnvironment="PATH=/only/here"\n');
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results.claude).toMatchObject({ state: 'fail', detail: expect.stringMatching(/service's PATH/) });
  });

  it('flags a readable owner.token and a port someone else holds', async () => {
    const { d } = deps({ portAnswers: async () => true });
    chmodSync(join(d.dataDir, 'owner.token'), 0o644);
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results['owner.token']).toMatchObject({ state: 'fail', fix: expect.stringMatching(/chmod 600/) });
    expect(results.Port).toMatchObject({ state: 'fail' });
  });

  it('accepts the port when this server holds it', async () => {
    const { d } = deps({ readServerLock: () => ({ pid: 7, port: 3333, edition: 'headless', startedAt: 1, dataDir: '' }), lockLive: async () => true, portAnswers: async () => true });
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results.Port).toMatchObject({ state: 'ok', detail: expect.stringMatching(/held by this server/) });
  });

  it('asks to reconnect AASC Cloud', async () => {
    const { d } = deps();
    cloudSignIn(d.dataDir, 'encrypted');
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results['AASC Cloud']).toMatchObject({ state: 'warn', detail: CLOUD_RECONNECT });
  });

  it('skips the linger check off Linux', async () => {
    const { d, calls } = deps({ platform: 'darwin' });
    await runChecks(d);
    expect(calls.some((c) => c[0] === 'loginctl')).toBe(false);
  });
});

describe('aasc-server doctor: Login', () => {
  const base = (): DoctorDeps => ({
    dataDir: dataFolder({ passwordHash: 'salt:hash', enabledClis: ['claude', 'codex'] }),
    packageRoot: '/opt/aasc', home: scratch('home'), platform: 'darwin', env: { PATH: '/nonexistent' }, user: 'k', uid: null,
    nodeVersion: 'v22.12.0', port: 3333,
    async run() { return { code: 1, stdout: '', stderr: '' }; },
    load: () => function FakeDatabase() { return { close() {} }; },
    spawnHelperPath: () => null, readServerLock: () => null, lockLive: async () => false, portAnswers: async () => false, out: () => {},
  });

  it('fails a logged-out CLI with how to log in, and passes a logged-in one', async () => {
    const d = { ...base(), cliAuth: async () => ({ host: 'mbp', clis: [
      { cli: 'claude' as const, state: 'logged-out' as const, method: null, detail: null, checkedAt: 1 },
      { cli: 'codex' as const, state: 'logged-in' as const, method: 'ChatGPT', detail: null, checkedAt: 1 },
    ] }) };
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results['claude login']).toMatchObject({ state: 'fail', detail: 'not logged in: its sessions will fail until it is' });
    expect(results['claude login'].fix).toContain('`claude auth login`');
    expect(results['claude login'].fix).not.toContain('codex');
    expect(results['claude login'].fix).toMatch(/Log in/);
    expect(results['codex login']).toMatchObject({ state: 'ok', detail: 'logged in (ChatGPT)' });
  });

  it('warns on an unclear answer instead of calling it logged out', async () => {
    const d = { ...base(), cliAuth: async () => ({ host: 'h', clis: [
      { cli: 'codex' as const, state: 'unknown' as const, method: null, detail: 'config.toml:9:1: duplicate key', checkedAt: 1 },
    ] }) };
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results['codex login']).toMatchObject({ state: 'warn', detail: 'couldn\'t tell: config.toml:9:1: duplicate key' });
  });

  it('says to start the server when it cannot ask it', async () => {
    const d = { ...base(), cliAuth: async () => null };
    const results = Object.fromEntries((await runChecks(d)).map((r) => [r.name, r]));
    expect(results.Login).toMatchObject({ state: 'warn' });
  });
});

describe('aasc-server logs', () => {
  const never = new AbortController().signal;

  it('follows the journal when the service is installed', async () => {
    const spawned: string[][] = [];
    const code = await runLogs({
      dataDir: '/unused', platform: 'linux', serviceInstalled: true, lines: 50, follow: true,
      spawnAttached: async (command, args) => { spawned.push([command, ...args]); return 0; },
      write: () => {}, sleep: async () => {}, cancelled: never,
    });
    expect(code).toBe(0);
    expect(spawned).toEqual([['journalctl', ...journalArgs(50, true)]]);
    expect(journalArgs(50, true)).toEqual(['--user', '-u', 'aasc-server', '-n', '50', '--no-pager', '-f']);
  });

  it('tails server.log otherwise, then prints what is appended', async () => {
    const dir = scratch('data');
    mkdirSync(join(dir, 'logs'));
    const file = join(dir, 'logs', 'server.log');
    writeFileSync(file, 'one\ntwo\nthree\n');
    const written: string[] = [];
    const ctl = new AbortController();
    let polls = 0;
    await runLogs({
      dataDir: dir, platform: 'linux', serviceInstalled: false, lines: 2, follow: true,
      spawnAttached: async () => { throw new Error('no journal here'); },
      write: (t) => written.push(t),
      sleep: async () => { if (++polls === 1) writeFileSync(file, 'one\ntwo\nthree\nfour\n'); else ctl.abort(); },
      cancelled: ctl.signal,
    });
    expect(written.join('')).toBe('two\nthree\nfour\n');
  });

  it('exits 1 when there is no log yet', async () => {
    const written: string[] = [];
    expect(await runLogs({ dataDir: scratch('data'), platform: 'darwin', serviceInstalled: false, lines: 5, follow: false, spawnAttached: async () => 0, write: (t) => written.push(t), sleep: async () => {}, cancelled: never })).toBe(EXIT.FAILED);
    expect(written.join('')).toMatch(/No log yet/);
  });
});
