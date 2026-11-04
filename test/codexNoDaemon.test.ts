// test/codexNoDaemon.test.ts — AASC-59: the `--no-daemon` launch flag for local Codex.
//
// Codex 0.162+ runs a thread on a shared background app-server daemon when one is running
// (and auto-starts one otherwise). The daemon then runs the lifecycle hooks: no tty, the
// daemon's pid, and the daemon's environment — so the AGENT_MANAGER_TERMINAL_ID the hook
// reports is whatever dashboard terminal happened to start the daemon, or nothing. No
// matching rule can bind those hooks to the terminal the Codex TUI lives in (seen live:
// term-1792127112411-8kzgrm, rollout 01a1431a-6dbc-7fd2-9f87-00175b7a838a, hook pid 42715 =
// the daemon). `codex --no-daemon` keeps the thread in the TUI's own process, so its hooks
// are children of the codex on the PTY (verified against Codex 0.162.1 in a tmux probe with
// an isolated CODEX_HOME: ppid = the TUI, tty = the pane, AGENT_MANAGER_TERMINAL_ID = the
// pane's). These tests pin the line rewrite and the capability probe that gates it.
//
// Nov 4 2026: `--no-alt-screen` joins it. Codex 0.166 draws its TUI on the alternate screen,
// which keeps no xterm scrollback, so a dashboard Codex terminal could not scroll back to
// earlier turns: xterm turned the wheel into arrow keys typed into Codex. `--no-alt-screen`
// ("Runs the TUI in inline mode, preserving terminal scrollback history") puts the history
// in the scrollback, as CLAUDE_CODE_DISABLE_ALTERNATE_SCREEN=1 does for Claude.
import { describe, it, expect, vi } from 'vitest';
import {
  CODEX_NO_DAEMON_FLAG,
  CODEX_NO_ALT_SCREEN_FLAG,
  CODEX_LAUNCH_FLAGS,
  applyCodexLaunchFlags,
  stripCodexLaunchFlags,
  hasCodexLaunch,
  helpAdvertises,
  isCodexLaunchFlagEnabled,
  createCodexLaunchFlagProbe,
} from '../server/codexNoDaemon.js';

const ID = '01a1431a-6dbc-7fd2-9f87-00175b7a838a';

/** The AASC-59 cases below were written for `--no-daemon` alone; they still pin where a flag goes. */
const applyCodexNoDaemon = (line: string) => applyCodexLaunchFlags(line, { add: [CODEX_NO_DAEMON_FLAG] });

describe('applyCodexNoDaemon', () => {
  it('puts the flag right after a bare codex', () => {
    expect(CODEX_NO_DAEMON_FLAG).toBe('--no-daemon');
    expect(applyCodexNoDaemon('codex')).toBe('codex --no-daemon');
    expect(applyCodexNoDaemon('codex --dangerously-bypass-approvals-and-sandbox'))
      .toBe('codex --no-daemon --dangerously-bypass-approvals-and-sandbox');
  });

  it('puts it after the resume / fork subcommand (where `codex resume --help` documents it)', () => {
    expect(applyCodexNoDaemon(`codex --yolo resume '${ID}'`)).toBe(`codex --yolo resume --no-daemon '${ID}'`);
    expect(applyCodexNoDaemon(`codex fork '${ID}' 'explain this'`)).toBe(`codex fork --no-daemon '${ID}' 'explain this'`);
    expect(applyCodexNoDaemon(`codex fork --last 'go'`)).toBe(`codex fork --no-daemon --last 'go'`);
  });

  it('covers BOTH halves of a resume-with-fallback line and keeps the typed carriage return', () => {
    expect(applyCodexNoDaemon(`codex --yolo resume '${ID}' || codex --yolo\r`))
      .toBe(`codex --yolo resume --no-daemon '${ID}' || codex --no-daemon --yolo\r`);
  });

  it('skips option values when looking for the subcommand', () => {
    const line = `codex --model gpt-6 -c 'model_reasoning_effort="high"' resume '${ID}'`;
    expect(applyCodexNoDaemon(line))
      .toBe(`codex --model gpt-6 -c 'model_reasoning_effort="high"' resume --no-daemon '${ID}'`);
    // `resume` here is the model's name, not a subcommand
    expect(applyCodexNoDaemon('codex -m resume')).toBe('codex --no-daemon -m resume');
    expect(applyCodexNoDaemon(`codex --model=gpt-6 resume '${ID}'`)).toBe(`codex --model=gpt-6 resume --no-daemon '${ID}'`);
  });

  it('treats a first positional that is not a subcommand as the prompt', () => {
    expect(applyCodexNoDaemon(`codex 'fix the bug'`)).toBe(`codex --no-daemon 'fix the bug'`);
    expect(applyCodexNoDaemon(`codex "resume"`)).toBe(`codex --no-daemon "resume"`);
  });

  it('is idempotent, and moves a stored root-level flag next to the subcommand', () => {
    const once = applyCodexNoDaemon(`codex --yolo resume '${ID}' || codex --yolo`);
    expect(applyCodexNoDaemon(once)).toBe(once);
    expect(applyCodexNoDaemon('codex --no-daemon --yolo')).toBe('codex --no-daemon --yolo');
    // The hook stores the live CLI's `ps` args: a fresh launch comes back as `codex --no-daemon …`.
    expect(applyCodexNoDaemon(`codex --no-daemon --yolo resume '${ID}'`)).toBe(`codex --yolo resume --no-daemon '${ID}'`);
    expect(applyCodexNoDaemon(`codex resume '${ID}' --no-daemon`)).toBe(`codex resume --no-daemon '${ID}'`);
  });

  it('follows cd / export prefixes', () => {
    expect(applyCodexNoDaemon(`cd '/tmp/x' && codex --yolo`)).toBe(`cd '/tmp/x' && codex --no-daemon --yolo`);
  });

  it('leaves alone anything that is not an interactive bare codex', () => {
    const untouched = [
      'claude --dangerously-skip-permissions',
      'codex exec "do it"',
      'codex login',
      'codex app-server',
      'codex mcp list',
      '/opt/homebrew/bin/codex --yolo', // a path may be another install; only the PATH codex is probed
      'echo codex',
      `claude -n "codex"`,
      `tmux new-session -s 'x' 'codex --yolo'`,
      '',
    ];
    for (const line of untouched) expect(applyCodexNoDaemon(line)).toBe(line);
  });
});

describe('applyCodexLaunchFlags', () => {
  const BOTH = { add: [CODEX_NO_DAEMON_FLAG, CODEX_NO_ALT_SCREEN_FLAG] };

  it('types the flags in one fixed order, after codex or after resume / fork', () => {
    expect(CODEX_NO_ALT_SCREEN_FLAG).toBe('--no-alt-screen');
    expect(CODEX_LAUNCH_FLAGS).toEqual(['--no-daemon', '--no-alt-screen']);
    expect(applyCodexLaunchFlags('codex --yolo', BOTH)).toBe('codex --no-daemon --no-alt-screen --yolo');
    // `codex resume --help` and `codex fork --help` both list --no-alt-screen
    expect(applyCodexLaunchFlags(`codex --yolo resume '${ID}' || codex --yolo\r`, BOTH))
      .toBe(`codex --yolo resume --no-daemon --no-alt-screen '${ID}' || codex --no-daemon --no-alt-screen --yolo\r`);
    expect(applyCodexLaunchFlags(`codex fork '${ID}'`, { add: [CODEX_NO_ALT_SCREEN_FLAG, CODEX_NO_DAEMON_FLAG] }))
      .toBe(`codex fork --no-daemon --no-alt-screen '${ID}'`);
  });

  it('moves stored flags instead of doubling them (the stored command is the live CLI\'s ps args)', () => {
    const stored = `codex --no-daemon --no-alt-screen --model gpt-6 resume '${ID}'`;
    expect(applyCodexLaunchFlags(stored, BOTH)).toBe(`codex --model gpt-6 resume --no-daemon --no-alt-screen '${ID}'`);
    const once = applyCodexLaunchFlags(`codex --yolo resume '${ID}' || codex --yolo`, BOTH);
    expect(applyCodexLaunchFlags(once, BOTH)).toBe(once);
  });

  it('adds one flag and removes another (a Codex that has --no-daemon but not --no-alt-screen)', () => {
    expect(applyCodexLaunchFlags('codex --no-alt-screen --yolo', { add: [CODEX_NO_DAEMON_FLAG], remove: [CODEX_NO_ALT_SCREEN_FLAG] }))
      .toBe('codex --no-daemon --yolo');
  });

  it('leaves a flag it was not asked about where it is', () => {
    expect(applyCodexLaunchFlags('codex --yolo --no-daemon', { add: [CODEX_NO_ALT_SCREEN_FLAG] }))
      .toBe('codex --no-alt-screen --yolo --no-daemon');
    expect(applyCodexLaunchFlags('codex --no-alt-screen --yolo', {})).toBe('codex --no-alt-screen --yolo');
  });

  it('leaves alone anything that is not an interactive bare codex', () => {
    for (const line of ['claude --dangerously-skip-permissions', 'codex exec "do it"', '/opt/homebrew/bin/codex', 'echo codex']) {
      expect(applyCodexLaunchFlags(line, BOTH)).toBe(line);
    }
  });
});

describe('stripCodexLaunchFlags', () => {
  it('removes both flags wherever they sit, leaving no stray whitespace', () => {
    expect(stripCodexLaunchFlags('codex --no-daemon --yolo')).toBe('codex --yolo');
    expect(stripCodexLaunchFlags('codex --no-alt-screen --yolo')).toBe('codex --yolo');
    expect(stripCodexLaunchFlags(`codex --yolo resume --no-daemon --no-alt-screen '${ID}' || codex --no-alt-screen --no-daemon --yolo\r`))
      .toBe(`codex --yolo resume '${ID}' || codex --yolo\r`);
  });

  it('leaves other commands and a quoted mention alone', () => {
    expect(stripCodexLaunchFlags('claude -n "--no-daemon"')).toBe('claude -n "--no-daemon"');
    expect(stripCodexLaunchFlags(`codex '--no-alt-screen'`)).toBe(`codex '--no-alt-screen'`);
    expect(stripCodexLaunchFlags('codex --yolo')).toBe('codex --yolo');
  });

  it('undoes applyCodexLaunchFlags', () => {
    const line = `codex --yolo resume '${ID}' || codex --yolo`;
    expect(stripCodexLaunchFlags(applyCodexLaunchFlags(line, { add: CODEX_LAUNCH_FLAGS }))).toBe(line);
    expect(stripCodexLaunchFlags(applyCodexNoDaemon(line))).toBe(line);
  });
});

describe('hasCodexLaunch', () => {
  it('is true only for a line that starts an interactive bare codex', () => {
    expect(hasCodexLaunch('codex --yolo\r')).toBe(true);
    expect(hasCodexLaunch(`claude --resume 'x' || codex`)).toBe(true);
    expect(hasCodexLaunch(`codex resume '${ID}'`)).toBe(true);
    expect(hasCodexLaunch('claude --dangerously-skip-permissions\r')).toBe(false);
    expect(hasCodexLaunch('codex exec hi')).toBe(false);
    expect(hasCodexLaunch('/usr/local/bin/codex')).toBe(false);
  });
});

describe('helpAdvertises', () => {
  const v0166 = 'Options:\n      --no-alt-screen\n          Runs the TUI in inline mode, preserving terminal scrollback history.\n\n      --no-daemon\n          Run without the shared background server, even if it is already running\n';

  it('reads each option from `codex --help` on its own', () => {
    expect(helpAdvertises(v0166, CODEX_NO_DAEMON_FLAG)).toBe(true);
    expect(helpAdvertises(v0166, CODEX_NO_ALT_SCREEN_FLAG)).toBe(true);
    const onlyAltScreen = 'Options:\n  -m, --model <MODEL>\n      --no-alt-screen\n';
    expect(helpAdvertises(onlyAltScreen, CODEX_NO_DAEMON_FLAG)).toBe(false);
    expect(helpAdvertises(onlyAltScreen, CODEX_NO_ALT_SCREEN_FLAG)).toBe(true);
    expect(helpAdvertises('', CODEX_NO_ALT_SCREEN_FLAG)).toBe(false);
  });

  it('needs the whole word, not a longer option that starts with it', () => {
    expect(helpAdvertises('      --no-alt-screen-ever\n', CODEX_NO_ALT_SCREEN_FLAG)).toBe(false);
  });
});

describe('isCodexLaunchFlagEnabled (the opt-outs)', () => {
  it('turns each flag off with its own variable', () => {
    expect(isCodexLaunchFlagEnabled(CODEX_NO_DAEMON_FLAG, {})).toBe(true);
    expect(isCodexLaunchFlagEnabled(CODEX_NO_DAEMON_FLAG, { AASC_DISABLE_CODEX_NO_DAEMON: '1' })).toBe(false);
    expect(isCodexLaunchFlagEnabled(CODEX_NO_DAEMON_FLAG, { AASC_DISABLE_CODEX_NO_DAEMON: '0' })).toBe(true);
    expect(isCodexLaunchFlagEnabled(CODEX_NO_ALT_SCREEN_FLAG, {})).toBe(true);
    expect(isCodexLaunchFlagEnabled(CODEX_NO_ALT_SCREEN_FLAG, { AASC_DISABLE_CODEX_NO_ALT_SCREEN: '1' })).toBe(false);
    // one variable never switches off the other flag
    expect(isCodexLaunchFlagEnabled(CODEX_NO_ALT_SCREEN_FLAG, { AASC_DISABLE_CODEX_NO_DAEMON: '1' })).toBe(true);
    expect(isCodexLaunchFlagEnabled(CODEX_NO_DAEMON_FLAG, { AASC_DISABLE_CODEX_NO_ALT_SCREEN: '1' })).toBe(true);
  });
});

describe('createCodexLaunchFlagProbe', () => {
  const HELP_NEW = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-alt-screen\n          Runs the TUI in inline mode\n      --no-daemon\n          Run without the shared background server\n';
  const HELP_NO_ALT = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon\n          Run without the shared background server\n';
  const HELP_OLD = 'Usage: codex [OPTIONS] [PROMPT]\n  -m, --model <MODEL>\n';
  const all = (answer: string) => ({ '--no-daemon': answer, '--no-alt-screen': answer });

  it('answers for each flag from the help text', async () => {
    expect(await createCodexLaunchFlagProbe(async () => HELP_NEW)()).toEqual(all('supported'));
    expect(await createCodexLaunchFlagProbe(async () => HELP_OLD)()).toEqual(all('unsupported'));
    expect(await createCodexLaunchFlagProbe(async () => HELP_NO_ALT)())
      .toEqual({ '--no-daemon': 'supported', '--no-alt-screen': 'unsupported' });
  });

  it('says unknown when codex cannot be run (missing, timed out) — the caller then changes nothing', async () => {
    const probe = createCodexLaunchFlagProbe(async () => { throw new Error('spawn codex ENOENT'); });
    expect(await probe()).toEqual(all('unknown'));
  });

  it('runs codex once for concurrent launches (a workspace restore) and caches the answer', async () => {
    let clock = 1_000;
    const run = vi.fn(async () => HELP_NEW);
    const probe = createCodexLaunchFlagProbe(run, { ttlMs: 60_000, unknownTtlMs: 5_000, now: () => clock });
    const answers = await Promise.all([probe(), probe(), probe()]);
    expect(answers).toEqual([all('supported'), all('supported'), all('supported')]);
    expect(await probe()).toEqual(all('supported'));
    expect(run).toHaveBeenCalledTimes(1);
    clock += 60_001; // codex may have been upgraded or downgraded since
    expect(await probe()).toEqual(all('supported'));
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries an unknown answer sooner than a definite one', async () => {
    let clock = 1_000;
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValue(HELP_NEW);
    const probe = createCodexLaunchFlagProbe(run, { ttlMs: 60_000, unknownTtlMs: 5_000, now: () => clock });
    expect(await probe()).toEqual(all('unknown'));
    expect(await probe()).toEqual(all('unknown'));
    clock += 5_001;
    expect(await probe()).toEqual(all('supported'));
    expect(run).toHaveBeenCalledTimes(2);
  });
});
