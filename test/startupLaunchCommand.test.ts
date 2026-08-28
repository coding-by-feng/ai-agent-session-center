// test/startupLaunchCommand.test.ts — the raw-startupCommand launch path must
// normalize `-n` like every other relaunch path does.
//
// Found from live data: 26 restored sessions were all running
//   claude --model opus --effort max --dangerously-skip-permissions -n KTS Video
// with the title UNQUOTED. `claude` parses that as `-n KTS` plus a stray
// positional argument `Video` — i.e. an unintended initial prompt — which is
// exactly why those sessions came up with a promptHistory of ['Video'] that
// nobody typed.
//
// `appendSessionName` already self-heals a malformed `-n` (see
// sessionNameQuoting.test.ts), and `buildResumeCommand` routes through it. The
// raw startup path did not: POST /api/terminals wrote `config.startupCommand`
// into the PTY verbatim, so a snapshot carrying a legacy unquoted `-n` re-spawned
// it unrepaired on every single workspace restore, forever.
import { describe, it, expect, vi, beforeAll } from 'vitest';

vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: vi.fn() };
});
vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return { ...actual, createTerminal: vi.fn(), writeWhenReady: vi.fn(), closeTerminal: vi.fn() };
});
vi.mock('../server/db.js', () => ({}));

let buildStartupLaunchCommand: typeof import('../server/apiRouter.js').buildStartupLaunchCommand;

beforeAll(async () => {
  ({ buildStartupLaunchCommand } = await import('../server/apiRouter.js'));
});

/** The exact string found in the live workspace snapshot for all 26 sessions. */
const LIVE_BAD = 'claude --model opus --effort max --dangerously-skip-permissions -n KTS Video';

describe('buildStartupLaunchCommand — normalizes a legacy unquoted -n', () => {
  it('repairs the exact command found in the live snapshot', () => {
    expect(buildStartupLaunchCommand(LIVE_BAD, 'KTS Video')).toBe(
      'claude --model opus --effort max --dangerously-skip-permissions -n "KTS Video"',
    );
  });

  it('the repaired command no longer leaves a stray positional arg', () => {
    const out = buildStartupLaunchCommand(LIVE_BAD, 'KTS Video')!;
    // Everything after the -n value must be nothing — a bare `Video` sitting
    // outside quotes is the unintended prompt this whole fix exists to stop.
    expect(out).not.toMatch(/-n KTS Video/);
    expect(out).toMatch(/-n "KTS Video"$/);
  });

  it('does not double-add when the -n is already correct', () => {
    const good = 'claude --dangerously-skip-permissions -n "KTS Video"';
    expect(buildStartupLaunchCommand(good, 'KTS Video')).toBe(good);
  });

  it('adds a missing -n so a restored session keeps its title', () => {
    expect(buildStartupLaunchCommand('claude --dangerously-skip-permissions', 'KTS Video')).toBe(
      'claude --dangerously-skip-permissions -n "KTS Video"',
    );
  });

  it('shell-escapes a hostile title rather than executing it', () => {
    // Same threat model as quoteSessionTitle: the title reaches a live shell.
    const out = buildStartupLaunchCommand('claude', 'a`id`b')!;
    expect(out).toBe('claude -n "a\\`id\\`b"');
  });
});

describe('buildStartupLaunchCommand — leaves non-Claude commands alone', () => {
  it('passes a raw shell command through untouched', () => {
    // This path exists precisely FOR raw commands with shell metacharacters
    // (workspace import sends command:'' + startupCommand:'<cmd>'). Rewriting
    // one would defeat the reason the branch exists.
    const raw = 'cd /tmp && ./run.sh --flag "x y" | tee out.log';
    expect(buildStartupLaunchCommand(raw, 'Some Title')).toBe(raw);
  });

  it('leaves a codex command untouched (no -n flag in that CLI)', () => {
    const codex = 'codex --model gpt-5';
    expect(buildStartupLaunchCommand(codex, 'Some Title')).toBe(codex);
  });
});

describe('buildStartupLaunchCommand — absent input', () => {
  it('returns null when there is no startup command', () => {
    expect(buildStartupLaunchCommand(undefined, 'KTS Video')).toBeNull();
    expect(buildStartupLaunchCommand('', 'KTS Video')).toBeNull();
  });

  it('preserves an existing -n when no title is available to replace it', () => {
    // Mirrors appendSessionName's contract: no replacement title means leave
    // whatever the command already carries.
    expect(buildStartupLaunchCommand(LIVE_BAD, undefined)).toBe(LIVE_BAD);
  });
});
