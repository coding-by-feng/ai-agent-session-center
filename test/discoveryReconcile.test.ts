// test/discoveryReconcile.test.ts — duplicate-card prevention + reconciliation.
//
// A dashboard-launched agent fires no hook while it waits at a prompt (login,
// trust dialog, or simply idle). The only launch-race guard in
// registerDiscoveredSession was "skip if a CONNECTING session shares this cwd",
// and autoIdleManager flips a placeholder out of CONNECTING after 120s. Past that
// point the 20s process scan saw a live pid with a real tty and no cachedPid owner
// and minted `external-<pid>` — a SECOND card for an agent the dashboard launched
// itself. Observed live on 2026-07-29: 12 duplicate pairs, 9 with byte-identical
// titles (`external-89298 "Verification"` shadowing `term-…667 "Verification"`),
// plus 3 more that Priority 1.5 had already promoted to real session ids.
//
// ppid -> PTY -> session is the one exact ownership signal. cwd is NOT: five
// sessions shared `agent-manager/` on the machine where this was found, so cwd may
// only ever suppress card creation, never bind a pid to a card.
//
// Every fixture here is built through the real production entry points
// (createTerminalSession / registerDiscoveredSession / handleEvent) rather than by
// poking the store's Map, so the suite reproduces the actual failure sequence.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { EVENT_TYPES, SESSION_STATUS } from '../server/constants.js';
import type { Session } from '../src/types/session.js';

/** terminalId -> pty pid, driving the mocked getTerminalByPtyPid. */
const ptyPids = new Map<string, number>();

vi.mock('../server/sshManager.js', () => ({
  getTerminalByPtyPid: (ptyPid: number | null | undefined) => {
    if (!ptyPid || ptyPid <= 0) return null;
    for (const [terminalId, pid] of ptyPids) if (pid === ptyPid) return terminalId;
    return null;
  },
  getTerminalByPtyChild: vi.fn(() => null),
  tryLinkByWorkDir: vi.fn(() => null),
  consumePendingLink: vi.fn(),
  registerTerminalExitCallback: vi.fn(),
  registerTerminalFaultCallback: vi.fn(),
  closeTerminal: vi.fn(),
  getTerminals: vi.fn(() => []),
  getTerminalOutputBuffer: vi.fn(() => null),
  getTerminalOutputTail: vi.fn(() => ''),
  getTerminalForSession: vi.fn(() => null),
}));

// sessionStore imports db.ts at module scope, which opens better-sqlite3. Stub it
// so this suite exercises pure in-memory bookkeeping and stays runnable wherever
// the native module's ABI doesn't match the local Node.
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

vi.mock('../server/wsManager.js', () => ({ broadcast: vi.fn(async () => {}) }));

const {
  registerDiscoveredSession,
  reconcileDiscoveredSessions,
  createTerminalSession,
  handleEvent,
  getAllSessions,
  getSession,
  deleteSessionFromMemory,
} = await import('../server/sessionStore.js');

const PTY_PID = 87554;
const AGENT_PID = 89298;
const TERM = 'term-1785223132667-hzed0c';
const CWD = '/Users/k/Documents/thesis';
const UNOWNED_PPID = 99999;

const proc = (over: Record<string, unknown> = {}) => ({
  pid: AGENT_PID,
  tty: '/dev/ttys001',
  ppid: PTY_PID,
  cwd: CWD,
  name: 'Verification',
  model: 'opus',
  ...over,
});

/** The real path that produces a `term-*` placeholder card. */
function makePlaceholder(terminalId = TERM, workingDir = CWD, sessionTitle = 'Verification') {
  return createTerminalSession(terminalId, {
    host: 'localhost',
    workingDir,
    command: 'claude',
    sessionTitle,
  });
}

function ids(): string[] {
  return Object.keys(getAllSessions() as unknown as Record<string, Session>);
}

function reset(): void {
  for (const id of ids()) deleteSessionFromMemory(id);
  ptyPids.clear();
  vi.clearAllMocks();
}

describe('registerDiscoveredSession — a dashboard-owned pid is bound, never duplicated', () => {
  beforeEach(() => {
    reset();
    ptyPids.set(TERM, PTY_PID);
  });

  it('creates NO card when the agent is a child of one of our PTYs', async () => {
    await makePlaceholder();

    registerDiscoveredSession(proc());

    expect(getSession(`external-${AGENT_PID}`)).toBeNull();
    expect(ids()).toHaveLength(1);
  });

  it('binds the live pid onto the terminal-owning card so it stops looking dead', async () => {
    await makePlaceholder();

    registerDiscoveredSession(proc());

    expect(getSession(TERM)?.cachedPid).toBe(AGENT_PID);
  });

  it('binds even after the placeholder aged out of CONNECTING (the 120s window that opened the bug)', async () => {
    const placeholder = await makePlaceholder();
    // autoIdleManager's pendingResume cleanup does exactly this at 120s.
    const s = getSession(placeholder.sessionId)!;
    s.status = SESSION_STATUS.IDLE as Session['status'];

    registerDiscoveredSession(proc());

    expect(getSession(TERM)?.cachedPid).toBe(AGENT_PID);
    expect(ids()).toHaveLength(1);
  });

  it('clears an external card an earlier pass already minted for that pid', async () => {
    registerDiscoveredSession(proc({ ppid: UNOWNED_PPID })); // pre-fix behaviour
    expect(getSession(`external-${AGENT_PID}`)).toBeDefined();
    await makePlaceholder();

    registerDiscoveredSession(proc()); // now the PTY is identifiable

    expect(getSession(`external-${AGENT_PID}`)).toBeNull();
    expect(getSession(TERM)?.cachedPid).toBe(AGENT_PID);
  });

  it('does not bind onto an ENDED card that still holds the terminal id', async () => {
    await makePlaceholder();
    // SessionEnd keeps terminalId (the PTY shell outlives the agent) but the card
    // must not be resurrected by a stray pid binding.
    handleEvent({
      session_id: TERM,
      hook_event_name: EVENT_TYPES.SESSION_END,
      cwd: CWD,
      reason: 'exit',
    } as Parameters<typeof handleEvent>[0]);
    expect(getSession(TERM)?.status).toBe(SESSION_STATUS.ENDED);

    registerDiscoveredSession(proc());

    expect(getSession(TERM)?.cachedPid).toBeFalsy();
  });

  it('still surfaces a genuinely external agent', () => {
    registerDiscoveredSession(proc({ ppid: UNOWNED_PPID }));

    expect(getSession(`external-${AGENT_PID}`)?.isExternal).toBe(true);
  });

  it('still surfaces an agent whose ppid could not be resolved', () => {
    registerDiscoveredSession(proc({ ppid: null }));

    expect(getSession(`external-${AGENT_PID}`)).toBeDefined();
  });

  it('never binds on a cwd match alone — one directory holds many sessions', async () => {
    await makePlaceholder('term-a', CWD, 'Verification');
    await makePlaceholder('term-b', CWD, 'Thesis Portal');
    await makePlaceholder('term-c', CWD, 'Thesis Reading');

    registerDiscoveredSession(proc({ ppid: UNOWNED_PPID }));

    for (const id of ['term-a', 'term-b', 'term-c']) {
      expect(getSession(id)?.cachedPid).toBeFalsy();
    }
  });
});

describe('reconcileDiscoveredSessions — clears duplicates Priority 1.5 already promoted', () => {
  beforeEach(reset);

  /**
   * Reproduce the live failure end to end:
   *  1. scan mints `external-<pid>` (PTY not yet identifiable)
   *  2. the agent finally fires a hook -> Priority 1.5 promotes it to a real uuid,
   *     so the card loses the `external-` prefix and can no longer self-heal
   *  3. the dashboard's own placeholder for that PTY still exists
   *  4. ownership check binds the pid to the placeholder
   *  -> the promoted card is now a data-free shadow and must be reaped
   */
  async function buildPromotedDuplicate(): Promise<string> {
    registerDiscoveredSession(proc({ ppid: UNOWNED_PPID }));
    handleEvent({
      session_id: 'promoted-uuid',
      hook_event_name: EVENT_TYPES.NOTIFICATION,
      cwd: CWD,
      claude_pid: AGENT_PID,
      tty_path: '/dev/ttys001',
      message: 'Claude Code login successful',
    } as Parameters<typeof handleEvent>[0]);
    await makePlaceholder();
    ptyPids.set(TERM, PTY_PID);
    registerDiscoveredSession(proc());
    return 'promoted-uuid';
  }

  it('reproduces the promoted-orphan shape before reconciling', async () => {
    const orphan = await buildPromotedDuplicate();
    const card = getSession(orphan)!;

    expect(card.terminalId).toBeFalsy();
    expect(card.promptHistory).toHaveLength(0);
    expect(card.totalToolCalls).toBe(0);
    expect(getSession(TERM)?.cachedPid).toBe(AGENT_PID);
  });

  it('drops the shadow and keeps the card that owns the terminal', async () => {
    const orphan = await buildPromotedDuplicate();

    expect(reconcileDiscoveredSessions()).toBe(1);
    expect(getSession(orphan)).toBeNull();
    expect(getSession(TERM)).toBeDefined();
  });

  it('is idempotent — a second pass finds nothing left to do', async () => {
    await buildPromotedDuplicate();
    reconcileDiscoveredSessions();

    expect(reconcileDiscoveredSessions()).toBe(0);
  });

  it('keeps a terminal-less card whose pid no other session claims', () => {
    registerDiscoveredSession(proc({ ppid: UNOWNED_PPID }));

    expect(reconcileDiscoveredSessions()).toBe(0);
    expect(getSession(`external-${AGENT_PID}`)).toBeDefined();
  });

  it('keeps a shadow that carries real prompt history', async () => {
    const orphan = await buildPromotedDuplicate();
    handleEvent({
      session_id: orphan,
      hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
      cwd: CWD,
      prompt: 'real work',
    } as Parameters<typeof handleEvent>[0]);

    expect(reconcileDiscoveredSessions()).toBe(0);
    expect(getSession(orphan)).toBeDefined();
  });

  it('keeps a shadow that carries tool calls', async () => {
    const orphan = await buildPromotedDuplicate();
    handleEvent({
      session_id: orphan,
      hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
      cwd: CWD,
      tool_name: 'Bash',
    } as Parameters<typeof handleEvent>[0]);

    expect(reconcileDiscoveredSessions()).toBe(0);
    expect(getSession(orphan)).toBeDefined();
  });

  it('never drops a card that owns a terminal, even when another session claims its pid', async () => {
    await buildPromotedDuplicate();
    // A second placeholder takes over the pid registration via its own hook, so
    // pidToSession no longer names the first placeholder — which still owns a PTY.
    await makePlaceholder('term-b', CWD, 'Thesis Portal');
    handleEvent({
      session_id: 'term-b',
      hook_event_name: EVENT_TYPES.NOTIFICATION,
      cwd: CWD,
      claude_pid: AGENT_PID,
      message: 'ping',
    } as Parameters<typeof handleEvent>[0]);
    expect(getSession(TERM)?.cachedPid).toBe(AGENT_PID); // still claims it
    expect(getSession(TERM)?.terminalId).toBe(TERM);

    reconcileDiscoveredSessions();

    expect(getSession(TERM)).toBeDefined();
    expect(getSession('term-b')).toBeDefined();
  });

  it('ignores ended cards', async () => {
    const orphan = await buildPromotedDuplicate();
    handleEvent({
      session_id: orphan,
      hook_event_name: EVENT_TYPES.SESSION_END,
      cwd: CWD,
      reason: 'exit',
    } as Parameters<typeof handleEvent>[0]);

    expect(reconcileDiscoveredSessions()).toBe(0);
    expect(getSession(orphan)).toBeDefined();
  });
});
