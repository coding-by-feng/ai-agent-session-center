// test/sessionMatcher.ttyNullPath.test.ts — AASC-59: a hook that reports no controlling tty
// never binds a dashboard terminal by its folder.
//
// AASC-10 stopped a tty-less hook from claiming a terminal by an inherited terminal id. The
// directory-based priorities were still open to one: Priority 0's path fallback, 0.5, 2 and 3
// all bind a SessionStart to a card by cwd alone. Codex 0.162 runs hooks from a shared
// app-server daemon (no tty, the daemon's pid, often no terminal id), and the ChatGPT desktop
// app's Codex does the same, so ANY Codex thread started in a folder where a dashboard
// terminal was still connecting took that terminal's card. A process with no controlling tty
// is not the agent in a PTY, so it binds nothing by path. Only an explicit `tty_path: null`
// counts; a hook that omits the key (Windows, older installs) keeps the old behaviour.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { matchSession } from '../server/sessionMatcher.js';
import { tryLinkByWorkDir } from '../server/sshManager.js';
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

const CWD = '/Users/u/Documents/claude/aasc-phone-e2e';
const TERM = 'term-1792127112411-8kzgrm';
const OUTSIDER = '01a1431a-9e01-7c44-8a10-3b2f0c1d0001';
const DAEMON_PID = 4_200_001;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: TERM,
    projectPath: CWD,
    projectName: 'aasc-phone-e2e',
    title: '',
    status: SESSION_STATUS.CONNECTING as Session['status'],
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
    terminalId: TERM,
    ...overrides,
  };
}

describe('matchSession — a tty-less hook binds no terminal by folder', () => {
  let sessions: Map<string, Session>;
  let pendingResume: Map<string, PendingResume>;
  let pidToSession: Map<number, string>;
  let counters: Map<string, number>;

  const run = (payload: Partial<HookPayloadBase>) =>
    matchSession(
      {
        session_id: OUTSIDER,
        hook_event_name: EVENT_TYPES.SESSION_START,
        cwd: CWD,
        cli_source: 'codex',
        tty_path: null,
        claude_pid: DAEMON_PID,
        ...payload,
      } as HookPayloadBase,
      sessions,
      pendingResume,
      pidToSession,
      counters,
    );

  beforeEach(() => {
    sessions = new Map();
    pendingResume = new Map();
    pidToSession = new Map();
    counters = new Map();
    vi.mocked(tryLinkByWorkDir).mockReset().mockReturnValue(null);
  });

  it('does not take a CONNECTING placeholder by path (Priority 3)', () => {
    sessions.set(TERM, makeSession());
    expect(run({})).toBeNull();
    expect(sessions.get(TERM)?.sessionId).toBe(TERM);
    expect(sessions.has(OUTSIDER)).toBe(false);
  });

  it('does not consume the terminal\'s pending workDir link (Priority 2)', () => {
    vi.mocked(tryLinkByWorkDir).mockReturnValue(TERM);
    sessions.set(TERM, makeSession({ status: SESSION_STATUS.IDLE as Session['status'] }));
    expect(run({})).toBeNull();
    expect(tryLinkByWorkDir).not.toHaveBeenCalled();
    expect(sessions.get(TERM)?.sessionId).toBe(TERM);
  });

  it('does not take a pending resume by path (Priority 0 fallback)', () => {
    const resuming = makeSession({ sessionId: 'old-thread', status: SESSION_STATUS.CONNECTING as Session['status'] });
    sessions.set('old-thread', resuming);
    pendingResume.set(TERM, { oldSessionId: 'old-thread', timestamp: Date.now() });
    expect(run({})).toBeNull();
    expect(pendingResume.has(TERM)).toBe(true);
    expect(sessions.has('old-thread')).toBe(true);
  });

  it('does not take a restart-ended card by path (Priority 0.5)', () => {
    sessions.set('restored', makeSession({
      sessionId: 'restored',
      status: SESSION_STATUS.ENDED as Session['status'],
      endedAt: Date.now() - 1000,
      terminalId: null,
      events: [{ type: 'ServerRestart', timestamp: Date.now() - 1000, detail: '' }],
    }));
    expect(run({})).toBeNull();
    expect(sessions.get('restored')?.sessionId).toBe('restored');
  });

  describe('compatibility', () => {
    it('a tty-bearing SessionStart still takes the CONNECTING placeholder by path', () => {
      sessions.set(TERM, makeSession());
      expect(run({ tty_path: '/dev/ttys012', claude_pid: 4_200_002 })?.sessionId).toBe(OUTSIDER);
      expect(sessions.has(TERM)).toBe(false);
    });

    it('a hook that omits tty_path (Windows hook, older installs) still takes it', () => {
      sessions.set(TERM, makeSession());
      const result = run({ tty_path: undefined, claude_pid: 4_200_003 });
      expect(result?.sessionId).toBe(OUTSIDER);
      expect(result?.terminalId).toBe(TERM);
    });

    it('a tty-bearing SessionStart still consumes the pending workDir link', () => {
      vi.mocked(tryLinkByWorkDir).mockReturnValue(TERM);
      sessions.set(TERM, makeSession({ status: SESSION_STATUS.IDLE as Session['status'] }));
      expect(run({ tty_path: '/dev/ttys012', claude_pid: 4_200_004 })?.terminalId).toBe(TERM);
      expect(tryLinkByWorkDir).toHaveBeenCalledWith(CWD, OUTSIDER);
    });
  });
});
