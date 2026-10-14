// test/sessionMatcher.headless.test.ts — AASC-10: an inherited AGENT_MANAGER_TERMINAL_ID is
// not ownership of that terminal.
//
// claude-mem's worker daemon was started from inside a dashboard terminal, so every
// observer `claude` it spawns (cwd ~/.claude-mem/observer-sessions, no controlling tty,
// SessionStart -> UserPromptSubmit -> SessionEnd in ~2 s) carries that terminal's id.
// Priority 1b re-keyed the terminal's card onto the observer's session id, the observer's
// SessionEnd ended the (pinned) card, and pinnedRespawn relaunched it — one new
// "Exmouth Research" terminal a minute.
//
// dashboard-hook.sh reports a process with no controlling tty as `tty_path: null`
// (explicit). A hook that says so can never be the agent living in a PTY, so its terminal
// id must claim nothing. A hook that omits `tty_path` (Windows, old hooks) is unchanged.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchSession } from '../server/sessionMatcher.js';
import { EVENT_TYPES, SESSION_STATUS, ANIMATION_STATE } from '../server/constants.js';
import type { Session, PendingResume } from '../src/types/session.js';
import type { HookPayloadBase } from '../src/types/hook.js';

vi.mock('../server/sshManager.js', () => ({
  tryLinkByWorkDir: vi.fn().mockReturnValue(null),
  getTerminalByPtyChild: vi.fn().mockReturnValue(null),
  consumePendingLink: vi.fn(),
  registerTerminalExitCallback: vi.fn(),
  closeTerminal: vi.fn(),
  getTerminals: vi.fn(() => []),
  getTerminalOutputBuffer: vi.fn(() => null),
}));

const TERM = 'term-1791834797747-y7ltcf';
const EXMOUTH = '/Users/kasonzhan/Documents/exmouth';
const OBSERVER_CWD = '/Users/kasonzhan/.claude-mem/observer-sessions';
const OWNER_ID = '8991bde3-7f9d-4c6c-964e-000000000000';
const OBSERVER_ID = 'e84da767-0000-4000-8000-000000000000';
const TTY = '/dev/ttys049';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-default',
    projectPath: EXMOUTH,
    projectName: 'exmouth',
    title: '',
    status: SESSION_STATUS.IDLE as Session['status'],
    animationState: ANIMATION_STATE.IDLE as Session['animationState'],
    emote: null,
    startedAt: Date.now(),
    lastActivityAt: Date.now(),
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    model: '',
    subagentCount: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    archived: 0,
    source: 'ssh',
    pendingTool: null,
    waitingDetail: null,
    cachedPid: null,
    queueCount: 0,
    terminalId: null,
    ...overrides,
  };
}

/** The pinned "Exmouth Research" card that owns the terminal the daemon was started in. */
function pinnedOwner(overrides: Partial<Session> = {}): Session {
  return makeSession({
    sessionId: OWNER_ID,
    title: 'Exmouth Research',
    pinned: true,
    terminalId: TERM,
    lastTerminalId: TERM,
    cachedPid: 1948,
    ...overrides,
  });
}

describe('matchSession — a headless hook with an inherited terminal id claims nothing (AASC-10)', () => {
  let sessions: Map<string, Session>;
  let pendingResume: Map<string, PendingResume>;
  let pidToSession: Map<number, string>;
  let projectCounters: Map<string, number>;

  /** An observer hook: another process, its own cwd, the daemon's terminal id, no tty. */
  const observer = (
    event: string,
    extra: Partial<HookPayloadBase> = {},
  ): Partial<HookPayloadBase> => ({
    session_id: OBSERVER_ID,
    hook_event_name: event,
    cwd: OBSERVER_CWD,
    agent_terminal_id: TERM,
    tty_path: null,
    claude_pid: 8397,
    ...extra,
  });

  const run = (payload: Partial<HookPayloadBase>) =>
    matchSession(
      {
        session_id: OBSERVER_ID,
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: EXMOUTH,
        agent_terminal_id: TERM,
        tty_path: TTY,
        ...payload,
      } as HookPayloadBase,
      sessions,
      pendingResume,
      pidToSession,
      projectCounters,
    );

  beforeEach(() => {
    sessions = new Map();
    pendingResume = new Map();
    pidToSession = new Map();
    projectCounters = new Map();
    vi.clearAllMocks();
  });

  it('replays the observer lifecycle without touching the terminal owner', () => {
    sessions.set(OWNER_ID, pinnedOwner());
    const before = structuredClone(sessions.get(OWNER_ID));

    const results = [
      run(observer(EVENT_TYPES.SESSION_START)),
      run(observer(EVENT_TYPES.USER_PROMPT_SUBMIT)),
      run(observer(EVENT_TYPES.PRE_TOOL_USE)),
      run(observer(EVENT_TYPES.SESSION_END)),
    ];

    expect(results).toEqual([null, null, null, null]);
    // Same key, same object content: not re-keyed, re-pathed, renamed or ended.
    expect([...sessions.keys()]).toEqual([OWNER_ID]);
    expect(sessions.get(OWNER_ID)).toEqual(before);
    expect(sessions.get(OWNER_ID)?.projectPath).toBe(EXMOUTH);
    expect(sessions.get(OWNER_ID)?.title).toBe('Exmouth Research');
    expect(sessions.get(OWNER_ID)?.pinned).toBe(true);
  });

  it('does not map the observer pid onto the owner', () => {
    sessions.set(OWNER_ID, pinnedOwner());

    run(observer(EVENT_TYPES.SESSION_START));

    expect(pidToSession.has(8397)).toBe(false);
  });

  it('does not adopt an ended owner (Priority 4.5) on a non-start event', () => {
    sessions.set(
      OWNER_ID,
      pinnedOwner({
        status: SESSION_STATUS.ENDED as Session['status'],
        endedAt: Date.now(),
        isHistorical: true,
      }),
    );

    const result = run(observer(EVENT_TYPES.PRE_TOOL_USE));

    expect(result).toBeNull();
    expect(sessions.get(OWNER_ID)?.status).toBe(SESSION_STATUS.ENDED);
    expect(sessions.has(OBSERVER_ID)).toBe(false);
  });

  it('does not consume a pre-created terminal placeholder (Priority 1)', () => {
    sessions.set(TERM, makeSession({ sessionId: TERM, terminalId: TERM, status: SESSION_STATUS.CONNECTING as Session['status'] }));

    const result = run(observer(EVENT_TYPES.SESSION_START));

    expect(result).toBeNull();
    expect(sessions.has(TERM)).toBe(true);
    expect(sessions.has(OBSERVER_ID)).toBe(false);
  });

  it('does not consume a pending resume registered for the terminal (Priority 0)', () => {
    sessions.set(OWNER_ID, pinnedOwner());
    pendingResume.set(TERM, { oldSessionId: OWNER_ID, timestamp: Date.now() });

    const result = run(observer(EVENT_TYPES.SESSION_START));

    expect(result).toBeNull();
    expect(pendingResume.has(TERM)).toBe(true);
    expect(sessions.has(OWNER_ID)).toBe(true);
  });

  it('does not steal a restart-ended card by directory (Priority 0.5) even from the same cwd', () => {
    sessions.set(
      OWNER_ID,
      // No terminal on the card at all, so Priority 1b/4.5 cannot be what catches it.
      pinnedOwner({
        terminalId: null,
        lastTerminalId: null,
        status: SESSION_STATUS.ENDED as Session['status'],
        endedAt: Date.now(),
        events: [{ type: 'ServerRestart', timestamp: Date.now(), detail: 'restart' }],
      }),
    );

    const result = run(observer(EVENT_TYPES.SESSION_START, { cwd: EXMOUTH }));

    expect(result).toBeNull();
    expect(sessions.has(OWNER_ID)).toBe(true);
    expect(sessions.has(OBSERVER_ID)).toBe(false);
  });

  it('ignores a headless process that reuses the session id of a card already in the store', () => {
    // What the saved snapshot holds after the bug ran once: the pinned card was re-keyed onto
    // the observer's id and ended. claude-mem keeps resuming that one id from fresh processes.
    const polluted = pinnedOwner({
      sessionId: OBSERVER_ID,
      projectPath: OBSERVER_CWD,
      status: SESSION_STATUS.ENDED as Session['status'],
      endedAt: Date.now(),
      isHistorical: true,
      cachedPid: 7454, // an earlier observer process
    });
    sessions.set(OBSERVER_ID, polluted);
    pidToSession.set(7454, OBSERVER_ID);
    const before = structuredClone(polluted);

    const results = [
      run(observer(EVENT_TYPES.SESSION_START, { claude_pid: 8397 })),
      run(observer(EVENT_TYPES.SESSION_END, { claude_pid: 8397 })),
    ];

    expect(results).toEqual([null, null]);
    expect(sessions.get(OBSERVER_ID)).toEqual(before);
    expect(pidToSession.has(8397)).toBe(false);
    expect(pidToSession.get(7454)).toBe(OBSERVER_ID);
  });

  describe('a hook from the card\'s own process is not an inherited claim', () => {
    // The agent in the PTY, whose hook lost its tty (ps failed or the parent was already
    // exiting). Its pid is already bound to the card that owns the terminal.
    const ownProcess = (event: string, extra: Partial<HookPayloadBase> = {}) =>
      observer(event, { session_id: 'new-real-id', cwd: EXMOUTH, claude_pid: 1948, ...extra });

    beforeEach(() => {
      sessions.set(OWNER_ID, pinnedOwner());
      pidToSession.set(1948, OWNER_ID);
    });

    it('still reaches the card stored under its own session id', () => {
      const result = run(ownProcess(EVENT_TYPES.SESSION_END, { session_id: OWNER_ID }));

      expect(result?.sessionId).toBe(OWNER_ID);
    });

    it('still re-keys the owner onto a new session id in the same process (Priority 1b)', () => {
      const result = run(ownProcess(EVENT_TYPES.SESSION_START));

      expect(result?.sessionId).toBe('new-real-id');
      expect(result?.title).toBe('Exmouth Research');
    });

    it('a pid bound to a card on ANOTHER terminal earns nothing', () => {
      sessions.set('other-card', makeSession({ sessionId: 'other-card', terminalId: 'term-other', lastTerminalId: 'term-other' }));
      pidToSession.set(8397, 'other-card');

      expect(run(observer(EVENT_TYPES.SESSION_START, { claude_pid: 8397 }))).toBeNull();
      expect(sessions.has(OWNER_ID)).toBe(true);
    });
  });

  it('keeps Codex\'s startup-like UserPromptSubmit working for the same process, and refuses a stranger', () => {
    sessions.set(OWNER_ID, pinnedOwner({ cliSource: 'codex', cachedPid: 4321 }));
    pidToSession.set(4321, OWNER_ID);
    const codexPrompt = (pid: number) =>
      run({
        session_id: 'codex-thread-2',
        hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT,
        cli_source: 'codex',
        tty_path: null,
        claude_pid: pid,
      });

    expect(codexPrompt(5555)).toBeNull(); // a Codex helper that inherited the terminal id
    expect(sessions.has('codex-thread-2')).toBe(false);

    expect(codexPrompt(4321)?.sessionId).toBe('codex-thread-2'); // the card's own process
    expect(sessions.has(OWNER_ID)).toBe(false);
  });

  it('leaves a headless hook with no terminal id on the existing path (dropped by Priority 5)', () => {
    sessions.set(OWNER_ID, pinnedOwner());

    const result = run(observer(EVENT_TYPES.PRE_TOOL_USE, { agent_terminal_id: undefined }));

    expect(result).toBeNull();
    expect(sessions.get(OWNER_ID)?.projectPath).toBe(EXMOUTH);
  });

  describe('compatibility: a real agent in the PTY keeps matching', () => {
    it('a tty-bearing SessionStart still re-keys the owner (Priority 1b)', () => {
      sessions.set(OWNER_ID, pinnedOwner());

      const result = run({ session_id: 'new-real-id', hook_event_name: EVENT_TYPES.SESSION_START, tty_path: TTY });

      expect(result?.sessionId).toBe('new-real-id');
      expect(result?.title).toBe('Exmouth Research');
      expect(sessions.has(OWNER_ID)).toBe(false);
    });

    it('a hook that omits tty_path (Windows hook, older installs) still re-keys the owner', () => {
      sessions.set(OWNER_ID, pinnedOwner());
      const hook = { session_id: 'new-real-id', hook_event_name: EVENT_TYPES.SESSION_START, cwd: EXMOUTH, agent_terminal_id: TERM } as HookPayloadBase;

      const result = matchSession(hook, sessions, pendingResume, pidToSession, projectCounters);

      expect(result?.sessionId).toBe('new-real-id');
      expect(result?.title).toBe('Exmouth Research');
    });

    it('a tty-bearing non-start event still adopts the sole owner (Priority 4.5)', () => {
      sessions.set(OWNER_ID, pinnedOwner({ status: SESSION_STATUS.ENDED as Session['status'], endedAt: Date.now() }));

      const result = run({ session_id: 'new-real-id', hook_event_name: EVENT_TYPES.PRE_TOOL_USE, tty_path: TTY });

      expect(result?.sessionId).toBe('new-real-id');
      expect(result?.terminalId).toBe(TERM);
    });
  });
});
