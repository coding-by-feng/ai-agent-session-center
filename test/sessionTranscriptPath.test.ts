/**
 * `Session.transcriptPath` follows the hooks, not just SessionStart (Oct 24 2026).
 *
 * `EnterWorktree` moves a running Claude session's transcript into the worktree's projects
 * folder (`-…--claude-worktrees-<name>/<id>.jsonl`), with no new SessionStart. Every later hook
 * reports the new path; a store that kept the first one pointed the phone's Chat, the interrupt
 * check and the "proceed" check at a file that no longer exists. Fake timers: no approval or
 * auto-idle timer runs a real process probe.
 */
import { describe, it, expect, vi, afterAll } from 'vitest';

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

vi.mock('../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/wsManager.js')>();
  return { ...mod, broadcast: vi.fn() };
});

vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return { ...mod, startMonitoring: vi.fn(), stopMonitoring: vi.fn(), startExternalDiscovery: vi.fn() };
});

vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getSession } = await import('../server/sessionStore.js');

afterAll(() => {
  vi.useRealTimers();
});

const ID = '142f9e2b-8908-4296-8c11-ec5b2c406885';
const LAUNCH = `/Users/u/.claude/projects/-Users-u-app/${ID}.jsonl`;
const WORKTREE = `/Users/u/.claude/projects/-Users-u-app--claude-worktrees-central/${ID}.jsonl`;

function hook(event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: ID,
    hook_event_name: event,
    cwd: '/Users/u/app',
    tty_path: '/dev/ttys871',
    cli_source: 'claude',
    ...extra,
  } as never);
}

describe('the transcript path a session keeps', () => {
  it('takes the path SessionStart reports', () => {
    hook('SessionStart', { transcript_path: LAUNCH });
    expect(getSession(ID)?.transcriptPath).toBe(LAUNCH);
  });

  it('follows the transcript into a worktree: a later hook reports where it moved', () => {
    hook('UserPromptSubmit', { prompt: 'continue', transcript_path: LAUNCH });
    hook('PreToolUse', {
      tool_name: 'Bash',
      tool_input: { command: 'ls' },
      cwd: '/Users/u/app/.claude/worktrees/central',
      transcript_path: WORKTREE,
    });
    expect(getSession(ID)?.transcriptPath).toBe(WORKTREE);
  });

  it('keeps the path when a hook reports none', () => {
    hook('PostToolUse', { tool_name: 'Bash', tool_response: {} });
    expect(getSession(ID)?.transcriptPath).toBe(WORKTREE);
    hook('Stop', { transcript_path: '' });
    expect(getSession(ID)?.transcriptPath).toBe(WORKTREE);
  });
});
