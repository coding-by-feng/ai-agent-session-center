// test/statusLineTap.test.ts — the launch flag that points Claude's status line at the tap.
//
// The dashboard learns Claude's plan limits from the status-line command (see
// hooks/dashboard-statusline.sh), and the only place to install one for a single launch is
// `claude --settings '<json>'`. Three things must hold:
//   - EVERY local Claude launch carries it: the auto-launch path (createTerminal) and the
//     deferred one (resume / fork / clone / workspace restore / floating forks all type their
//     line through writeWhenReady), including `claude … || claude …` fallbacks;
//   - it is NEVER stored: it exists only in the string typed into the PTY, and the one way a
//     stored command could pick it up (the hook captures `ps` args, where the JSON is no
//     longer quoted) is cleaned on the way in;
//   - it never reaches a host that has no such script, or a command that is not Claude.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { execFileSync } from 'child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { basename, join } from 'path';
import { fileURLToPath } from 'url';
import {
  STATUS_LINE_TAP_COMMAND,
  STATUS_LINE_TAP_SETTINGS,
  appendSessionName,
  applyClaudeLaunchFlags,
  applyStatusLineTap,
  isStatusLineTapEnabled,
  isStatusLineTapInstalled,
  sanitizeModelInCommand,
  stripStatusLineTap,
} from '../server/config.js';

// A stand-in PTY: every byte typed into a terminal lands in `typed`. Hoisted because the
// vi.mock factory below runs before this file's own top-level statements.
const { typed } = vi.hoisted(() => ({ typed: [] as string[] }));

vi.mock('node-pty', () => ({
  default: {
    spawn: vi.fn(() => ({
      pid: 424242,
      onData: () => ({ dispose: () => {} }),
      onExit: () => ({ dispose: () => {} }),
      write: (data: string) => { typed.push(data); },
      kill: () => {},
      resize: () => {},
    })),
  },
}));

// sessionStore opens better-sqlite3 at module scope; stub the few functions it calls so the
// ingest test below runs under any Node ABI.
vi.mock('../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

const FLAG = ` --settings '${STATUS_LINE_TAP_SETTINGS}'`;
const tapped = (rest: string) => `claude${FLAG}${rest}`;

const realPlatform = process.platform;
function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}
afterEach(() => setPlatform(realPlatform));

describe('the tap constants', () => {
  it('names the script the installer ships, under ~/.claude/hooks', () => {
    expect(STATUS_LINE_TAP_COMMAND).toBe('~/.claude/hooks/dashboard-statusline.sh');
    const shipped = fileURLToPath(new URL(`../hooks/${basename(STATUS_LINE_TAP_COMMAND)}`, import.meta.url));
    expect(existsSync(shipped)).toBe(true);
  });

  it('is a status line of type "command" pointing at it', () => {
    expect(JSON.parse(STATUS_LINE_TAP_SETTINGS)).toEqual({
      statusLine: { type: 'command', command: STATUS_LINE_TAP_COMMAND },
    });
  });

  it('is safe inside single quotes: no single quote in it, and no whitespace to split on', () => {
    expect(STATUS_LINE_TAP_SETTINGS).not.toContain("'");
    expect(STATUS_LINE_TAP_SETTINGS).not.toMatch(/\s/);
  });
});

describe.skipIf(realPlatform === 'win32')('applyStatusLineTap', () => {
  it('puts the flag right after the leading claude token', () => {
    expect(applyStatusLineTap('claude')).toBe(`claude${FLAG}`);
    expect(applyStatusLineTap('claude --dangerously-skip-permissions'))
      .toBe(tapped(' --dangerously-skip-permissions'));
  });

  it('leaves everything else in the command intact', () => {
    expect(applyStatusLineTap('claude --model opus --effort high -n "My title"'))
      .toBe(tapped(' --model opus --effort high -n "My title"'));
  });

  it('composes with the other launch-flag builders without disturbing them', () => {
    const built = applyClaudeLaunchFlags(
      appendSessionName('claude --dangerously-skip-permissions', 'My title'),
      'opus',
      'high',
    );
    expect(built).toBe('claude --model opus --effort high --dangerously-skip-permissions -n "My title"');
    expect(applyStatusLineTap(built))
      .toBe(tapped(' --model opus --effort high --dangerously-skip-permissions -n "My title"'));
  });

  it('covers resume, fork and clone commands', () => {
    expect(applyStatusLineTap("claude --resume 'abc-123'")).toBe(tapped(" --resume 'abc-123'"));
    expect(applyStatusLineTap("claude --resume 'abc-123' --fork-session"))
      .toBe(tapped(" --resume 'abc-123' --fork-session"));
    expect(applyStatusLineTap('claude --continue --fork-session')).toBe(tapped(' --continue --fork-session'));
  });

  it('covers BOTH halves of a resume-with-fallback line', () => {
    const line = `claude --model opus -n "t" --resume 'id' || claude --model opus -n "t"`;
    expect(applyStatusLineTap(line))
      .toBe(`claude${FLAG} --model opus -n "t" --resume 'id' || claude${FLAG} --model opus -n "t"`);
  });

  it('covers a claude that follows cd / export prefixes and the typed carriage return', () => {
    expect(applyStatusLineTap("cd '/work/app' && claude --x\r")).toBe(`cd '/work/app' && claude${FLAG} --x\r`);
    expect(applyStatusLineTap("export A='b' && cd '/w' && claude\r")).toBe(`export A='b' && cd '/w' && claude${FLAG}\r`);
    expect(applyStatusLineTap('cd /w;claude --x')).toBe(`cd /w;claude${FLAG} --x`);
    expect(applyStatusLineTap('cd /w&&claude')).toBe(`cd /w&&claude${FLAG}`);
  });

  it('never reads a claude inside quotes as a command (a title is untrusted text)', () => {
    expect(applyStatusLineTap('claude -n "x || claude y"')).toBe(tapped(' -n "x || claude y"'));
    expect(applyStatusLineTap("claude -n 'a; claude b'")).toBe(tapped(" -n 'a; claude b'"));
    expect(applyStatusLineTap('claude -n "a \\" && claude \\" b"')).toBe(tapped(' -n "a \\" && claude \\" b"'));
    expect(applyStatusLineTap('echo "claude" \'claude\'')).toBe('echo "claude" \'claude\'');
  });

  it('leaves commands that are not a bare `claude` invocation alone', () => {
    for (const cmd of [
      '',
      'codex --dangerously-bypass-approvals-and-sandbox',
      "codex resume 'abc' || codex",
      'aider',
      'echo claude',
      'claude-code --x',
      'npx claude',
      '/usr/local/bin/claude --x', // not matched by applyClaudeLaunchFlags either: stay consistent
      'FOO=1 claude',
      'bash',
    ]) {
      expect(applyStatusLineTap(cmd)).toBe(cmd);
    }
  });

  it('leaves a command that already carries a --settings of the user\'s alone', () => {
    for (const cmd of [
      'claude --settings ./mine.json',
      'claude --settings=./mine.json --model opus',
      `claude --settings '{"model":"opus"}'`,
      'claude --model opus --settings /etc/claude.json',
    ]) {
      expect(applyStatusLineTap(cmd)).toBe(cmd);
    }
  });

  it('does not mistake the word --settings inside a title for the flag', () => {
    expect(applyStatusLineTap('claude -n "fix --settings bug"')).toBe(tapped(' -n "fix --settings bug"'));
  });

  it('decides per command: a user --settings on one half does not block the other', () => {
    expect(applyStatusLineTap('claude --settings a.json || claude --x'))
      .toBe(`claude --settings a.json || claude${FLAG} --x`);
  });

  it('is idempotent', () => {
    for (const cmd of [
      'claude',
      'claude --model opus -n "t"',
      `claude --resume 'x' || claude`,
      "cd '/w' && claude --x\r",
    ]) {
      const once = applyStatusLineTap(cmd);
      expect(applyStatusLineTap(once)).toBe(once);
    }
  });

  it('is a no-op on Windows (the script is bash)', () => {
    setPlatform('win32');
    expect(applyStatusLineTap('claude --model opus')).toBe('claude --model opus');
  });

  it('survives a shell round trip: the shell hands claude one settings argument that parses as JSON', () => {
    const line = applyStatusLineTap('claude --model opus -n "a title"');
    // `printf '%s\n'` stands in for claude so the shell's own word splitting is what is checked
    const out = execFileSync('/bin/sh', ['-c', line.replace(/^claude/, "printf '[%s]\\n'")], { encoding: 'utf8' })
      .trimEnd().split('\n');
    expect(out).toEqual([
      '[--settings]',
      `[${STATUS_LINE_TAP_SETTINGS}]`,
      '[--model]',
      '[opus]',
      '[-n]',
      '[a title]',
    ]);
    expect(JSON.parse(out[1].slice(1, -1)).statusLine.command).toBe(STATUS_LINE_TAP_COMMAND);
  });
});

describe('stripStatusLineTap', () => {
  it('removes the quoted form', () => {
    expect(stripStatusLineTap(tapped(' --model opus'))).toBe('claude --model opus');
  });

  it('removes the form `ps` shows: the shell has already eaten the quotes', () => {
    expect(stripStatusLineTap(`claude --settings ${STATUS_LINE_TAP_SETTINGS} --model opus -n x`))
      .toBe('claude --model opus -n x');
  });

  it('removes the = form, a double-quoted form and a settings-file form', () => {
    expect(stripStatusLineTap(`claude --settings=${STATUS_LINE_TAP_SETTINGS} --x`)).toBe('claude --x');
    const escaped = STATUS_LINE_TAP_SETTINGS.replace(/"/g, '\\"');
    expect(stripStatusLineTap(`claude --settings "${escaped}" --x`)).toBe('claude --x');
    expect(stripStatusLineTap('claude --settings /home/me/.claude/hooks/dashboard-statusline.settings.json --x'))
      .toBe('claude --x');
  });

  it('leaves no stray whitespace behind', () => {
    expect(stripStatusLineTap(`claude --settings '${STATUS_LINE_TAP_SETTINGS}'`)).toBe('claude');
    expect(stripStatusLineTap(`claude --a --settings '${STATUS_LINE_TAP_SETTINGS}'`)).toBe('claude --a');
  });

  it('removes it from both halves of a fallback line', () => {
    expect(stripStatusLineTap(`claude${FLAG} --x || claude${FLAG} --x`)).toBe('claude --x || claude --x');
  });

  it('leaves the user\'s own settings flags and plain commands alone', () => {
    for (const cmd of [
      'claude --settings ./mine.json --model opus',
      `claude --settings '{"model":"opus"}'`,
      'claude --model opus',
      'codex --yolo',
      '',
    ]) {
      expect(stripStatusLineTap(cmd)).toBe(cmd);
    }
  });

  it('undoes applyStatusLineTap', () => {
    for (const cmd of ['claude', 'claude --model opus -n "t"', `claude --resume 'x' || claude --x`]) {
      expect(stripStatusLineTap(applyStatusLineTap(cmd))).toBe(cmd);
    }
  });
});

describe('a stored command can never carry the tap', () => {
  // sessionStore stores whatever the hook saw in `ps -o args=` as the session's
  // startupCommand, and every resume / fork / clone replays it. In `ps` the JSON has lost its
  // quotes, and typed unquoted into a shell it is brace-expanded into garbage.
  const psForm = `claude --settings ${STATUS_LINE_TAP_SETTINGS} --model opus --dangerously-skip-permissions`;

  it('is stripped by sanitizeModelInCommand, which every ingest path already runs', () => {
    expect(sanitizeModelInCommand(psForm)).toBe('claude --model opus --dangerously-skip-permissions');
    expect(sanitizeModelInCommand(tapped(' --model opus'))).toBe('claude --model opus');
  });

  it('keeps sanitizeModelInCommand\'s own job: contaminated models are still cleaned', () => {
    expect(sanitizeModelInCommand('claude --model claude-opus-4-8[1m] -n x')).toBe('claude --model claude-opus-4-8 -n x');
  });

  it('heals on replay: strip on the way in, re-apply at launch gives one valid flag', () => {
    const relaunch = applyStatusLineTap(applyClaudeLaunchFlags(sanitizeModelInCommand(psForm), 'opus', undefined));
    expect(relaunch).toBe(tapped(' --model opus --dangerously-skip-permissions'));
  });

  it('is gone from the builders\' output as well (applyClaudeLaunchFlags starts from the sanitised command)', () => {
    expect(applyClaudeLaunchFlags(tapped(' --dangerously-skip-permissions'), 'opus', undefined))
      .toBe('claude --model opus --dangerously-skip-permissions');
  });
});

describe("the hook's ps capture (sessionStore) never stores the tap", () => {
  it('keeps the command Claude was launched with, minus the flag', async () => {
    const { handleEvent, getSession } = await import('../server/sessionStore.js');
    // What `ps -o args=` shows for a tapped launch: the shell has already eaten the quotes.
    const psArgs = `claude --settings ${STATUS_LINE_TAP_SETTINGS} --model opus --dangerously-skip-permissions`;

    const result = handleEvent({
      hook_event_name: 'SessionStart',
      session_id: 'tap-ps-capture',
      cwd: '/tmp/tap-ps-capture',
      tty_path: '/dev/ttys001',
      startup_command: psArgs,
    } as never);

    expect(result?.session.startupCommand).toBe('claude --model opus --dangerously-skip-permissions');
    expect(getSession('tap-ps-capture')?.startupCommand).toBe('claude --model opus --dangerously-skip-permissions');
  });
});

describe('isStatusLineTapEnabled (the opt-out)', () => {
  it('is on by default', () => {
    expect(isStatusLineTapEnabled({})).toBe(true);
    expect(isStatusLineTapEnabled({ PATH: '/usr/bin' })).toBe(true);
  });

  it('is turned off by AASC_DISABLE_STATUSLINE_TAP=1', () => {
    expect(isStatusLineTapEnabled({ AASC_DISABLE_STATUSLINE_TAP: '1' })).toBe(false);
  });

  it('takes only an explicit 1: an empty, zero or other value leaves the tap on', () => {
    for (const value of ['', '0', 'false', 'no', 'true', ' 1']) {
      expect(isStatusLineTapEnabled({ AASC_DISABLE_STATUSLINE_TAP: value })).toBe(true);
    }
  });

  it('reads the real environment by default', () => {
    expect(isStatusLineTapEnabled()).toBe(true);
    process.env.AASC_DISABLE_STATUSLINE_TAP = '1';
    try {
      expect(isStatusLineTapEnabled()).toBe(false);
    } finally {
      delete process.env.AASC_DISABLE_STATUSLINE_TAP;
    }
  });
});

describe('isStatusLineTapInstalled', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(join(tmpdir(), 'aasc-tap-home-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('is false until the script is in ~/.claude/hooks', () => {
    expect(isStatusLineTapInstalled(home)).toBe(false);
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
    expect(isStatusLineTapInstalled(home)).toBe(false);
    writeFileSync(join(home, '.claude', 'hooks', 'dashboard-statusline.sh'), '#!/bin/bash\n');
    expect(isStatusLineTapInstalled(home)).toBe(true);
  });

  it('looks in the real home directory by default', () => {
    const previous = process.env.HOME;
    process.env.HOME = home;
    try {
      expect(isStatusLineTapInstalled()).toBe(false);
      mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
      writeFileSync(join(home, '.claude', 'hooks', 'dashboard-statusline.sh'), '#!/bin/bash\n');
      expect(isStatusLineTapInstalled()).toBe(true);
    } finally {
      if (previous === undefined) delete process.env.HOME; else process.env.HOME = previous;
    }
  });
});

describe.skipIf(realPlatform === 'win32')('what is typed into the terminal (sshManager)', () => {
  let home: string;
  let previousHome: string | undefined;
  const installTap = () => {
    mkdirSync(join(home, '.claude', 'hooks'), { recursive: true });
    writeFileSync(join(home, '.claude', 'hooks', 'dashboard-statusline.sh'), '#!/bin/bash\n');
  };

  // createTerminal types its launch line once the shell is "ready" — a prompt, or a fallback
  // timer (2 s local, 10 s over ssh). Fake timers let the fallback fire at once.
  const settle = () => vi.advanceTimersByTimeAsync(10_500);

  beforeEach(() => {
    typed.length = 0;
    home = mkdtempSync(join(tmpdir(), 'aasc-tap-home-'));
    previousHome = process.env.HOME;
    process.env.HOME = home;
    vi.useFakeTimers();
  });

  afterEach(async () => {
    const { getTerminals, closeTerminal } = await import('../server/sshManager.js');
    for (const t of getTerminals()) closeTerminal(t.terminalId);
    vi.clearAllTimers();
    vi.useRealTimers();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    rmSync(home, { recursive: true, force: true });
  });

  const localConfig = (over: Record<string, unknown> = {}) => ({
    host: 'localhost',
    port: 22,
    username: 'tester',
    authMethod: 'key' as const,
    workingDir: '/tmp',
    command: 'claude --dangerously-skip-permissions',
    ...over,
  });

  describe('auto-launch (createTerminal)', () => {
    it('types the tap into a LOCAL claude launch', async () => {
      installTap();
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(localConfig({ model: 'opus', sessionTitle: 'My title' }), null);
      await settle();
      expect(typed).toEqual([`claude${FLAG} --model opus --dangerously-skip-permissions -n "My title"\r`]);
    });

    it('types the plain command when the script is not installed', async () => {
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(localConfig({ sessionTitle: 'My title' }), null);
      await settle();
      expect(typed).toEqual(['claude --dangerously-skip-permissions -n "My title"\r']);
    });

    it('types the plain command when the opt-out is set, even with the script installed', async () => {
      installTap();
      process.env.AASC_DISABLE_STATUSLINE_TAP = '1';
      try {
        const { createTerminal } = await import('../server/sshManager.js');
        await createTerminal(localConfig(), null);
        await settle();
        expect(typed).toHaveLength(1);
        expect(typed[0]).toContain('claude --dangerously-skip-permissions');
        expect(typed[0]).not.toContain('--settings');
      } finally {
        delete process.env.AASC_DISABLE_STATUSLINE_TAP;
      }
    });

    it('leaves a non-Claude command alone', async () => {
      installTap();
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(localConfig({ command: 'codex --dangerously-bypass-approvals-and-sandbox' }), null);
      await settle();
      expect(typed).toEqual(['codex --dangerously-bypass-approvals-and-sandbox\r']);
    });

    it('does not send it to a REMOTE host, which has no such script', async () => {
      installTap();
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(localConfig({ host: 'build.example.com', workingDir: '/srv/app' }), null);
      await settle();
      expect(typed).toHaveLength(1);
      expect(typed[0]).toContain('claude --dangerously-skip-permissions');
      expect(typed[0]).not.toContain('--settings');
      expect(typed[0]).not.toContain('dashboard-statusline');
    });

    it('survives being wrapped in a tmux command line', async () => {
      installTap();
      const { createTerminal } = await import('../server/sshManager.js');
      await createTerminal(localConfig({ useTmux: true, sessionTitle: 'T' }), null);
      await settle();
      expect(typed).toHaveLength(1);
      const line = typed[0].replace(/\r$/, '');
      expect(line.startsWith('tmux new-session -s ')).toBe(true);
      // the shell hands tmux (name, inner command): the inner one must still be the tapped command
      const argv = execFileSync(
        '/bin/sh',
        ['-c', `${line.replace(/^tmux new-session -s /, 'set -- ')}; printf '%s' "$2"`],
        { encoding: 'utf8' },
      );
      expect(argv).toBe(`claude${FLAG} --dangerously-skip-permissions -n "T"`);
    });

    it('does not put the tap into the command the terminal (or the caller) keeps', async () => {
      installTap();
      const { createTerminal, getTerminals } = await import('../server/sshManager.js');
      const config = localConfig({ model: 'opus' });
      const id = await createTerminal(config, null);
      await settle();
      expect(typed[0]).toContain('--settings'); // it WAS typed...
      // ...but what the terminal records (GET /api/terminals) and what the caller hands on to
      // createTerminalSession is still the command as asked for
      expect(getTerminals().find((t) => t.terminalId === id)?.command).toBe('claude --dangerously-skip-permissions');
      expect(config.command).toBe('claude --dangerously-skip-permissions');
    });
  });

  describe('deferred launch (writeWhenReady — resume, fork, clone, restore, floating)', () => {
    const deferred = () => localConfig({ command: '', deferredLaunch: true });
    const resumeLine = `claude --model opus -n "t" --resume 'abc' || claude --model opus -n "t"\r`;

    it('types the tap into BOTH halves of a local resume line', async () => {
      installTap();
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(deferred(), null);
      const written = writeWhenReady(id, resumeLine);
      await settle();
      await written;
      expect(typed).toEqual([
        `claude${FLAG} --model opus -n "t" --resume 'abc' || claude${FLAG} --model opus -n "t"\r`,
      ]);
    });

    it('types a plain line when the opt-out is set', async () => {
      installTap();
      process.env.AASC_DISABLE_STATUSLINE_TAP = '1';
      try {
        const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
        const id = await createTerminal(deferred(), null);
        const written = writeWhenReady(id, resumeLine);
        await settle();
        await written;
        expect(typed).toEqual([resumeLine]);
      } finally {
        delete process.env.AASC_DISABLE_STATUSLINE_TAP;
      }
    });

    it('types a plain line when the script is not installed', async () => {
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(deferred(), null);
      const written = writeWhenReady(id, resumeLine);
      await settle();
      await written;
      expect(typed).toEqual([resumeLine]);
    });

    it('leaves a remote terminal\'s line alone', async () => {
      installTap();
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(localConfig({ command: '', deferredLaunch: true, host: 'build.example.com' }), null);
      const line = `export AGENT_MANAGER_TERMINAL_ID='x' && cd '/srv' && ${resumeLine}`;
      const written = writeWhenReady(id, line);
      await settle();
      await written;
      expect(typed).toEqual([line]);
    });

    it('leaves a Codex resume line alone', async () => {
      installTap();
      const { createTerminal, writeWhenReady } = await import('../server/sshManager.js');
      const id = await createTerminal(deferred(), null);
      const line = "codex resume 'abc' || codex\r";
      const written = writeWhenReady(id, line);
      await settle();
      await written;
      expect(typed).toEqual([line]);
    });
  });
});
