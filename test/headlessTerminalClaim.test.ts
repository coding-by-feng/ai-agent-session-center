/**
 * AASC-10 through the real session store: claude-mem's observer (another process that inherited
 * a dashboard terminal's AGENT_MANAGER_TERMINAL_ID, no controlling tty) must not re-key, re-path
 * or end the pinned card that owns that terminal. Ending it is what made pinnedRespawn launch a
 * fresh "Exmouth Research" terminal every minute.
 *
 * Nothing here spawns or signals a process: the store is driven with hook payloads only, every
 * pid is invented (above the OS pid range), terminateProcessTree is mocked and process.kill is
 * guarded (known-issues.md: a test must never reach a real process).
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

// Second line of defence: any real signal other than the liveness probe (signal 0) fails loudly.
const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`headlessTerminalClaim.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

// The store starts a 10 s auto-idle interval on import, so the clock has to be fake first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getAllSessions, getSession, createTerminalSession, setSessionPinned } =
  await import('../server/sessionStore.js');

const TTY = '/dev/ttys049';
const OWNER_PID = 4_000_001; // invented: above the OS pid range, so it can never be a live process
const OBSERVER_PID = 4_000_002;

// One fresh set of ids per test: the store is module state, and a card must not leak into the next case.
let n = 0;
let TERM = '';
let EXMOUTH = '';
let OBSERVER_CWD = '';
let OWNER = '';
let OBSERVER = '';

const hook = (id: string, event: string, extra: Record<string, unknown> = {}) =>
  handleEvent({ session_id: id, hook_event_name: event, cli_source: 'claude', ...extra } as never);

const observerHook = (event: string) =>
  hook(OBSERVER, event, { cwd: OBSERVER_CWD, agent_terminal_id: TERM, tty_path: null, claude_pid: OBSERVER_PID });

const ownerHook = (event: string, extra: Record<string, unknown> = {}) =>
  hook(OWNER, event, { cwd: EXMOUTH, agent_terminal_id: TERM, tty_path: TTY, claude_pid: OWNER_PID, ...extra });

beforeEach(async () => {
  n += 1;
  TERM = `term-aasc10-${n}`;
  EXMOUTH = `/tmp/aasc-10-${n}/exmouth`;
  OBSERVER_CWD = `/tmp/aasc-10-${n}/.claude-mem/observer-sessions`;
  OWNER = `owner-${n}`;
  OBSERVER = `observer-${n}`;
  mocks.broadcast.mockClear();
  mocks.terminateProcessTree.mockReset();
  // A pinned dashboard terminal whose claude has started: the card the user sees.
  await createTerminalSession(TERM, { host: 'localhost', workingDir: EXMOUTH, command: 'claude' });
  ownerHook('SessionStart');
  setSessionPinned(OWNER, true);
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a headless hook that inherited the terminal id (AASC-10)', () => {
  it('leaves the pinned card alive, in place and un-renamed through the whole observer lifecycle', () => {
    expect(getSession(OWNER)?.terminalId).toBe(TERM);

    const results = ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop', 'SessionEnd']
      .map((event) => observerHook(event));

    expect(results.every((r) => r === null)).toBe(true);
    const card = getSession(OWNER);
    expect(card?.status).not.toBe('ended');
    expect(card?.endedAt ?? null).toBeNull();
    expect(card?.projectPath).toBe(EXMOUTH);
    expect(card?.terminalId).toBe(TERM);
    expect(card?.cachedPid).toBe(OWNER_PID);
    expect(card?.pinned).toBe(true);
  });

  it('creates no card of its own', () => {
    const before = Object.keys(getAllSessions()).sort();

    ['SessionStart', 'UserPromptSubmit', 'SessionEnd'].forEach((event) => observerHook(event));

    expect(getSession(OBSERVER)).toBeNull();
    expect(Object.keys(getAllSessions()).sort()).toEqual(before);
    expect(before).toContain(OWNER);
  });

  it('cannot end a card that already carries its session id (the respawn that resumed the observer)', () => {
    // The state the bug left behind: a real agent in the PTY was resumed with the observer's
    // session id (pinnedRespawn did that), so the card now lives under it. claude-mem then keeps
    // resuming the same id from fresh headless processes.
    hook(OBSERVER, 'SessionStart', { cwd: EXMOUTH, agent_terminal_id: TERM, tty_path: TTY, claude_pid: OWNER_PID });
    expect(getSession(OBSERVER)?.terminalId).toBe(TERM);

    expect(observerHook('SessionStart')).toBeNull();
    expect(observerHook('UserPromptSubmit')).toBeNull();
    expect(observerHook('SessionEnd')).toBeNull();

    const card = getSession(OBSERVER);
    expect(card?.status).not.toBe('ended');
    expect(card?.cachedPid).toBe(OWNER_PID); // the observer's pid never got cached onto it
    expect(card?.projectPath).toBe(EXMOUTH);
  });

  it('does not change what the real agent in the PTY does afterwards', () => {
    observerHook('SessionStart');
    observerHook('SessionEnd');

    ownerHook('UserPromptSubmit', { prompt: 'continue' });

    expect(getSession(OWNER)?.status).toBe('prompting');
    expect(getSession(OWNER)?.projectPath).toBe(EXMOUTH);
    expect(mocks.terminateProcessTree).not.toHaveBeenCalled();
  });
});
