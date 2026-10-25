/**
 * Hands-off in the real session store (server/sessionStore.ts `setSessionHandsOff`, and the restore path that
 * brings the flag back with a card): the flag is set and cleared on a copy of the card (never edited in place),
 * every window is told with a `session_update`, a re-keyed id still finds the card, and a card created with the
 * flag has it from its first broadcast. Absent means a central may steer the session, so clearing removes the
 * flag instead of writing `false`.
 *
 * Nothing here spawns or signals a process: the store is driven with hook payloads only, the database and the
 * socket manager's broadcast are stand-ins, and process.kill is guarded (known-issues.md: a test must never
 * reach a real process).
 */
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '../../src/types/session.js';
import type { SteerContext } from '../../server/mcp/policy.js';
import type { CentralRecord } from '../../server/mcp/types.js';

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
  throw new Error(`handsOffStore.test must never signal a real process (pid ${pid}, ${String(signal ?? 'SIGTERM')})`);
}) as typeof process.kill);

// The store starts a 10 s auto-idle interval on import, so the clock has to be fake first.
vi.useFakeTimers({ now: 1_800_000_000_000 });
const { createTerminalSession, getAllSessions, getSession, handleEvent, registerSessionAlias, setSessionHandsOff } =
  await import('../../server/sessionStore.js');
const { assertMaySteer } = await import('../../server/mcp/policy.js');
const { ToolError } = await import('../../server/mcp/types.js');

// One fresh card per test: the store is module state, and a card must not leak into the next case.
let n = 0;
let TERM = '';

const hook = (id: string, event: string, extra: Record<string, unknown> = {}) =>
  handleEvent({ session_id: id, hook_event_name: event, cli_source: 'claude', ...extra } as never);

/** What was broadcast as a session_update for this session, oldest first. */
const updatesFor = (sessionId: string) =>
  mocks.broadcast.mock.calls
    .map(([message]) => message as { type: string; session?: { sessionId: string; handsOff?: boolean } })
    .filter((m) => m.type === 'session_update' && m.session?.sessionId === sessionId);

/** Lets the broadcast helper (a dynamic import, then the send) finish. */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(50);
};

beforeEach(async () => {
  n += 1;
  TERM = `term-handsoff-${n}`;
  mocks.broadcast.mockClear();
  await createTerminalSession(TERM, { host: 'localhost', workingDir: `/tmp/handsoff-${n}`, command: 'claude' });
  hook(`card-${n}`, 'SessionStart', {
    cwd: `/tmp/handsoff-${n}`,
    agent_terminal_id: TERM,
    tty_path: `/dev/ttys9${n}`,
    claude_pid: 4_100_000 + n, // invented: above the OS pid range, so it can never be a live process
  });
  // The hook's own (debounced) broadcast is not what these tests look at: let it go out, then forget it.
  await flush();
  mocks.broadcast.mockClear();
});

afterAll(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const card = () => `card-${n}`;

describe('setSessionHandsOff', () => {
  it('sets the flag on the card and answers the card', () => {
    const answered = setSessionHandsOff(card(), true);

    expect(answered?.sessionId).toBe(card());
    expect(answered?.handsOff).toBe(true);
    expect(getSession(card())?.handsOff).toBe(true);
  });

  it('clears it by removing it, so the card is a plain one again (absent means steerable)', () => {
    setSessionHandsOff(card(), true);

    const answered = setSessionHandsOff(card(), false);

    expect(answered).not.toBeNull();
    expect(answered).not.toHaveProperty('handsOff');
    expect(getSession(card())).not.toHaveProperty('handsOff');
  });

  it('is the same state when asked twice', () => {
    setSessionHandsOff(card(), true);
    setSessionHandsOff(card(), true);
    expect(getSession(card())?.handsOff).toBe(true);

    setSessionHandsOff(card(), false);
    setSessionHandsOff(card(), false);
    expect(getSession(card())).not.toHaveProperty('handsOff');
  });

  it('touches nothing else on the card', () => {
    const before = getSession(card());

    setSessionHandsOff(card(), true);
    const after = getSession(card());

    expect({ ...after, handsOff: undefined }).toEqual({ ...before, handsOff: undefined });
  });

  it('answers a copy: changing what it returns changes nothing the store holds', () => {
    const answered = setSessionHandsOff(card(), true);
    if (answered === null) throw new Error('a card was expected');

    answered.handsOff = false;

    expect(getSession(card())?.handsOff).toBe(true);
  });

  it('does not edit the card it replaces: a copy taken before still reads as it did', () => {
    const before = getSession(card());

    setSessionHandsOff(card(), true);

    expect(before).not.toHaveProperty('handsOff');
    expect(getSession(card())?.handsOff).toBe(true);
  });

  it('shows in the snapshot every window is handed (the cached list is dirtied)', () => {
    expect(getAllSessions()[card()]).not.toHaveProperty('handsOff');

    setSessionHandsOff(card(), true);

    expect(getAllSessions()[card()]?.handsOff).toBe(true);
  });

  it('answers null for a session there is none of, and tells nobody', async () => {
    expect(setSessionHandsOff('no-such-session', true)).toBeNull();
    await flush();

    expect(mocks.broadcast).not.toHaveBeenCalled();
  });

  it('follows a re-key: an old id reaches the card it became', () => {
    const OLD = `old-id-${n}`;
    registerSessionAlias(OLD, card());

    const answered = setSessionHandsOff(OLD, true);

    expect(answered?.sessionId).toBe(card());
    expect(getSession(card())?.handsOff).toBe(true);
  });

  describe('tells every window', () => {
    it('with a session_update that carries the flag', async () => {
      setSessionHandsOff(card(), true);
      await flush();

      const updates = updatesFor(card());
      expect(updates).toHaveLength(1);
      expect(updates[0].session?.handsOff).toBe(true);
    });

    it('with a session_update that no longer carries it when it is cleared', async () => {
      setSessionHandsOff(card(), true);
      await flush();
      mocks.broadcast.mockClear();

      setSessionHandsOff(card(), false);
      await flush();

      const updates = updatesFor(card());
      expect(updates).toHaveLength(1);
      expect(updates[0].session).not.toHaveProperty('handsOff');
    });

    it('with a copy: the message does not share the card the store holds', async () => {
      setSessionHandsOff(card(), true);
      await flush();

      const sent = updatesFor(card())[0].session as { handsOff?: boolean };
      sent.handsOff = false;

      expect(getSession(card())?.handsOff).toBe(true);
    });
  });
});

/**
 * The seam between two chunks: the store writes `session.handsOff` (here) and the policy reads it (policy.ts, which
 * every steering tool goes through via `ctx.mayDrive`). Each side is tested alone elsewhere; this joins them on a real
 * card, so a drift in the field's name or meaning on either side cannot leave the rail open without a test saying so.
 */
describe('the policy reads the flag the store writes', () => {
  const central: CentralRecord = {
    centralId: 'central-seam',
    kind: 'global',
    scopeRef: null,
    cli: 'claude',
    permissionMode: null,
    toolsets: [],
    token: '',
    terminalId: 'term-the-central',
    createdAt: 1,
  };
  // Everything else a rail looks at is open, so the flag is the only thing that can refuse.
  const open: SteerContext = {
    inScope: () => true,
    controller: () => null,
    isLocked: () => false,
    isOpsTerminal: () => false,
    now: () => Date.now(),
  };
  /** The code a refusal carries, or null when the central may steer the session. */
  const refusal = (s: Session | null): string | null => {
    if (s === null) throw new Error('a card was expected');
    try {
      assertMaySteer(central, s, open);
      return null;
    } catch (err) {
      if (err instanceof ToolError) return err.code;
      throw err;
    }
  };

  it('a session may be steered until it is marked hands-off, is refused HANDS_OFF while it is, and may be again after', () => {
    expect(refusal(getSession(card()))).toBeNull();

    setSessionHandsOff(card(), true);
    expect(refusal(getSession(card()))).toBe('HANDS_OFF');

    setSessionHandsOff(card(), false);
    expect(refusal(getSession(card()))).toBeNull();
  });

  it('refuses through the snapshot the tools are handed (getAllSessions), not only through getSession', () => {
    setSessionHandsOff(card(), true);

    expect(refusal(getAllSessions()[card()] ?? null)).toBe('HANDS_OFF');
  });

  it('refuses a card that came back from a restore with the flag', async () => {
    const restored = `term-handsoff-seam-${n}`;
    await createTerminalSession(restored, { host: 'localhost', workingDir: `/tmp/handsoff-seam-${n}`, command: 'claude', handsOff: true });
    // A terminal-owned card with no hook yet is still a card the policy looks at: give it what it needs to be steerable.
    expect(getSession(restored)?.handsOff).toBe(true);
    expect(refusal(getSession(restored))).not.toBe('NOT_IN_SCOPE');
    expect(refusal(getSession(restored))).toBe('HANDS_OFF');
  });
});

describe('a card created with the flag (a workspace restore)', () => {
  it('has it from its first broadcast', async () => {
    const restored = `term-handsoff-restored-${n}`;
    mocks.broadcast.mockClear();

    await createTerminalSession(restored, {
      host: 'localhost',
      workingDir: `/tmp/handsoff-restored-${n}`,
      command: 'claude',
      handsOff: true,
    });
    await flush();

    expect(getSession(restored)?.handsOff).toBe(true);
    const first = updatesFor(restored)[0];
    expect(first?.session?.handsOff).toBe(true);
  });

  it('is a plain card when the config has no flag, or has it false', async () => {
    const plain = `term-handsoff-plain-${n}`;
    const off = `term-handsoff-off-${n}`;

    await createTerminalSession(plain, { host: 'localhost', workingDir: `/tmp/handsoff-plain-${n}`, command: 'claude' });
    await createTerminalSession(off, {
      host: 'localhost',
      workingDir: `/tmp/handsoff-off-${n}`,
      command: 'claude',
      handsOff: false,
    });

    expect(getSession(plain)).not.toHaveProperty('handsOff');
    expect(getSession(off)).not.toHaveProperty('handsOff');
  });

  it('gives it to a card that already owns the terminal, when the restore says so', async () => {
    const t = `term-handsoff-late-${n}`;
    await createTerminalSession(t, { host: 'localhost', workingDir: `/tmp/handsoff-late-${n}`, command: 'claude' });
    expect(getSession(t)).not.toHaveProperty('handsOff');

    await createTerminalSession(t, { host: 'localhost', workingDir: `/tmp/handsoff-late-${n}`, command: 'claude', handsOff: true });

    expect(getSession(t)?.handsOff).toBe(true);
  });

  it('keeps the flag when a card that has it is matched with a terminal created again (a re-created terminal)', async () => {
    const t = `term-handsoff-again-${n}`;
    await createTerminalSession(t, { host: 'localhost', workingDir: `/tmp/handsoff-again-${n}`, command: 'claude', handsOff: true });

    await createTerminalSession(t, { host: 'localhost', workingDir: `/tmp/handsoff-again-${n}`, command: 'claude' });

    expect(getSession(t)?.handsOff).toBe(true);
  });
});
