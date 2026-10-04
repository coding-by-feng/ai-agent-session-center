/**
 * Status changes the server makes on its own clock — auto-idle, the approval timer — reaching the
 * browsers through the real session store.
 *
 * Those changes are not driven by a hook event, so nothing used to tell a client or dirty the
 * snapshot cache behind `getAllSessions()` (which holds COPIES of the sessions). A badge showed
 * "waiting" or "working" until the next hook event; a reload or reconnect was served the same stale
 * copy. Fake timers: the intervals in question are 10 s ticks and the waits are minutes long.
 */
import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';

const ws = vi.hoisted(() => ({ broadcast: vi.fn() }));

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
  return { ...mod, broadcast: ws.broadcast };
});

// Fifteen simulated minutes would otherwise run the 20 s process scan 45 times against the real `ps`.
vi.mock('../server/processMonitor.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../server/processMonitor.js')>();
  return {
    ...mod,
    startMonitoring: vi.fn(),
    stopMonitoring: vi.fn(),
    startExternalDiscovery: vi.fn(),
  };
});

// The store starts its 10 s auto-idle interval when it is imported, so the clock has to be fake first.
const T0 = 1_800_000_000_000;
vi.useFakeTimers({ now: T0 });
const { handleEvent, getAllSessions, getSession, createTerminalSession } = await import('../server/sessionStore.js');

const MIN = 60_000;

let n = 0;
/** A session the hook path really creates (a controlling tty is what makes an unknown card real). */
function hook(id: string, event: string, extra: Record<string, unknown> = {}): void {
  handleEvent({
    session_id: id,
    hook_event_name: event,
    cwd: `/tmp/auto-idle-${id}`,
    tty_path: `/dev/ttys9${String(n).padStart(2, '0')}`,
    cli_source: 'claude',
    ...extra,
  } as never);
}
const newSession = (): string => { n += 1; const id = `ai-${n}`; hook(id, 'SessionStart'); return id; };
const statusOf = (id: string) => getSession(id)?.status;
const sentStatuses = (id: string): string[] =>
  ws.broadcast.mock.calls
    .map(([m]) => m as { type?: string; session?: { sessionId?: string; status?: string } })
    .filter((m) => m.type === 'session_update' && m.session?.sessionId === id)
    .map((m) => m.session!.status as string);

beforeEach(() => {
  ws.broadcast.mockClear();
});

afterAll(() => {
  vi.useRealTimers();
});

describe('auto-idle in the session store', () => {
  it('tells every client when a finished session goes idle, and serves the new status in snapshots', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'do the thing' });
    hook(id, 'Stop');
    expect(statusOf(id)).toBe('waiting');
    expect(getAllSessions()[id].status).toBe('waiting'); // primes the snapshot cache the change must dirty
    ws.broadcast.mockClear();

    await vi.advanceTimersByTimeAsync(5 * MIN + 15_000); // waiting → idle at the next 10 s tick

    expect(statusOf(id)).toBe('idle');
    expect(getAllSessions()[id].status).toBe('idle'); // a reload or reconnect is not served the old copy
    await vi.waitFor(() => expect(sentStatuses(id)).toContain('idle')); // and the browsers already connected are told
  });

  it('does the same for a prompt that never ran (prompting → waiting after 30 s of silence)', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'blocked by a hook' });
    expect(getAllSessions()[id].status).toBe('prompting');
    ws.broadcast.mockClear();

    await vi.advanceTimersByTimeAsync(45_000);

    expect(statusOf(id)).toBe('waiting');
    expect(getAllSessions()[id].status).toBe('waiting');
    await vi.waitFor(() => expect(sentStatuses(id)).toContain('waiting'));
  });

  it('sends one update per changed session, nothing for a session that did not change', async () => {
    const a = newSession();
    const b = newSession();
    for (const id of [a, b]) { hook(id, 'UserPromptSubmit', { prompt: 'x' }); hook(id, 'Stop'); }
    const still = newSession();
    hook(still, 'UserPromptSubmit', { prompt: 'x' });
    hook(still, 'PreToolUse', { tool_name: 'Edit', tool_input: { file_path: '/tmp/x' } }); // working, no PostToolUse
    ws.broadcast.mockClear();

    await vi.advanceTimersByTimeAsync(5 * MIN + 15_000);

    await vi.waitFor(() => expect(sentStatuses(b)).toContain('idle'));
    expect(sentStatuses(a).filter((s) => s === 'idle')).toHaveLength(1);
    expect(sentStatuses(b).filter((s) => s === 'idle')).toHaveLength(1);
    expect(sentStatuses(still).filter((s) => s === 'idle')).toHaveLength(0);
  });
});

/**
 * The approval timer already broadcast — but it never dirtied the snapshot cache, so a client that
 * connected just after saw the session as "working" while everyone else saw "approval".
 */
describe('approval timer in the session store', () => {
  it('a session that flips to approval is also "approval" in the next snapshot', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'x' });
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    expect(getAllSessions()[id].status).toBe('working'); // primes the snapshot cache
    ws.broadcast.mockClear();

    await vi.advanceTimersByTimeAsync(3_000); // a fast tool with no PostToolUse is waiting on you after 3 s

    // The timer has fired but the broadcast's 20 ms debounce has not: a snapshot read right now (a client
    // connecting this instant) must already be current, which only dirtying the cache up front achieves.
    expect(statusOf(id)).toBe('approval');
    expect(getAllSessions()[id].status).toBe('approval');

    await vi.advanceTimersByTimeAsync(100);
    await vi.waitFor(() => expect(sentStatuses(id)).toContain('approval'));
  });
});

/**
 * An approval nobody has answered for ten minutes is the common case of "the user stepped away", not a
 * lost hook. The server's safety net still flips it to idle internally, but telling the browsers would
 * turn the "!" badge into "Idle" (hiding the request) and make the queue's next prompt sendable into the
 * permission dialog. So it must stay off the wire.
 */
describe('the safety-net decays', () => {
  it('an unanswered approval is not announced as idle after ten minutes', async () => {
    const id = newSession();
    hook(id, 'UserPromptSubmit', { prompt: 'x' });
    hook(id, 'PreToolUse', { tool_name: 'Read', tool_input: { file_path: '/tmp/x' } });
    await vi.advanceTimersByTimeAsync(3_100);
    expect(statusOf(id)).toBe('approval');
    await vi.waitFor(() => expect(sentStatuses(id)).toContain('approval'));
    ws.broadcast.mockClear();

    await vi.advanceTimersByTimeAsync(11 * MIN);

    expect(statusOf(id)).toBe('idle'); // the server's own bookkeeping still moves on
    await vi.advanceTimersByTimeAsync(200);
    expect(sentStatuses(id)).not.toContain('idle'); // …but the browsers are not told
  });
});

/**
 * Paths that broadcast through `broadcastAsync` directly (process exit, resume timeout, this one):
 * the cache has to be dirtied by the broadcast itself, because they have no other step that does it.
 */
describe('a card that gives up connecting', () => {
  it('is "idle" in the next snapshot as well as on the wire', async () => {
    n += 1;
    const id = `ai-conn-${n}`;
    await createTerminalSession(id, { host: 'localhost', workingDir: `/tmp/auto-idle-${id}`, command: 'claude' });
    expect(getAllSessions()[id].status).toBe('connecting'); // primes the snapshot cache
    ws.broadcast.mockClear();

    await vi.advanceTimersByTimeAsync(31_000); // Claude gets 30 s for its SessionStart hook

    expect(statusOf(id)).toBe('idle');
    expect(getAllSessions()[id].status).toBe('idle');
    await vi.waitFor(() => expect(sentStatuses(id)).toContain('idle'));
  });
});

