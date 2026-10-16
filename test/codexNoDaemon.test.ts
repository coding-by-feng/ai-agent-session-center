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
import { describe, it, expect, vi } from 'vitest';
import {
  CODEX_NO_DAEMON_FLAG,
  applyCodexNoDaemon,
  stripCodexNoDaemon,
  hasCodexLaunch,
  helpAdvertisesNoDaemon,
  isCodexNoDaemonEnabled,
  createCodexNoDaemonProbe,
} from '../server/codexNoDaemon.js';

const ID = '01a1431a-6dbc-7fd2-9f87-00175b7a838a';

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

describe('stripCodexNoDaemon', () => {
  it('removes the flag wherever it sits, leaving no stray whitespace', () => {
    expect(stripCodexNoDaemon('codex --no-daemon --yolo')).toBe('codex --yolo');
    expect(stripCodexNoDaemon(`codex --yolo resume --no-daemon '${ID}' || codex --no-daemon --yolo\r`))
      .toBe(`codex --yolo resume '${ID}' || codex --yolo\r`);
  });

  it('leaves other commands and a quoted mention alone', () => {
    expect(stripCodexNoDaemon('claude -n "--no-daemon"')).toBe('claude -n "--no-daemon"');
    expect(stripCodexNoDaemon('codex --yolo')).toBe('codex --yolo');
  });

  it('undoes applyCodexNoDaemon', () => {
    const line = `codex --yolo resume '${ID}' || codex --yolo`;
    expect(stripCodexNoDaemon(applyCodexNoDaemon(line))).toBe(line);
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

describe('helpAdvertisesNoDaemon', () => {
  it('reads the option from `codex --help`', () => {
    const v0162 = 'Options:\n      --no-alt-screen\n          Runs the TUI in inline mode\n\n      --no-daemon\n          Run without the shared background server, even if it is already running\n';
    expect(helpAdvertisesNoDaemon(v0162)).toBe(true);
    expect(helpAdvertisesNoDaemon('Options:\n  -m, --model <MODEL>\n      --no-alt-screen\n')).toBe(false);
    expect(helpAdvertisesNoDaemon('')).toBe(false);
  });
});

describe('isCodexNoDaemonEnabled (the opt-out)', () => {
  it('is on unless AASC_DISABLE_CODEX_NO_DAEMON=1', () => {
    expect(isCodexNoDaemonEnabled({})).toBe(true);
    expect(isCodexNoDaemonEnabled({ AASC_DISABLE_CODEX_NO_DAEMON: '1' })).toBe(false);
    expect(isCodexNoDaemonEnabled({ AASC_DISABLE_CODEX_NO_DAEMON: '0' })).toBe(true);
  });
});

describe('createCodexNoDaemonProbe', () => {
  const HELP_NEW = 'Usage: codex [OPTIONS] [PROMPT]\n      --no-daemon\n          Run without the shared background server\n';
  const HELP_OLD = 'Usage: codex [OPTIONS] [PROMPT]\n  -m, --model <MODEL>\n';

  it('says supported / unsupported from the help text', async () => {
    expect(await createCodexNoDaemonProbe(async () => HELP_NEW)()).toBe('supported');
    expect(await createCodexNoDaemonProbe(async () => HELP_OLD)()).toBe('unsupported');
  });

  it('says unknown when codex cannot be run (missing, timed out) — the caller then changes nothing', async () => {
    const probe = createCodexNoDaemonProbe(async () => { throw new Error('spawn codex ENOENT'); });
    expect(await probe()).toBe('unknown');
  });

  it('runs codex once for concurrent launches (a workspace restore) and caches the answer', async () => {
    let clock = 1_000;
    const run = vi.fn(async () => HELP_NEW);
    const probe = createCodexNoDaemonProbe(run, { ttlMs: 60_000, unknownTtlMs: 5_000, now: () => clock });
    const answers = await Promise.all([probe(), probe(), probe()]);
    expect(answers).toEqual(['supported', 'supported', 'supported']);
    expect(await probe()).toBe('supported');
    expect(run).toHaveBeenCalledTimes(1);
    clock += 60_001; // codex may have been upgraded or downgraded since
    expect(await probe()).toBe('supported');
    expect(run).toHaveBeenCalledTimes(2);
  });

  it('retries an unknown answer sooner than a definite one', async () => {
    let clock = 1_000;
    const run = vi.fn()
      .mockRejectedValueOnce(new Error('timed out'))
      .mockResolvedValue(HELP_NEW);
    const probe = createCodexNoDaemonProbe(run, { ttlMs: 60_000, unknownTtlMs: 5_000, now: () => clock });
    expect(await probe()).toBe('unknown');
    expect(await probe()).toBe('unknown');
    clock += 5_001;
    expect(await probe()).toBe('supported');
    expect(run).toHaveBeenCalledTimes(2);
  });
});
