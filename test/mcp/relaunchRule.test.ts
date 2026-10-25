// test/mcp/relaunchRule.test.ts — the stored-command rule of a relaunch (server/mcp/relaunchRule.ts, Rulings P3-8 and
// P3-23): a central resumes, reconnects, forks or clones only a card whose stored command is a bare claude or codex,
// with no shell syntax in it and only the flags AASC's own launch builders put on a line, once AASC's own MCP flags are
// taken off. The lines that must pass are taken from the builders themselves, as typed and as `ps` stores them (the
// route-built lines are in relaunchRoutes.test.ts). Pure: nothing here reaches a process.
import { describe, expect, it, vi } from 'vitest';
import { applyClaudeLaunchFlags, appendSessionName, reconstructPermissionFlags } from '../../server/config.js';
import { applyCodexNoDaemon } from '../../server/codexNoDaemon.js';
import { applyCentralLaunch } from '../../server/mcp/launch.js';
import { workerCommandFor } from '../../server/mcp/openWorker.js';
import { MODE_RANK } from '../../server/mcp/permissionCap.js';
import { RELAUNCH_REFUSAL, relaunchCommandRefusal, relaunchLineOf, storedCommandOf } from '../../server/mcp/relaunchRule.js';
import { psFormOf } from './psForm.js';
import { makeSession } from './toolHarness.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

const ID = '11111111-2222-4333-8444-000000000001';

/** Lines AASC's own builders produce, from the commands they start from. */
function builtLines(): string[] {
  const claude: string[] = [
    ...Object.keys(MODE_RANK).map((mode) => workerCommandFor('claude', mode)),
    workerCommandFor('claude', null),
    applyClaudeLaunchFlags('claude', 'sonnet', 'high'),
    applyClaudeLaunchFlags('claude --permission-mode plan', 'claude-opus-4-8', 'ultracode'),
    applyClaudeLaunchFlags('claude --dangerously-skip-permissions', 'opus', 'max', { replace: true }),
    reconstructPermissionFlags('claude', 'bypassPermissions'),
    reconstructPermissionFlags('claude', 'auto_edit'),
    reconstructPermissionFlags('claude', 'full-auto'),
    reconstructPermissionFlags('claude', 'plan'),
    `claude --resume '${ID}' --fork-session`,
    'claude --continue --fork-session',
  ];
  const named = claude.flatMap((line) => [
    appendSessionName(line, 'KTS Deployment'),
    appendSessionName(line, 'Fork of Fix the login bug'),
    appendSessionName(line, 'Ship it!'),
  ]);
  const codex: string[] = [
    workerCommandFor('codex', null),
    applyClaudeLaunchFlags('codex', 'gpt-5', 'high'),
    applyClaudeLaunchFlags('codex --dangerously-bypass-approvals-and-sandbox', 'gpt-5.1-codex', 'minimal'),
    applyClaudeLaunchFlags('codex --full-auto', 'o3', 'xhigh', { replace: true }),
    applyClaudeLaunchFlags('codex -s workspace-write -a on-request', null, 'low'),
    `${applyClaudeLaunchFlags('codex', 'gpt-5', 'medium')} resume '${ID}'`,
    `${applyClaudeLaunchFlags('codex', 'gpt-5', null)} fork '${ID}'`,
    'codex fork --last',
  ];
  return [...claude, ...named, ...codex, ...codex.map(applyCodexNoDaemon)];
}

describe('relaunchCommandRefusal', () => {
  it('an empty or missing command is no refusal (the route then runs its own claude)', () => {
    expect(relaunchCommandRefusal(undefined)).toBeNull();
    expect(relaunchCommandRefusal(null)).toBeNull();
    expect(relaunchCommandRefusal('')).toBeNull();
    expect(relaunchCommandRefusal('   ')).toBeNull();
  });

  it('every line AASC’s own builders produce passes as typed, and as ps stores it once its name is rebuilt from the title', () => {
    const lines = builtLines();
    expect(lines.length).toBeGreaterThan(40);
    for (const line of lines) {
      expect(relaunchCommandRefusal(line), line).toBeNull();
      const stored = relaunchLineOf(psFormOf(line), 'KTS Deployment');
      expect(relaunchCommandRefusal(stored), stored).toBeNull();
    }
  });

  it('-n takes one word: a ps-shaped name of more words is refused raw, and passes once rebuilt from the card’s title (P3-36)', () => {
    for (const [raw, title] of [
      ['claude -n KTS Deployment', 'KTS Deployment'],
      ['claude --model sonnet --effort high -n Fix the login bug', 'Fix the login bug'],
      [`claude --resume ${ID} --fork-session --model opus -n Fork of KTS Video`, 'Fork of KTS Video'],
      ['claude -n My title', 'My title'],
    ]) {
      expect(relaunchCommandRefusal(raw), raw).toBe(RELAUNCH_REFUSAL);
      const rebuilt = relaunchLineOf(raw, title);
      expect(rebuilt, raw).toContain(`-n "${title}"`);
      expect(relaunchCommandRefusal(rebuilt), rebuilt).toBeNull();
    }
  });

  it('a title that comes back as a Claude subcommand is refused raw, and rebuilt it is only a name (P3-36)', () => {
    const raw = 'claude -n x mcp add e npx p';
    expect(relaunchCommandRefusal(raw)).toBe(RELAUNCH_REFUSAL);
    const rebuilt = relaunchLineOf(raw, 'x mcp add e npx p');
    expect(rebuilt).toBe('claude -n "x mcp add e npx p"');
    expect(relaunchCommandRefusal(rebuilt)).toBeNull();
    // With no card title, the name it had is quoted instead; a Codex line is left as it is.
    expect(relaunchLineOf(raw, '')).toBe('claude -n "x mcp add e npx p"');
    expect(relaunchLineOf('codex --model gpt-5 resume abc', 'A title')).toBe('codex --model gpt-5 resume abc');
  });

  it('plain one-word names and the bare CLI flags pass raw', () => {
    for (const ok of [
      'claude -n KTS',
      'claude --model sonnet --effort high -n thesis',
      'claude --name=thesis --permission-mode=plan',
      "claude --permission-mode plan -n 'My title'",
      'codex --model gpt-5 -c model_reasoning_effort="high"',
      `codex --no-daemon --model gpt-5 -c model_reasoning_effort=high resume ${ID}`,
      '  claude --resume abc-123',
    ]) {
      expect(relaunchCommandRefusal(ok), ok).toBeNull();
    }
  });

  it('a title word that is a flag no AASC builder emits is refused', () => {
    for (const bad of [
      'claude -n w --allowedTools Bash',
      'claude --add-dir /',
      'claude -n x --add-dir /',
      'claude --mcp-config x',
      'claude --settings x',
      'claude --plugin-dir x',
      'claude --verbose',
      'claude -c',
      'claude -p hello',
      "claude ''--add-dir /",
      'claude -n "x" --add-dir /',
      'codex --profile p',
      'codex -p p',
      'codex --profile=p',
      'codex -c model="o3"',
      'codex -c sandbox_mode=danger-full-access',
      'codex --config approval_policy=never',
      'codex --add-dir /',
      'codex -C /',
    ]) {
      expect(relaunchCommandRefusal(bad), bad).toBe(RELAUNCH_REFUSAL);
    }
  });

  it('a flag value must be a plain token or one of its known values', () => {
    for (const bad of [
      'claude --model',
      'claude --model --dangerously-skip-permissions',
      "claude --model 'a b'",
      'claude --effort ultracode',
      'claude --effort extreme',
      'claude --resume a/b',
      'claude -n',
      'claude -n --allowedTools',
      'codex --sandbox everything',
      'codex -a sometimes',
      'codex -c model_reasoning_effort="max"',
    ]) {
      expect(relaunchCommandRefusal(bad), bad).toBe(RELAUNCH_REFUSAL);
    }
  });

  it('a positional word is refused, except Codex’s resume or fork with its id', () => {
    for (const bad of ['claude hello', 'claude --model opus fix-it', 'codex exec ls', 'codex resume a b', 'codex review', 'codex fork --last x']) {
      expect(relaunchCommandRefusal(bad), bad).toBe(RELAUNCH_REFUSAL);
    }
    for (const ok of ['codex resume', `codex resume ${ID}`, 'codex resume --last', `codex fork ${ID} --no-daemon`]) {
      expect(relaunchCommandRefusal(ok), ok).toBeNull();
    }
  });

  it('a stored command that is not a bare claude or codex is refused', () => {
    for (const bad of ['caffeinate claude', 'env X=1 claude', 'claude; rm -rf ~', 'npx claude', '/usr/local/bin/claude', 'claudex', 'bash -c claude']) {
      expect(relaunchCommandRefusal(bad)).toBe(RELAUNCH_REFUSAL);
    }
  });

  it('any shell syntax, wildcard, history mark, open quote or line break is refused', () => {
    for (const ch of [';', '&', '|', '$', '`', '<', '>', '(', ')', '{', '}', '\\', '\n', '\r', '*', '?', '[', ']', '!', '\t']) {
      expect(relaunchCommandRefusal(`claude --model x${ch}y`), JSON.stringify(ch)).toBe(RELAUNCH_REFUSAL);
    }
    expect(relaunchCommandRefusal('claude && rm -rf ~')).toBe(RELAUNCH_REFUSAL);
    expect(relaunchCommandRefusal('claude $(whoami)')).toBe(RELAUNCH_REFUSAL);
    expect(relaunchCommandRefusal('claude -n Kason\'s boss')).toBe(RELAUNCH_REFUSAL);
    expect(relaunchCommandRefusal('claude -n "open')).toBe(RELAUNCH_REFUSAL);
  });

  it('AASC’s own MCP flags are taken off first, so a central-launched line is judged by its own words', () => {
    const line = applyCentralLaunch('claude --model sonnet', { port: 4321 });
    expect(line).toContain('$');
    expect(relaunchCommandRefusal(line)).toBeNull();
    expect(relaunchCommandRefusal(applyCentralLaunch('codex --model gpt-5', { port: 4321 }))).toBeNull();
  });

  it('the refusal never repeats the command', () => {
    expect(RELAUNCH_REFUSAL).not.toContain('caffeinate');
    expect(RELAUNCH_REFUSAL).toBe(
      'A central relaunches only a session started as a bare claude or codex command with the flags AASC itself launches with.',
    );
  });
});

describe('storedCommandOf', () => {
  it('reads what the relaunch routes reuse: startupCommand, then sshCommand, then the SSH config’s command', () => {
    expect(storedCommandOf(makeSession('a', { startupCommand: 'claude -c' }))).toBe('claude -c');
    expect(storedCommandOf(makeSession('b', { sshCommand: 'codex' }))).toBe('codex');
    const cfg = { host: 'localhost', username: 'u', command: 'claude --x' } as unknown as NonNullable<ReturnType<typeof makeSession>['sshConfig']>;
    expect(storedCommandOf(makeSession('c', { sshConfig: cfg }))).toBe('claude --x');
    expect(storedCommandOf(makeSession('d'))).toBe('');
  });
});
