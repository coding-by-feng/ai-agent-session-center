/**
 * OpenCode + Antigravity CLI (Nov 23 2026) through the real session store: the hook lines their relays write
 * (hooks/opencode-plugin/server.js, hooks/dashboard-hook-agy.sh) land on the card of the dashboard terminal the
 * agent runs in, re-keyed to the agent's own session id, tagged with its agent, and with no Claude transcript.
 *
 * Nothing here spawns or signals a process: hook payloads only, invented pids, terminateProcessTree mocked,
 * process.kill guarded (known-issues.md).
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const mocks = vi.hoisted(() => ({ broadcast: vi.fn(), terminateProcessTree: vi.fn() }));

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
  return { ...mod, broadcast: mocks.broadcast };
});

vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
    terminateProcessTree: mocks.terminateProcessTree,
  };
});

const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`extraAgentHookLinkage.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getAllSessions, getSession, createTerminalSession } = await import('../server/sessionStore.js');

const AGENT_PID = 4_200_001; // invented, above the OS range

let n = 0;
let TERM = '';
let CWD = '';
let TTY = '';

const cases = [
  {
    name: 'OpenCode',
    cli: 'opencode',
    command: 'opencode --auto',
    sessionId: () => `ses_df83e11abffe${String(n).padStart(4, '0')}KHwFK5Q4`,
  },
  {
    name: 'Antigravity CLI',
    cli: 'antigravity',
    command: 'agy --dangerously-skip-permissions',
    sessionId: () => `d291a3f2-c43a-4537-a7e8-3a103327${String(n).padStart(4, '0')}`,
  },
] as const;

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe.each(cases)('$name hooks', ({ cli, command, sessionId }) => {
  let ID = '';
  beforeEach(async () => {
    n += 1;
    TERM = `term-extra-${cli}-${n}`;
    CWD = `/tmp/extra-agents-${n}/app`;
    TTY = `/dev/ttys${String(200 + n)}`;
    ID = sessionId();
    mocks.broadcast.mockClear();
    await createTerminalSession(TERM, { host: 'localhost', workingDir: CWD, command });
  });

  const hook = (event: string, extra: Record<string, unknown> = {}) =>
    handleEvent({
      session_id: ID,
      hook_event_name: event,
      cli_source: cli,
      cwd: CWD,
      claude_pid: AGENT_PID,
      tty_path: TTY,
      agent_terminal_id: TERM,
      ...extra,
    } as never);

  it('land on the terminal\'s card: one card, re-keyed, prompt, tool and turn end recorded', () => {
    expect(getSession(TERM)?.cliSource).toBe(cli);

    hook('SessionStart', { source: 'startup', startup_command: command });
    hook('UserPromptSubmit', { prompt: 'run the tests' });
    hook('PreToolUse', { tool_name: 'Bash', tool_input: { command: 'npm test' } });
    hook('PostToolUse', { tool_name: 'Bash' });
    hook('Stop', { response: 'All tests pass.', stop_reason: 'end_turn' });

    const card = getSession(ID);
    expect(card?.terminalId).toBe(TERM);
    expect(card?.cliSource).toBe(cli);
    expect(card?.promptHistory.map((p) => p.text)).toEqual(['run the tests']);
    expect(card?.toolUsage.Bash).toBe(1);
    expect(card?.status).toBe('waiting');
    expect(card?.transcriptPath ?? null).toBeNull();
    const owning = Object.values(getAllSessions()).filter((s) => s.terminalId === TERM || s.lastTerminalId === TERM);
    expect(owning).toHaveLength(1);
    expect(Object.keys(getAllSessions())).not.toContain(TERM);
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
  });

  it('a permission dialog shows as approval', () => {
    hook('SessionStart', { source: 'startup' });
    hook('UserPromptSubmit', { prompt: 'x' });
    hook('PermissionRequest', { tool_name: 'Bash', tool_input: { command: 'rm -rf build' } });
    expect(getSession(ID)?.status).toBe('approval');
  });

  it('a resume whose first hook is the prompt still takes the terminal\'s card', () => {
    // `agy --conversation <id>` sends no SessionStart (seen live); OpenCode's plugin sends one first itself.
    hook('UserPromptSubmit', { prompt: 'what did you say last time?' });
    const card = getSession(ID);
    expect(card?.terminalId).toBe(TERM);
    expect(card?.promptHistory.map((p) => p.text)).toEqual(['what did you say last time?']);
    expect(Object.keys(getAllSessions())).not.toContain(TERM);
  });
});
