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
