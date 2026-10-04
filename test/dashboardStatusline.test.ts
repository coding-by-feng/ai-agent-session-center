// test/dashboardStatusline.test.ts — hooks/dashboard-statusline.sh
//
// Claude Code runs this as the session's status-line command: the status JSON arrives on
// stdin and whatever the command prints is the footer text. The script has two jobs and
// both must stay invisible to the user:
//   1. record the plan rate limits for the dashboard (background, never delays the footer);
//   2. chain to the user's OWN status line, so the bar they configured is unchanged.
//
// The script is exercised for real (bash + jq) against throwaway HOME / config / queue
// directories. Everything it writes happens in a background subshell, so "it wrote nothing"
// assertions wait a beat before concluding.
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { spawn, spawnSync } from 'child_process';
import {
  accessSync, chmodSync, constants, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync,
  statSync, symlinkSync, writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { applyStatusLineTap } from '../server/config.js';
import { USAGE_DIR } from '../server/planUsageSources.js';

const SCRIPT = fileURLToPath(new URL('../hooks/dashboard-statusline.sh', import.meta.url));
const hasJq = spawnSync('jq', ['--version']).status === 0;

const SID = '13ab37cc-aeac-4906-8f67-360aee1d1b87';
const LIMITS = {
  five_hour: { used_percentage: 23.5, resets_at: 1791514800 },
  seven_day: { used_percentage: 41.2, resets_at: 1791857600 },
};

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function waitFor(cond: () => boolean, timeoutMs = 5000): Promise<boolean> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    if (cond()) return true;
    await sleep(25);
  }
  return cond();
}

interface Sandbox {
  root: string;
  home: string;
  cfg: string;
  proj: string;
  queueDir: string;
  usageDir: string;
}

let sb: Sandbox;

beforeEach(() => {
  const root = mkdtempSync(join(tmpdir(), 'aasc-tap-'));
  sb = {
    root,
    home: join(root, 'home'),
    cfg: join(root, 'cfg'),
    proj: join(root, 'proj'),
    queueDir: join(root, 'queue'),
    usageDir: join(root, 'queue', 'usage'),
  };
  for (const dir of [sb.home, sb.cfg, sb.proj, sb.queueDir]) mkdirSync(dir, { recursive: true });
});

afterEach(() => {
  rmSync(sb.root, { recursive: true, force: true });
});

function tapEnv(extra: Record<string, string> = {}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: sb.home,
    AASC_USAGE_DIR: sb.usageDir,
    ...extra,
  };
}

function payload(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SID,
    cwd: sb.proj,
    workspace: { current_dir: sb.proj, project_dir: sb.proj },
    model: { id: 'claude-opus-5-5' },
    rate_limits: LIMITS,
    ...over,
  };
}

function runTap(input: unknown, extra: Record<string, string> = {}) {
  const text = typeof input === 'string' ? input : JSON.stringify(input);
  const t0 = performance.now();
  let result = spawnSync('/bin/bash', [SCRIPT], {
    input: text,
    encoding: 'utf8',
    env: tapEnv(extra),
    cwd: sb.root, // deliberately NOT the project: the script must use the payload's paths
    timeout: 15_000,
  });
  // A box that is out of processes (other agents are building) fails to SPAWN, which says
  // nothing about the script; try again before blaming it.
  for (let attempt = 0; attempt < 2 && result.error && (result.error as NodeJS.ErrnoException).code !== 'ETIMEDOUT'; attempt++) {
    result = spawnSync('/bin/bash', [SCRIPT], {
      input: text, encoding: 'utf8', env: tapEnv(extra), cwd: sb.root, timeout: 15_000,
    });
  }
  return { ...result, ms: performance.now() - t0 };
}

function writeSettings(dir: string, name: string, statusLine: unknown): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, name);
  writeFileSync(file, JSON.stringify({ statusLine }));
  return file;
}

const cmd = (command: string) => ({ type: 'command', command });
const snapshotPath = (id: string = SID) => join(sb.usageDir, `${id}.json`);

/**
 * Wait until the tap has demonstrably finished its background work: a second run into a
 * directory that IS ours lands its snapshot, so a write the first run was going to make has
 * had every chance to happen. Without it a "wrote nothing" assertion passes on a slow box
 * simply because the writer had not got there yet.
 */
async function waitUntilTapHasRun(): Promise<void> {
  const parent = join(sb.root, 'control');
  mkdirSync(parent);
  runTap(payload({ session_id: 'control' }), { AASC_USAGE_DIR: join(parent, 'usage') });
  expect(await waitFor(() => existsSync(join(parent, 'usage', 'control.json')))).toBe(true);
}

/** A world-writable directory that belongs to someone else (/var/tmp is root's, sticky, on macOS and Linux). */
const FOREIGN_DIR = '/var/tmp';
const foreignDirIsUsable = ((): boolean => {
  try {
    accessSync(FOREIGN_DIR, constants.W_OK);
    return typeof process.getuid === 'function' && statSync(FOREIGN_DIR).uid !== process.getuid();
  } catch {
    return false;
  }
})();

describe.skipIf(!hasJq || process.platform === 'win32')('dashboard-statusline.sh', () => {
  describe('job 1 — the plan-limit snapshot', () => {
    it('writes exactly session_id, ts and rate_limits, as one line', async () => {
      const before = Date.now();
      const r = runTap(payload());
      expect(r.status).toBe(0);
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);

      const raw = readFileSync(snapshotPath(), 'utf8');
      expect(raw.trimEnd().split('\n')).toHaveLength(1);
      const snap = JSON.parse(raw);
      expect(Object.keys(snap).sort()).toEqual(['rate_limits', 'session_id', 'ts']);
      expect(snap.session_id).toBe(SID);
      expect(snap.rate_limits).toEqual(LIMITS);
      // epoch MILLISECONDS, taken while the script ran
      expect(snap.ts).toBeGreaterThanOrEqual(before - 1000);
      expect(snap.ts).toBeLessThanOrEqual(Date.now() + 1000);
    });

    it('keeps no other part of the payload (no cwd, transcript path or model)', async () => {
      runTap(payload({ transcript_path: '/Users/x/.claude/projects/p/s.jsonl', version: '2.1.288' }));
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
      const raw = readFileSync(snapshotPath(), 'utf8');
      expect(raw).not.toContain('transcript');
      expect(raw).not.toContain(sb.proj);
      expect(raw).not.toContain('claude-opus');
    });

    it('stores the rate_limits object as given, whatever else it carries', async () => {
      const limits = { ...LIMITS, spend_limit: { used_usd: 12.5 }, seven_day_opus: { used_percentage: 3, resets_at: 1 } };
      runTap(payload({ rate_limits: limits }));
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
      expect(JSON.parse(readFileSync(snapshotPath(), 'utf8')).rate_limits).toEqual(limits);
    });

    it('creates the usage directory private (0700)', async () => {
      runTap(payload());
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
      expect(statSync(sb.usageDir).mode & 0o777).toBe(0o700);
    });

    it('replaces an earlier snapshot atomically and leaves no temp file behind', async () => {
      runTap(payload());
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
      runTap(payload({ rate_limits: { five_hour: { used_percentage: 99, resets_at: 1791514800 } } }));
      expect(await waitFor(() => JSON.parse(readFileSync(snapshotPath(), 'utf8')).rate_limits.five_hour?.used_percentage === 99)).toBe(true);
      expect(readdirSync(sb.usageDir)).toEqual([`${SID}.json`]);
    });

    it.each([
      ['rate_limits is absent (the first turn has not been answered yet)', { rate_limits: undefined }],
      ['rate_limits is null', { rate_limits: null }],
      ['rate_limits is not an object', { rate_limits: 'high' }],
      ['session_id is missing', { session_id: undefined }],
      ['session_id is not a string', { session_id: 42 }],
      ['session_id is empty', { session_id: '' }],
    ])('writes nothing when %s', async (_why, over) => {
      const r = runTap(payload(over));
      expect(r.status).toBe(0);
      await sleep(500);
      expect(existsSync(sb.usageDir)).toBe(false);
    });

    it('writes nothing when the dashboard has no queue directory', async () => {
      const missing = join(sb.root, 'no-dashboard', 'usage');
      const r = runTap(payload(), { AASC_USAGE_DIR: missing });
      expect(r.status).toBe(0);
      await sleep(500);
      expect(existsSync(join(sb.root, 'no-dashboard'))).toBe(false);
    });

    it('keeps a hostile session id inside the usage directory', async () => {
      runTap(payload({ session_id: '../../evil' }));
      const landed = join(sb.usageDir, '______evil.json');
      expect(await waitFor(() => existsSync(landed))).toBe(true);
      expect(readdirSync(sb.usageDir)).toEqual(['______evil.json']);
      expect(existsSync(join(sb.root, 'evil.json'))).toBe(false);
      expect(existsSync(join(sb.queueDir, 'evil.json'))).toBe(false);
      // the raw id is still what the payload said; only the FILE NAME is sanitised
      expect(JSON.parse(readFileSync(landed, 'utf8')).session_id).toBe('../../evil');
    });

    it('limits the file name to safe characters and 64 of them', async () => {
      const raw = `a b/c${'x'.repeat(100)}`;
      const expected = `${raw.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 64)}.json`;
      runTap(payload({ session_id: raw }));
      expect(await waitFor(() => existsSync(join(sb.usageDir, expected)))).toBe(true);
      expect(expected).toMatch(/^[A-Za-z0-9_-]{1,64}\.json$/);
      expect(expected.startsWith('a_b_c')).toBe(true);
      expect(readdirSync(sb.usageDir)).toEqual([expected]);
    });

    it('prints nothing of its own', () => {
      const r = runTap(payload());
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
    });

    // /tmp is shared ground: anyone can pre-create the path. The server reads and sweeps this
    // directory only if it is a real directory that is ours (checkUsageDirectory in
    // server/planUsageSources.ts); the tap must hold the same line from the writing side.
    describe('writes only into a usage directory that is ours', () => {
      it('writes nothing through a symlink planted where the directory should be', async () => {
        const elsewhere = join(sb.root, 'elsewhere'); // somewhere the user could not want these files
        mkdirSync(elsewhere);
        symlinkSync(elsewhere, sb.usageDir);

        const r = runTap(payload());
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
        expect(r.stderr).toBe('');
        await waitUntilTapHasRun();
        expect(readdirSync(elsewhere)).toEqual([]);
      });

      it('writes nothing through a symlink that points at a directory that does not exist', async () => {
        symlinkSync(join(sb.root, 'nowhere'), sb.usageDir);
        const r = runTap(payload());
        expect(r.status).toBe(0);
        await waitUntilTapHasRun();
        expect(existsSync(join(sb.root, 'nowhere'))).toBe(false);
      });

      it('writes nothing when a plain file stands where the directory should be', async () => {
        writeFileSync(sb.usageDir, 'not a directory');
        const r = runTap(payload());
        expect(r.status).toBe(0);
        expect(r.stdout).toBe('');
        await waitUntilTapHasRun();
        expect(readFileSync(sb.usageDir, 'utf8')).toBe('not a directory');
      });

      it.skipIf(!foreignDirIsUsable)('writes nothing into a directory that belongs to another user', async () => {
        const id = `aasc-foreign-${process.pid}-${Date.now()}`;
        const landed = join(FOREIGN_DIR, `${id}.json`);
        try {
          const r = runTap(payload({ session_id: id }), { AASC_USAGE_DIR: FOREIGN_DIR });
          expect(r.status).toBe(0);
          expect(r.stdout).toBe('');
          await waitUntilTapHasRun();
          expect(existsSync(landed)).toBe(false);
        } finally {
          rmSync(landed, { force: true }); // only ever the one file this test could have made
        }
      });

      it('still writes into a real directory of its own that already exists', async () => {
        mkdirSync(sb.usageDir, { mode: 0o700 });
        runTap(payload());
        expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
      });
    });
  });

  describe('job 2 — chaining to the user\'s own status line', () => {
    it('prints nothing when no status line is configured anywhere', () => {
      const r = runTap(payload());
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('lets the user\'s status line through untouched (CLAUDE_CONFIG_DIR)', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('printf "USER-BAR"'));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg });
      expect(r.stdout).toBe('USER-BAR');
      expect(r.status).toBe(0);
    });

    it('falls back to $HOME/.claude/settings.json without CLAUDE_CONFIG_DIR', () => {
      writeSettings(join(sb.home, '.claude'), 'settings.json', cmd('printf "HOME-BAR"'));
      expect(runTap(payload()).stdout).toBe('HOME-BAR');
    });

    it('pipes the very same status JSON to the chained command', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('cat'));
      const input = JSON.stringify(payload());
      expect(runTap(input, { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe(input);
    });

    it('marks the chained command\'s environment with AASC_STATUSLINE_TAP=1', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('printf "%s" "$AASC_STATUSLINE_TAP"'));
      expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('1');
    });

    describe('precedence: local project > project > user', () => {
      beforeEach(() => {
        writeSettings(sb.cfg, 'settings.json', cmd('printf USER'));
        writeSettings(join(sb.proj, '.claude'), 'settings.json', cmd('printf PROJECT'));
        writeSettings(join(sb.proj, '.claude'), 'settings.local.json', cmd('printf LOCAL'));
      });

      it('takes the local project file first', () => {
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('LOCAL');
      });

      it('then the shared project file', () => {
        rmSync(join(sb.proj, '.claude', 'settings.local.json'));
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('PROJECT');
      });

      it('then the user file', () => {
        rmSync(join(sb.proj, '.claude'), { recursive: true });
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('USER');
      });

      it('skips a file that says nothing about a status line', () => {
        writeFileSync(join(sb.proj, '.claude', 'settings.local.json'), JSON.stringify({ permissions: {} }));
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('PROJECT');
      });

      it('skips a file whose status line is empty, not a string, or not an object', () => {
        writeSettings(join(sb.proj, '.claude'), 'settings.local.json', { type: 'command', command: '' });
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('PROJECT');
        writeSettings(join(sb.proj, '.claude'), 'settings.local.json', { type: 'command', command: 42 });
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('PROJECT');
        writeSettings(join(sb.proj, '.claude'), 'settings.local.json', 'printf NOPE');
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('PROJECT');
      });

      it('falls through a MALFORMED file that mentions statusLine instead of giving up', () => {
        writeFileSync(join(sb.proj, '.claude', 'settings.local.json'), '{ "statusLine": { oops');
        expect(runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('PROJECT');
      });
    });

    describe('which project the settings are read from', () => {
      beforeEach(() => {
        writeSettings(sb.cfg, 'settings.json', cmd('printf USER'));
      });

      it('prefers workspace.project_dir over workspace.current_dir', () => {
        const sub = join(sb.proj, 'packages', 'app');
        mkdirSync(sub, { recursive: true });
        writeSettings(join(sb.proj, '.claude'), 'settings.json', cmd('printf ROOT'));
        const p = payload({ workspace: { project_dir: sb.proj, current_dir: sub } });
        expect(runTap(p, { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('ROOT');
      });

      it('uses workspace.current_dir when there is no project_dir', () => {
        writeSettings(join(sb.proj, '.claude'), 'settings.json', cmd('printf CURRENT'));
        const p = payload({ workspace: { current_dir: sb.proj } });
        expect(runTap(p, { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('CURRENT');
      });

      it('falls back to the top-level cwd', () => {
        writeSettings(join(sb.proj, '.claude'), 'settings.json', cmd('printf CWD'));
        const p = payload({ workspace: undefined });
        expect(runTap(p, { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('CWD');
      });

      it('reads only the user file when the payload names no directory', () => {
        writeSettings(join(sb.proj, '.claude'), 'settings.json', cmd('printf PROJECT'));
        const p = payload({ workspace: undefined, cwd: undefined });
        expect(runTap(p, { CLAUDE_CONFIG_DIR: sb.cfg }).stdout).toBe('USER');
      });
    });

    it('still exits 0 when the chained command fails, keeping what it printed', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('printf partial; exit 3'));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('partial');
    });

    it('still exits 0 when the chained command does not exist', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('/nonexistent/aasc-statusline-xyz'));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    it('tolerates a chained command that never reads its stdin', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('printf quick'));
      const r = runTap(payload({ padding: 'x'.repeat(200_000) }), { CLAUDE_CONFIG_DIR: sb.cfg });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('quick');
    });
  });

  describe('recursion guard — a status line that leads back to the tap must not fork-bomb', () => {
    it('does not chain when AASC_STATUSLINE_TAP is already set', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('printf SHOULD-NOT-RUN'));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg, AASC_STATUSLINE_TAP: '1' });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });

    // A command that names the tap is never run — not even its harmless first half. The marker
    // file is what tells "skipped" from "ran, and the inner tap then found AASC_STATUSLINE_TAP".
    it('does not chain to a command that names the tap itself', () => {
      const mark = join(sb.root, 'ran-1');
      writeSettings(sb.cfg, 'settings.json', cmd(`touch ${mark}; ${SCRIPT}`));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg });
      // one assertion, so a failure shows everything the run did
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr, chained: existsSync(mark) })
        .toEqual({ status: 0, stdout: '', stderr: '', chained: false });
    });

    it('does not chain to a wrapper whose command line mentions the tap', () => {
      const mark = join(sb.root, 'ran-2');
      writeSettings(sb.cfg, 'settings.json', cmd(`sh -c "touch ${mark}; exec /Users/me/.claude/hooks/dashboard-statusline.sh"`));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg });
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr, chained: existsSync(mark) })
        .toEqual({ status: 0, stdout: '', stderr: '', chained: false });
    });

    // The textual check cannot see through a wrapper that calls the tap under another name, so
    // here only the environment marker stands between the tap and a loop. The wrapper has a
    // safety stop of its own so that a regression fails this test instead of fork-bombing the
    // machine running it.
    it('terminates when a wrapper re-enters the tap under another name', () => {
      const tapCopy = join(sb.root, 'quiet-bar.sh');
      writeFileSync(tapCopy, readFileSync(SCRIPT));
      chmodSync(tapCopy, 0o755);
      const calls = join(sb.root, 'wrapper-calls.log');
      const wrapper = join(sb.root, 'wrapper-bar.sh');
      writeFileSync(
        wrapper,
        [
          '#!/bin/bash',
          'echo x >> "$WRAPPER_CALLS"',
          '[ "$(wc -l < "$WRAPPER_CALLS")" -ge 4 ] && exit 0   # safety stop',
          'exec "$TAP_COPY"',
          '',
        ].join('\n'),
      );
      chmodSync(wrapper, 0o755);
      writeSettings(sb.cfg, 'settings.json', cmd(wrapper));

      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg, WRAPPER_CALLS: calls, TAP_COPY: tapCopy });
      // The wrapper ran once (as the chained command); its re-entry into the tap stopped there.
      const wrapperRuns = existsSync(calls) ? readFileSync(calls, 'utf8').trim().split('\n').length : 0;
      expect({ status: r.status, stdout: r.stdout, stderr: r.stderr, wrapperRuns })
        .toEqual({ status: 0, stdout: '', stderr: '', wrapperRuns: 1 });
      expect(r.ms).toBeLessThan(5000);
    });
  });

  describe('robustness', () => {
    it('is quick on the ordinary path', () => {
      writeSettings(sb.cfg, 'settings.json', cmd('printf bar'));
      const r = runTap(payload(), { CLAUDE_CONFIG_DIR: sb.cfg });
      expect(r.stdout).toBe('bar'); // it really ran and chained
      expect(r.ms).toBeLessThan(2000);
    });

    it('does not wait for (or hold stdout open for) a slow background writer', async () => {
      const shim = join(sb.root, 'shim');
      mkdirSync(shim);
      writeFileSync(join(shim, 'mv'), '#!/bin/sh\nsleep 4\nexec /bin/mv "$@"\n');
      chmodSync(join(shim, 'mv'), 0o755);

      const child = spawn('/bin/bash', [SCRIPT], {
        env: tapEnv({ PATH: `${shim}:${process.env.PATH}` }),
        cwd: sb.root,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      const t0 = Date.now();
      // 'close' only fires once EVERY holder of stdout/stderr has let go — a writer that
      // inherited them would keep this from resolving until the shim's sleep ends.
      const closed = new Promise<number>((resolve) => child.on('close', () => resolve(Date.now() - t0)));
      child.stdin.end(JSON.stringify(payload()));

      expect(await closed).toBeLessThan(2500);

      // While the (stalled) rename has not happened, the snapshot must not be readable half
      // written: the content sits in a dot-file temp next to it, not under its final name.
      await sleep(600);
      expect(existsSync(snapshotPath())).toBe(false);
      expect(readdirSync(sb.usageDir).some((n) => n.startsWith('.') && n.endsWith('.tmp'))).toBe(true);

      // ...and the write still lands once the writer finishes, leaving no temp behind.
      expect(await waitFor(() => existsSync(snapshotPath()), 12_000)).toBe(true);
      expect(readdirSync(sb.usageDir)).toEqual([`${SID}.json`]);
    }, 20_000);

    it('prints nothing, writes nothing and does not complain when jq is not installed', async () => {
      const bin = join(sb.root, 'no-jq');
      mkdirSync(bin);
      symlinkSync('/bin/cat', join(bin, 'cat'));
      writeSettings(sb.cfg, 'settings.json', cmd('printf SHOULD-NOT-RUN'));
      const r = runTap(payload(), { PATH: bin, CLAUDE_CONFIG_DIR: sb.cfg });
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(r.stderr).toBe('');
      await sleep(400);
      expect(existsSync(sb.usageDir)).toBe(false);
    });

    it.each([
      ['an empty payload', ''],
      ['a payload that is not JSON', 'not json at all'],
      ['a payload that is a JSON scalar', '42'],
      ['a payload whose workspace is a string', JSON.stringify({ session_id: SID, workspace: 'nope', rate_limits: LIMITS })],
    ])('exits 0 and prints nothing for %s', (_why, input) => {
      const r = runTap(input);
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
    });
  });

  // The launch flag, the installed script and the real shell have to agree on quoting, on the
  // `~` in the script path, and on what the status line receives. A stand-in `claude` does
  // what Claude Code does with --settings — runs the status-line command through a shell with
  // the status JSON on stdin — so the whole chain runs without starting Claude.
  describe('end to end — the typed launch line, a stand-in claude, the installed tap', () => {
    function launch(): ReturnType<typeof spawnSync> {
      const hooks = join(sb.home, '.claude', 'hooks');
      mkdirSync(hooks, { recursive: true });
      const installed = join(hooks, 'dashboard-statusline.sh');
      writeFileSync(installed, readFileSync(SCRIPT));
      chmodSync(installed, 0o755);

      const bin = join(sb.root, 'bin');
      mkdirSync(bin);
      const standIn = join(bin, 'claude');
      writeFileSync(
        standIn,
        [
          '#!/bin/sh',
          'while [ $# -gt 0 ]; do case "$1" in --settings) S="$2"; shift 2;; *) shift;; esac; done',
          'CMD=$(printf \'%s\' "$S" | jq -r .statusLine.command)',
          'printf \'%s\' "$STATUS_JSON" | sh -c "$CMD"',
          '',
        ].join('\n'),
      );
      chmodSync(standIn, 0o755);

      const line = applyStatusLineTap('claude --model opus -n "My title"');
      return spawnSync('/bin/sh', ['-c', line], {
        encoding: 'utf8',
        env: {
          PATH: `${bin}:${process.env.PATH}`,
          HOME: sb.home,
          AASC_USAGE_DIR: sb.usageDir,
          STATUS_JSON: JSON.stringify(payload()),
        },
        timeout: 15_000,
      });
    }

    it('records the plan limits of a session launched the way the dashboard launches it', async () => {
      const r = launch();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('');
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
      expect(JSON.parse(readFileSync(snapshotPath(), 'utf8')).rate_limits).toEqual(LIMITS);
    });

    it('still shows the user\'s own status line in the footer', async () => {
      writeSettings(join(sb.home, '.claude'), 'settings.json', cmd('printf "MY-BAR"'));
      const r = launch();
      expect(r.status).toBe(0);
      expect(r.stdout).toBe('MY-BAR');
      expect(await waitFor(() => existsSync(snapshotPath()))).toBe(true);
    });
  });

  describe('contract with the server', () => {
    it('defaults to the very directory the server reads (server/planUsageSources USAGE_DIR)', () => {
      const m = readFileSync(SCRIPT, 'utf8').match(/AASC_USAGE_DIR:-([^}"]+)\}/);
      expect(m?.[1]).toBe(USAGE_DIR);
    });

    it('carries the project marker the uninstaller looks for before deleting it', () => {
      const text = readFileSync(SCRIPT, 'utf8');
      expect(text).toContain('claude-session-center');
      expect(text).toContain('AI Agent Session Center');
    });
  });
});
