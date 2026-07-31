// test/buildResumeCommand.test.ts — resume-fallback fix.
// When `claude --resume '<id>'` fails (e.g. the session never persisted a
// transcript), the fallback must start a FRESH `claude` — NOT `claude --continue`,
// which resumes the most-recent UNRELATED conversation in that directory (a
// background session, or an agent's own live session in the same dir) and hijacks
// it, corrupting session identity + room membership on workspace restore.
import { describe, it, expect, vi, beforeAll } from 'vitest';

// Mock the heavy side-effecting deps so importing apiRouter is clean.
vi.mock('../server/wsManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/wsManager.js')>('../server/wsManager.js');
  return { ...actual, broadcast: vi.fn() };
});
vi.mock('../server/sshManager.js', async () => {
  const actual = await vi.importActual<typeof import('../server/sshManager.js')>('../server/sshManager.js');
  return { ...actual, createTerminal: vi.fn(), writeWhenReady: vi.fn(), closeTerminal: vi.fn() };
});
// apiRouter imports the SQLite module for unrelated routes. Keep this pure
// command-builder suite independent of the Electron-vs-Node native ABI.
vi.mock('../server/db.js', () => ({}));

const VALID_UUID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';

let buildResumeCommand: typeof import('../server/apiRouter.js').buildResumeCommand;

beforeAll(async () => {
  ({ buildResumeCommand } = await import('../server/apiRouter.js'));
});

describe('buildResumeCommand — resume fallback', () => {
  it('claude: resumes by id, falls back to FRESH claude (never --continue)', () => {
    const cmd = buildResumeCommand(
      { startupCommand: 'claude --effort high -n thesis', title: 'thesis-1' },
      VALID_UUID,
    );
    // primary tries the exact session
    expect(cmd).toContain(`--resume '${VALID_UUID}'`);
    // must be an OR fallback
    expect(cmd).toContain('||');
    // the fallback must NOT continue an unrelated conversation
    expect(cmd).not.toContain('--continue');
    const fallback = cmd.split('||')[1].trim();
    expect(fallback.startsWith('claude')).toBe(true);
    expect(fallback).not.toContain('--resume');
    expect(fallback).not.toContain('--continue');
  });

  it('claude: a non-resumable (non-UUID) id starts fresh, no --continue', () => {
    const cmd = buildResumeCommand(
      { startupCommand: 'claude -n aasc', title: 'AASC-1' },
      'term-1781779908472-xyz',
    );
    expect(cmd).not.toContain('--continue');
    expect(cmd).not.toContain('--resume');
    expect(cmd.startsWith('claude')).toBe(true);
  });

  it('codex: resumes by id, falls back to FRESH codex (never resume --last)', () => {
    const cmd = buildResumeCommand({ startupCommand: 'codex', title: 'cx' }, VALID_UUID);
    expect(cmd).toContain(`resume '${VALID_UUID}'`);
    expect(cmd).toContain('||');
    expect(cmd).not.toContain('resume --last');
    const fallback = cmd.split('||')[1].trim();
    expect(fallback.startsWith('codex')).toBe(true);
    expect(fallback).not.toContain('resume');
  });
});

describe('buildResumeCommand — effort/model re-application on resume', () => {
  it('re-applies a standard effort level as an --effort launch flag', () => {
    const cmd = buildResumeCommand(
      { startupCommand: 'claude', title: 't', effortLevel: 'max' },
      VALID_UUID,
    );
    expect(cmd).toContain('--effort max');
    expect(cmd).toContain(`--resume '${VALID_UUID}'`);
  });

  it('downgrades ultracode to --effort xhigh (the true upgrade is injected separately)', () => {
    const cmd = buildResumeCommand(
      { startupCommand: 'claude', title: 't', effortLevel: 'ultracode' },
      VALID_UUID,
    );
    expect(cmd).toContain('--effort xhigh');
    expect(cmd).not.toContain('--effort ultracode');
  });

  it('re-applies the model as a --model launch flag', () => {
    const cmd = buildResumeCommand(
      { startupCommand: 'claude', title: 't', model: 'opus' },
      VALID_UUID,
    );
    expect(cmd).toContain('--model opus');
  });

  it('re-applies a Codex model before the resume subcommand and fresh fallback', () => {
    const cmd = buildResumeCommand(
      { startupCommand: 'codex', title: 't', model: 'gpt-newest' },
      VALID_UUID,
    );
    expect(cmd).toBe(
      `codex --model gpt-newest resume '${VALID_UUID}' || codex --model gpt-newest`,
    );
  });

  it('adds no effort/model flags when neither is set', () => {
    const cmd = buildResumeCommand({ startupCommand: 'claude', title: 't' }, VALID_UUID);
    expect(cmd).not.toContain('--effort');
    expect(cmd).not.toContain('--model');
  });
});

/**
 * The `|| <baseCmd>` fallback duplicates the ENTIRE launch command. With a
 * realistic command that is 216 characters — 38% of it a verbatim copy — which
 * wraps onto a second line in the 120-column PTY and renders as garbled,
 * seemingly-duplicated text in the terminal.
 *
 * The duplicate is only load-bearing when we cannot tell in advance whether
 * `--resume` will succeed. When the transcript is verifiably on disk, the
 * fallback is unreachable and can be dropped.
 */
describe('buildResumeCommand — dropping the unreachable fallback', () => {
  const LONG = 'claude --model opus --effort max --dangerously-skip-permissions';

  it('keeps the fallback when resumability cannot be checked (no projectPath)', () => {
    const cmd = buildResumeCommand({ startupCommand: LONG, title: 'SMS OPS STATS' }, VALID_UUID);
    expect(cmd).toContain('||');
  });

  it('keeps the fallback for a REMOTE session — the transcript is on another host', () => {
    const cmd = buildResumeCommand(
      {
        startupCommand: LONG,
        title: 'SMS OPS STATS',
        projectPath: '/tmp/definitely-not-a-real-project',
        sshConfig: { command: 'claude', host: 'build-box' },
      },
      VALID_UUID,
    );
    expect(cmd).toContain('||');
  });

  it('keeps the fallback when the local transcript is NOT found (we may be wrong)', () => {
    const cmd = buildResumeCommand(
      { startupCommand: LONG, title: 'x', projectPath: '/tmp/aasc-no-such-project-xyz' },
      VALID_UUID,
    );
    expect(cmd).toContain('||');
    expect(cmd).toContain(`--resume '${VALID_UUID}'`);
  });

  it('drops the fallback when the transcript is verifiably on disk', () => {
    const { mkdtempSync, writeFileSync } = require('fs') as typeof import('fs');
    const { join } = require('path') as typeof import('path');
    const { tmpdir } = require('os') as typeof import('os');
    // resolveResumableClaudeSessionId accepts a recorded transcriptPath that
    // exists, so a temp file is enough to prove the "found" branch.
    const dir = mkdtempSync(join(tmpdir(), 'aasc-resume-'));
    const transcript = join(dir, `${VALID_UUID}.jsonl`);
    writeFileSync(transcript, '{}\n');

    const cmd = buildResumeCommand(
      { startupCommand: LONG, title: 'SMS OPS STATS', projectPath: dir, transcriptPath: transcript },
      VALID_UUID,
    );
    expect(cmd).not.toContain('||');
    expect(cmd).toContain(`--resume '${VALID_UUID}'`);
    // The whole point: no verbatim duplicate of the launch command.
    expect(cmd.split('--dangerously-skip-permissions').length - 1).toBe(1);
    expect(cmd.length).toBeLessThan(160);
  });
});
