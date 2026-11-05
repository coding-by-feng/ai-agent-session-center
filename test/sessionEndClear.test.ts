/**
 * `/clear` is not a death. Claude Code fires `SessionEnd` (reason `clear`) and, 2–5 s later, a
 * `SessionStart` with a new session id from the SAME process in the SAME terminal. Marking the
 * card ended on that SessionEnd made pinnedRespawn (2 s backoff) relaunch the old conversation in
 * a new terminal before the SessionStart revived the original card: one duplicate pinned card per
 * `/clear` (Nov 5 2026: three /clears → four "AASC Enhancement" cards).
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

const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`sessionEndClear.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

vi.useFakeTimers({ now: 1_800_000_000_000 });
const { handleEvent, getAllSessions, getSession, createTerminalSession, setSessionPinned } =
  await import('../server/sessionStore.js');

const TTY = '/dev/ttys055';
const PID = 4_000_101; // invented: above the OS pid range

let n = 0;
let TERM = '';
let CWD = '';
let BEFORE = '';
let AFTER = '';

const hook = (id: string, event: string, extra: Record<string, unknown> = {}) =>
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cli_source: 'claude',
    cwd: CWD,
    agent_terminal_id: TERM,
    tty_path: TTY,
    claude_pid: PID,
    ...extra,
  } as never);

const cardsInTerminal = () => Object.values(getAllSessions()).filter((s) => s.terminalId === TERM);

beforeEach(async () => {
  n += 1;
  TERM = `term-clear-${n}`;
  CWD = `/tmp/session-end-clear-${n}`;
  BEFORE = `before-clear-${n}`;
  AFTER = `after-clear-${n}`;
  mocks.broadcast.mockClear();
  await createTerminalSession(TERM, { host: 'localhost', workingDir: CWD, command: 'claude' });
  hook(BEFORE, 'SessionStart');
  hook(BEFORE, 'UserPromptSubmit', { prompt: 'hello' });
  hook(BEFORE, 'Stop');
  setSessionPinned(BEFORE, true);
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionEnd with reason "clear"', () => {
  it('does not end the card (so a pinned card is never respawned)', () => {
    hook(BEFORE, 'SessionEnd', { reason: 'clear' });

    const card = getSession(BEFORE);
    expect(card?.status).toBe('idle');
    expect(card?.endedAt ?? null).toBeNull();
    expect(card?.animationState).not.toBe('Death');
    expect(card?.cachedPid).toBe(PID); // the process monitor still catches a real death
    expect(card?.pinned).toBe(true);
    const endedBroadcast = mocks.broadcast.mock.calls.some(
      ([msg]) => (msg as { session?: { sessionId?: string; status?: string } })?.session?.sessionId === BEFORE
        && (msg as { session?: { status?: string } }).session?.status === 'ended',
    );
    expect(endedBroadcast).toBe(false);
  });

  it('lets the following SessionStart re-key the same card: one terminal, one card', () => {
    hook(BEFORE, 'SessionEnd', { reason: 'clear' });
    // The window pinnedRespawn's 2 s backoff used to fire in: the card must not read as ended.
    expect(getSession(BEFORE)?.status).not.toBe('ended');
    hook(AFTER, 'SessionStart', { source: 'clear' });

    // getSession follows aliases (BEFORE → AFTER), so check the store's own keys.
    expect(Object.keys(getAllSessions())).not.toContain(BEFORE);
    const card = getSession(AFTER);
    expect(card?.terminalId).toBe(TERM);
    expect(card?.pinned).toBe(true);
    expect(card?.status).not.toBe('ended');
    expect(cardsInTerminal()).toHaveLength(1);
  });

  it.each(['other', 'logout', 'prompt_input_exit', undefined])('still ends the card for reason %s', (reason) => {
    hook(BEFORE, 'SessionEnd', reason === undefined ? {} : { reason });

    const card = getSession(BEFORE);
    expect(card?.status).toBe('ended');
    expect(card?.endedAt).toBeTypeOf('number');
  });
});
