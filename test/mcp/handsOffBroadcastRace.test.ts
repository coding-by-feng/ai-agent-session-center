/**
 * The hands-off switch against the two queues that can still hold an OLDER copy of a card when it is flipped
 * (Ruling 55, review finding C-I1). The store broadcasts the flipped card at once, and the client replaces a whole
 * card with each update, so an older copy that goes out afterwards puts the old flag back on every window:
 *
 *   - a hook update waits out hookProcessor's 250 ms throttle holding the copy `handleEvent` made;
 *   - the approval timer and the auto-idle sweep queue a copy for sessionStore's 20 ms batch.
 *
 * Both go through the real modules here (the hook pipeline, the store, the setter the dashboard's route is handed),
 * with only the database, the socket manager's broadcast and the process monitor as stand-ins, under fake timers.
 * Nothing spawns or signals a process: process.kill is guarded (known-issues.md: a test must never reach one).
 *
 * Each case clears the broadcast log just before the flip, so what it looks at is what went out AFTER the flip.
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ broadcast: vi.fn() }));

vi.mock('../../server/db.js', () => ({
  upsertSession: vi.fn(),
  updateSessionTitle: vi.fn(),
  updateSessionSummary: vi.fn(),
  updateSessionRemark: vi.fn(),
  updateSessionArchived: vi.fn(),
  migrateSessionId: vi.fn(),
  getPromptsForSession: vi.fn(() => []),
  insertFullPrompt: vi.fn(),
}));

vi.mock('../../server/wsManager.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/wsManager.js')>();
  return { ...mod, broadcast: mocks.broadcast };
});

vi.mock('../../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
    terminateProcessTree: vi.fn(),
  };
});

// Second line of defence: any real signal other than the liveness probe (signal 0) fails loudly.
const realProcessKill = process.kill.bind(process);
vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: string | number) => {
  if (signal === 0) return realProcessKill(pid, 0);
  throw new Error(`handsOffBroadcastRace.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

// The store starts a 10 s auto-idle interval on import, so the clock has to be fake first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { createTerminalSession, getSession, handleEvent, setSessionHandsOff } = await import('../../server/sessionStore.js');
const { processHookEvent, refreshPendingSessionUpdate } = await import('../../server/hookProcessor.js');
const { createHandsOffSetter } = await import('../../server/mcp/handsOffSetter.js');

/** The setter exactly as server/index.ts hands it to the dashboard's router. */
const setHandsOff = createHandsOffSetter(setSessionHandsOff, refreshPendingSessionUpdate);

type Update = {
  type: string;
  session?: { sessionId: string; handsOff?: boolean; status?: string; replacesId?: string };
};

let n = 0;
let TERM = '';
const card = () => `card-${n}`;

/** A hook payload the way the pipeline takes it. */
const hookPayload = (id: string, event: string, extra: Record<string, unknown> = {}) =>
  ({ session_id: id, hook_event_name: event, cli_source: 'claude', ...extra }) as never;

/** What was broadcast as a session_update for this session since the log was last cleared, oldest first. */
const updatesFor = (sessionId: string): Update[] =>
  mocks.broadcast.mock.calls
    .map(([message]) => message as Update)
    .filter((m) => m.type === 'session_update' && m.session?.sessionId === sessionId);

const carriesFlag = (u: Update): boolean => u.session?.handsOff === true;
const carriesNoFlag = (u: Update): boolean => !('handsOff' in (u.session ?? {}));

/** Lets the broadcast helpers (a dynamic import, then the send) and the 20 ms batch finish. */
const settle = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(300);
};

beforeEach(async () => {
  n += 1;
  TERM = `term-race-${n}`;
  await createTerminalSession(TERM, { host: 'localhost', workingDir: `/tmp/race-${n}`, command: 'claude' });
  handleEvent(
    hookPayload(card(), 'SessionStart', {
      cwd: `/tmp/race-${n}`,
      agent_terminal_id: TERM,
      tty_path: `/dev/ttys7${n}`,
      claude_pid: 4_200_000 + n, // invented: above the OS pid range, so it can never be a live process
    }),
  );
  await settle();
  mocks.broadcast.mockClear();
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('a hook update held in its 250 ms throttle when the switch is flipped', () => {
  it('a held hook update after a hands-off flip carries the flag', async () => {
    processHookEvent(hookPayload(card(), 'Stop')); // its copy of the card is held for 250 ms
    await vi.advanceTimersByTimeAsync(100);
    mocks.broadcast.mockClear();

    setHandsOff(card(), true);
    await vi.advanceTimersByTimeAsync(150); // t0 + 250: the held update goes out

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    // Every window ends on a card that says hands-off, and no update after the flip says otherwise.
    expect(carriesFlag(updates.at(-1) as Update)).toBe(true);
    expect(updates.every(carriesFlag)).toBe(true);
    // The held update is still the hook's: the status it set is not lost to the refresh.
    expect(updates.at(-1)?.session?.status).toBe('waiting');
    expect(getSession(card())?.handsOff).toBe(true);
  });

  it('a held hook update after the flag is cleared carries no flag', async () => {
    setHandsOff(card(), true);
    await settle();
    processHookEvent(hookPayload(card(), 'Stop')); // held with a card that is hands-off
    await vi.advanceTimersByTimeAsync(100);
    mocks.broadcast.mockClear();

    setHandsOff(card(), false);
    await vi.advanceTimersByTimeAsync(150);

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(carriesNoFlag)).toBe(true);
    expect(getSession(card())).not.toHaveProperty('handsOff');
  });

  it('keeps the flag when a second hook lands after the flip while the first is still held', async () => {
    processHookEvent(hookPayload(card(), 'Stop'));
    await vi.advanceTimersByTimeAsync(50);
    mocks.broadcast.mockClear();
    setHandsOff(card(), true);
    await vi.advanceTimersByTimeAsync(50);

    processHookEvent(hookPayload(card(), 'UserPromptSubmit', { prompt: 'go on' }));
    await vi.advanceTimersByTimeAsync(300);

    const updates = updatesFor(card());
    expect(updates.every(carriesFlag)).toBe(true);
    // The second hook's own state is what the windows end on.
    expect(updates.at(-1)?.session?.status).toBe('prompting');
  });

  it('keeps the re-key marker of the held update, which a window migrates its card by', async () => {
    const T2 = `term-race-second-${n}`;
    const second = `card-second-${n}`;
    await createTerminalSession(T2, { host: 'localhost', workingDir: `/tmp/race-second-${n}`, command: 'claude' });
    // The terminal's first hook re-keys its card from the terminal id to the session id: the update carries replacesId.
    processHookEvent(
      hookPayload(second, 'SessionStart', {
        cwd: `/tmp/race-second-${n}`,
        agent_terminal_id: T2,
        tty_path: `/dev/ttys6${n}`,
        claude_pid: 4_300_000 + n,
      }),
    );
    await vi.advanceTimersByTimeAsync(100);
    mocks.broadcast.mockClear();

    setHandsOff(T2, true); // the old id still reaches the card it became
    await vi.advanceTimersByTimeAsync(150);

    const last = updatesFor(second).at(-1);
    expect(last?.session?.handsOff).toBe(true);
    expect(last?.session?.replacesId).toBe(T2);
  });

  it('touches nothing when there is no such session', async () => {
    processHookEvent(hookPayload(card(), 'Stop'));
    mocks.broadcast.mockClear();

    expect(setHandsOff('no-such-session', true)).toBeNull();
    await vi.advanceTimersByTimeAsync(300);

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(carriesNoFlag)).toBe(true);
  });
});

describe('a copy waiting in the 20 ms batch when the switch is flipped', () => {
  /** A Read the session never hears back about: after its 3 s timeout the approval timer marks the card "approval". */
  const armApprovalTimer = (id: string): void => {
    handleEvent(hookPayload(id, 'UserPromptSubmit', { prompt: 'go' }));
    handleEvent(
      hookPayload(id, 'PreToolUse', {
        tool_name: 'Read',
        tool_input: { file_path: '/tmp/race.txt' },
        permission_mode: 'default',
      }),
    );
  };

  /** Runs the clock to the instant the timers fire: each queues its card's copy for the batch, which waits 20 ms. */
  const runToTimers = async (): Promise<void> => {
    await vi.advanceTimersByTimeAsync(3_000);
  };

  it('a debounced batch after the flip carries the flag', async () => {
    armApprovalTimer(card());
    await runToTimers();
    expect(getSession(card())?.status).toBe('approval');
    mocks.broadcast.mockClear();

    setHandsOff(card(), true);
    await settle();

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    expect(carriesFlag(updates.at(-1) as Update)).toBe(true);
    expect(updates.every(carriesFlag)).toBe(true);
    // Nothing is lost by it: the card the flip sent already holds what the timer changed.
    expect(updates.at(-1)?.session?.status).toBe('approval');
  });

  it('a debounced batch after the flag is cleared carries no flag', async () => {
    setHandsOff(card(), true);
    await settle();
    armApprovalTimer(card());
    await runToTimers();
    expect(getSession(card())?.status).toBe('approval');
    mocks.broadcast.mockClear();

    setHandsOff(card(), false);
    await settle();

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(carriesNoFlag)).toBe(true);
  });

  it('drops the copy when the flip names the card by an old id (the terminal id it was re-keyed from)', async () => {
    armApprovalTimer(card());
    await runToTimers();
    mocks.broadcast.mockClear();

    setHandsOff(TERM, true);
    await settle();

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(carriesFlag)).toBe(true);
    expect(getSession(card())?.handsOff).toBe(true);
  });

  it('a copy queued after the flip carries the flag', async () => {
    armApprovalTimer(card());
    await vi.advanceTimersByTimeAsync(500);
    setHandsOff(card(), true);
    mocks.broadcast.mockClear();

    await runToTimers(); // the approval timer fires after the flip

    const updates = updatesFor(card());
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.every(carriesFlag)).toBe(true);
    expect(updates.at(-1)?.session?.status).toBe('approval');
  });

  it('leaves the copies of other sessions in the batch alone', async () => {
    const other = `card-other-${n}`;
    handleEvent(hookPayload(other, 'SessionStart', { cwd: `/tmp/race-other-${n}`, tty_path: `/dev/ttys5${n}` }));
    // Both timers are armed at the same instant, so both copies wait in the same batch.
    armApprovalTimer(card());
    armApprovalTimer(other);
    await runToTimers();
    expect(getSession(card())?.status).toBe('approval');
    expect(getSession(other)?.status).toBe('approval');
    mocks.broadcast.mockClear();

    setHandsOff(card(), true);
    await settle();

    expect(updatesFor(card()).every(carriesFlag)).toBe(true);
    const others = updatesFor(other);
    expect(others.length).toBeGreaterThan(0);
    expect(others.every(carriesNoFlag)).toBe(true);
    expect(others.at(-1)?.session?.status).toBe('approval');
  });
});
