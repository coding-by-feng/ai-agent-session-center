// test/sessionMatcher.adoption.test.ts — Priority 4.5 "terminal adoption" suite.
//
// Every re-key path in matchSession (P0.5, P1, P1b, P2, P3) is gated on
// SessionStart. When that one hook is lost — MQ truncation, a dropped hook, or
// an agent that re-keys its own session id without re-firing SessionStart —
// the next PreToolUse fell all the way through to Priority 5, which minted a
// SECOND card bound to the same live PTY. The origin card was then stranded in
// `ended` (Terminal tab: "Terminal disconnected / Reconnect") while its twin
// appeared untitled ("Unnamed") in the Common Area.
//
// Priority 4.5 adopts the terminal instead: when exactly one session owns
// agent_terminal_id, re-key it onto the new session_id whatever the event type.
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

const TERM = 'term-1785314205065-8gw6vh';
const CWD = '/Users/kasonzhan/Documents/sms-ops';

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    sessionId: 'sess-default',
    projectPath: CWD,
    projectName: 'sms-ops',
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

/** The exact card shape observed in the live snapshot when this bug fired. */
function strandedOwner(): Session {
  return makeSession({
    sessionId: 'a3774303-old',
    title: 'SMS OPS',
    status: SESSION_STATUS.ENDED as Session['status'],
    animationState: ANIMATION_STATE.DEATH as Session['animationState'],
    endedAt: Date.now(),
    isHistorical: true,
    terminalId: TERM,
    lastTerminalId: TERM,
    cachedPid: null, // SessionEnd released it
    events: [{ type: 'SessionEnd', timestamp: Date.now(), detail: 'Session ended (resume)' }],
  });
}

describe('matchSession — Priority 4.5 terminal adoption', () => {
  let sessions: Map<string, Session>;
  let pendingResume: Map<string, PendingResume>;
  let pidToSession: Map<number, string>;
  let projectCounters: Map<string, number>;

  const run = (payload: Partial<HookPayloadBase>) =>
    matchSession(
      {
        session_id: '873b175b-new',
        hook_event_name: EVENT_TYPES.PRE_TOOL_USE,
        cwd: CWD,
        agent_terminal_id: TERM,
        tty_path: '/dev/ttys111',
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

  it('adopts the terminal on a non-SessionStart hook instead of minting a twin card', () => {
    sessions.set('a3774303-old', strandedOwner());

    const result = run({});

    // One card, re-keyed — not two.
    expect(sessions.size).toBe(1);
    expect(sessions.has('873b175b-new')).toBe(true);
    expect(sessions.has('a3774303-old')).toBe(false);
    expect(result?.sessionId).toBe('873b175b-new');
    expect(result?.terminalId).toBe(TERM);
  });

  it('preserves the user-visible title so the card never renders as "Unnamed"', () => {
    sessions.set('a3774303-old', strandedOwner());

    const result = run({});

    expect(result?.title).toBe('SMS OPS');
  });

  it('un-strands the ended card so the Terminal tab stops offering Reconnect', () => {
    sessions.set('a3774303-old', strandedOwner());

    const result = run({});

    // showReconnect is `status === 'ended' && !terminalId`; both must be false.
    expect(result?.status).toBe(SESSION_STATUS.IDLE);
    expect(result?.endedAt).toBeNull();
    expect(result?.isHistorical).toBe(false);
    expect(result?.terminalId).toBe(TERM);
  });

  it('archives the previous thread rather than dropping it', () => {
    sessions.set('a3774303-old', strandedOwner());

    const result = run({});

    expect(result?.previousSessions?.at(-1)?.sessionId).toBe('a3774303-old');
  });

  it('adopts via lastTerminalId when terminalId was already cleared', () => {
    sessions.set(
      'a3774303-old',
      makeSession({
        sessionId: 'a3774303-old',
        title: 'SMS OPS',
        status: SESSION_STATUS.ENDED as Session['status'],
        terminalId: null,
        lastTerminalId: TERM,
      }),
    );

    const result = run({});

    expect(sessions.size).toBe(1);
    expect(result?.title).toBe('SMS OPS');
  });

  it('does not adopt when two sessions own the same terminal (ambiguous)', () => {
    sessions.set('owner-a', makeSession({ sessionId: 'owner-a', title: 'A', terminalId: TERM }));
    sessions.set('owner-b', makeSession({ sessionId: 'owner-b', title: 'B', lastTerminalId: TERM }));

    run({});

    // Falls through to Priority 5 — both originals survive untouched.
    expect(sessions.has('owner-a')).toBe(true);
    expect(sessions.has('owner-b')).toBe(true);
    expect(sessions.has('873b175b-new')).toBe(true);
  });

  it('does not adopt a CONNECTING placeholder (Priority 3 owns that case)', () => {
    sessions.set(
      'pending',
      makeSession({
        sessionId: 'pending',
        status: SESSION_STATUS.CONNECTING as Session['status'],
        terminalId: TERM,
      }),
    );

    run({});

    expect(sessions.has('pending')).toBe(true);
    expect(sessions.has('873b175b-new')).toBe(true);
  });

  it('does not let a stale SessionEnd drag a live card backward', () => {
    const owner = makeSession({ sessionId: 'live', title: 'SMS OPS', terminalId: TERM });
    sessions.set('live', owner);

    const result = run({ hook_event_name: EVENT_TYPES.SESSION_END });

    expect(sessions.get('live')).toBe(owner);
    expect(result).toBeNull(); // Priority 5 refuses to card a teardown event
  });

  it('does not let a stale Stop drag a live card backward', () => {
    const owner = makeSession({ sessionId: 'live', title: 'SMS OPS', terminalId: TERM });
    sessions.set('live', owner);

    run({ hook_event_name: EVENT_TYPES.STOP });

    expect(sessions.get('live')).toBe(owner);
  });

  it('does not let a subagent hook hijack its parent terminal', () => {
    const owner = makeSession({ sessionId: 'parent', title: 'SMS OPS', terminalId: TERM });
    sessions.set('parent', owner);

    const result = run({ parent_session_id: 'parent', agent_name: 'code-reviewer' });

    expect(sessions.get('parent')).toBe(owner);
    expect(result).toBeNull(); // teamManager owns subagents
  });

  it('still mints an external card when no session owns the terminal', () => {
    const result = run({ agent_terminal_id: undefined });

    expect(result?.sessionId).toBe('873b175b-new');
    expect(result?.isExternal).toBe(true);
  });

  it('leaves SessionStart matching to the existing priorities (P1b still wins)', () => {
    sessions.set('a3774303-old', strandedOwner());

    const result = run({ hook_event_name: EVENT_TYPES.SESSION_START });

    expect(sessions.size).toBe(1);
    expect(result?.title).toBe('SMS OPS');
  });
});
