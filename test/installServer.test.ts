// test/installServer.test.ts — scripts/install-server.sh against fake tarballs (terminal-editions P4.2).
//
// Every run gets its own temporary HOME, so nothing reaches the real ~/.local. The tarballs are tiny
// stand-ins shaped like the bundled release: package/package.json, a bin that prints, and node_modules/.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, readlinkSync, existsSync, readdirSync, symlinkSync,
  lstatSync,
} from 'fs';
import { join, dirname } from 'path';
import { tmpdir } from 'os';
import { fileURLToPath } from 'url';
import { spawnSync, execFileSync } from 'child_process';
import { createHash } from 'crypto';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SCRIPT = join(ROOT, 'scripts', 'install-server.sh');
const NODE_MAJOR = Number(process.versions.node.split('.')[0]);
const NODE_MINOR = Number(process.versions.node.split('.')[1]);
const NAME = 'ai-agent-session-center';

let work: string;
let home: string;

interface FakeOptions {
  version?: string;
  engines?: string;
  name?: string;
  withNodeModules?: boolean;
  checksum?: 'beside' | 'none' | 'wrong';
}

function makeTarball(opts: FakeOptions = {}): string {
  const version = opts.version ?? '2.11.0';
  const src = mkdtempSync(join(work, 'src-'));
  const pkg = join(src, 'package');
  mkdirSync(join(pkg, 'bin'), { recursive: true });
  writeFileSync(join(pkg, 'package.json'), JSON.stringify({
    name: opts.name ?? NAME,
    version,
    engines: { node: opts.engines ?? `>=${NODE_MAJOR}.0.0 <${NODE_MAJOR + 1}` },
    bin: { 'aasc-server': 'bin/cli.js' },
  }));
  writeFileSync(join(pkg, 'bin', 'cli.js'), `#!/usr/bin/env node\nconsole.log('aasc-server ${version}');\n`);
  if (opts.withNodeModules !== false) {
    mkdirSync(join(pkg, 'node_modules'));
    writeFileSync(join(pkg, 'node_modules', '.keep'), '');
  }
  const tarball = join(work, `${NAME}-${version.replace(/\//g, '_')}-node${NODE_MAJOR}-linux-x64.tgz`);
  execFileSync('tar', ['-czf', tarball, '-C', src, 'package']);
  const sha = createHash('sha256').update(readFileSync(tarball)).digest('hex');
  const checksum = opts.checksum ?? 'beside';
  if (checksum !== 'none') {
    const written = checksum === 'wrong' ? 'f'.repeat(64) : sha;
    writeFileSync(`${tarball}.sha256`, `${written}  ${tarball.split('/').pop()}\n`);
  }
  return tarball;
}

function sha256Of(file: string): string {
  return createHash('sha256').update(readFileSync(file)).digest('hex');
}

function install(args: string[], env: Record<string, string> = {}) {
  return spawnSync('bash', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ...env },
  });
}

const installRoot = () => join(home, '.local', 'share', 'aasc-server');
const versionsInstalled = () =>
  existsSync(installRoot()) ? readdirSync(installRoot()).filter((e) => !e.startsWith('.') && e !== 'current') : [];

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'aasc-install-'));
  home = join(work, 'home');
  mkdirSync(home);
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

describe('install-server.sh', () => {
  it('installs a version, points current at it and links a command that runs', () => {
    const r = install([makeTarball()]);
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(join(installRoot(), 'current'))).toBe('2.11.0');
    const bin = join(home, '.local', 'bin', 'aasc-server');
    expect(lstatSync(bin).isSymbolicLink()).toBe(true);
    expect(execFileSync(bin, { encoding: 'utf8' }).trim()).toBe('aasc-server 2.11.0');
    expect(r.stdout).toContain('aasc-server setup');
    // The staging folder is gone.
    expect(readdirSync(installRoot()).filter((e) => e.startsWith('.'))).toEqual([]);
  });

  it('switches current on an upgrade and keeps the older version', () => {
    expect(install([makeTarball({ version: '2.11.0' })]).status).toBe(0);
    const r = install([makeTarball({ version: '2.12.0' })]);
    expect(r.status, r.stderr).toBe(0);
    expect(readlinkSync(join(installRoot(), 'current'))).toBe('2.12.0');
    expect(versionsInstalled().sort()).toEqual(['2.11.0', '2.12.0']);
    expect(execFileSync(join(home, '.local', 'bin', 'aasc-server'), { encoding: 'utf8' }).trim())
      .toBe('aasc-server 2.12.0');
  });

  it('reinstalls the same version in place', () => {
    const tarball = makeTarball();
    expect(install([tarball]).status).toBe(0);
    const r = install([tarball]);
    expect(r.status, r.stderr).toBe(0);
    expect(versionsInstalled()).toEqual(['2.11.0']);
  });

  it('refuses a checksum mismatch and installs nothing', () => {
    const r = install([makeTarball({ checksum: 'wrong' })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('SHA-256 mismatch');
    expect(versionsInstalled()).toEqual([]);
    expect(existsSync(join(home, '.local', 'bin', 'aasc-server'))).toBe(false);
  });

  it('refuses a tarball with no checksum beside it', () => {
    const r = install([makeTarball({ checksum: 'none' })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no checksum');
    expect(versionsInstalled()).toEqual([]);
  });

  it('takes the checksum from --sha256, and refuses a wrong one', () => {
    const tarball = makeTarball({ checksum: 'none' });
    const bad = install([tarball, '--sha256', '0'.repeat(64)]);
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('SHA-256 mismatch');
    const good = install([tarball, '--sha256', sha256Of(tarball).toUpperCase()]);
    expect(good.status, good.stderr).toBe(0);
    expect(versionsInstalled()).toEqual(['2.11.0']);
  });

  it('refuses a tarball built for another Node major', () => {
    const r = install([makeTarball({ engines: `>=${NODE_MAJOR + 1}.0.0 <${NODE_MAJOR + 2}` })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(`need Node ${NODE_MAJOR + 1}`);
    expect(versionsInstalled()).toEqual([]);
  });

  it('refuses a node older than the minimum of the same major', () => {
    const r = install([makeTarball({ engines: `>=${NODE_MAJOR}.${NODE_MINOR + 1}.0 <${NODE_MAJOR + 1}` })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is older than');
    expect(versionsInstalled()).toEqual([]);
  });

  it('refuses when jq is not on PATH', () => {
    // A PATH holding every system tool except jq, plus this node.
    const tools = join(work, 'tools');
    mkdirSync(tools);
    for (const dir of ['/usr/bin', '/bin', '/usr/sbin', '/sbin']) {
      if (!existsSync(dir)) continue;
      for (const entry of readdirSync(dir)) {
        if (entry === 'jq' || existsSync(join(tools, entry))) continue;
        symlinkSync(join(dir, entry), join(tools, entry));
      }
    }
    if (!existsSync(join(tools, 'node'))) symlinkSync(process.execPath, join(tools, 'node'));
    const r = install([makeTarball()], { PATH: tools });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('jq is not on PATH');
    expect(versionsInstalled()).toEqual([]);
  });

  it('refuses a version that would climb out of the install folder', () => {
    const r = install([makeTarball({ version: '../evil' })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('unexpected version');
    expect(existsSync(join(home, '.local', 'share', 'evil'))).toBe(false);
  });

  it('points the npm tarball, which has no node_modules, at npm', () => {
    const r = install([makeTarball({ withNodeModules: false })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('npm install -g');
    expect(versionsInstalled()).toEqual([]);
  });

  it('refuses another package', () => {
    const r = install([makeTarball({ name: 'something-else' })]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not a server tarball');
  });

  it('will not replace a file at ~/.local/bin/aasc-server that it did not link', () => {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    writeFileSync(join(home, '.local', 'bin', 'aasc-server'), 'mine');
    const r = install([makeTarball()]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('is not this installer');
    expect(readFileSync(join(home, '.local', 'bin', 'aasc-server'), 'utf8')).toBe('mine');
    expect(versionsInstalled()).toEqual([]);
  });

  it('prints usage and exits 2 with no tarball', () => {
    const r = install([]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('Usage: install-server.sh');
  });

  const hasShellcheck = spawnSync('shellcheck', ['--version']).status === 0;
  it.skipIf(!hasShellcheck)('passes shellcheck', () => {
    const r = spawnSync('shellcheck', [SCRIPT], { encoding: 'utf8' });
    expect(r.status, r.stdout).toBe(0);
  });
});
