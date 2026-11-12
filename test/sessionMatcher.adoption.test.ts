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
import { matchSession, findSplitTwin, foldSplitPair } from '../server/sessionMatcher.js';
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

  // Oct 30 2026: a restored Codex card is keyed by its own terminal id until its first hook.
  // That hook (UserPromptSubmit) reached the MQ torn and was dropped, the next PreToolUse
  // skipped the card here ("Priority 1's case", but Priority 1 takes startup events only) and
  // Priority 5 minted a twin on the same terminal. The twin got every hook; the card holding
  // the queue stayed idle, and its queue typed a prompt 17 minutes into a running turn.
  describe('a card still keyed by its terminal id (its first hook was lost)', () => {
    function placeholder(): Session {
      return makeSession({
        sessionId: TERM,
        title: 'AASC Official Website',
        status: SESSION_STATUS.IDLE as Session['status'],
        terminalId: TERM,
        startupCommand: 'codex --no-daemon resume 01a18661',
      });
    }
    const codexTool = { session_id: '01a18661-codex', cli_source: 'codex' } as Partial<HookPayloadBase>;

    it('adopts it on a tool hook instead of minting a twin on the same terminal', () => {
      const card = placeholder();
      sessions.set(TERM, card);

      const result = run(codexTool);

      expect(sessions.size).toBe(1);
      expect(sessions.has(TERM)).toBe(false);
      expect(sessions.get('01a18661-codex')).toBe(card);
      expect(result).toBe(card);
      expect(result?.terminalId).toBe(TERM);
      expect(result?.title).toBe('AASC Official Website');
      expect(result?.isExternal).toBeFalsy();
    });

    it('re-keys it like Priority 1: replacesId lets the server move its queue and the clients follow', () => {
      sessions.set(TERM, placeholder());

      const result = run(codexTool);

      expect(result?.replacesId).toBe(TERM);
      expect(result?.previousSessions ?? []).toEqual([]); // a placeholder has no thread to archive
    });

    it('adopts it while it is still connecting too (the terminal id is an exact match)', () => {
      sessions.set(TERM, { ...placeholder(), status: SESSION_STATUS.CONNECTING as Session['status'] });

      const result = run(codexTool);

      expect(sessions.size).toBe(1);
      expect(result?.terminalId).toBe(TERM);
    });

    it('does not adopt it on a teardown hook', () => {
      const card = placeholder();
      sessions.set(TERM, card);

      run({ ...codexTool, hook_event_name: EVENT_TYPES.STOP });

      expect(sessions.get(TERM)).toBe(card);
    });

    it('does not let a subagent hook take it', () => {
      const card = placeholder();
      sessions.set(TERM, card);

      run({ ...codexTool, parent_session_id: 'parent', agent_name: 'worker' });

      expect(sessions.get(TERM)).toBe(card);
    });

    it('does not adopt it when another card also owns the terminal (ambiguous)', () => {
      sessions.set(TERM, placeholder());
      sessions.set('other', makeSession({ sessionId: 'other', terminalId: TERM }));

      run(codexTool);

      expect(sessions.has(TERM)).toBe(true);
      expect(sessions.has('other')).toBe(true);
    });
  });

  // The pair that already split before the fix above: the twin holds the real id and gets
  // every hook by direct lookup, so adoption never runs. Seen live Oct 30 2026: "AASC New
  // Website" idle (with the queue) beside "website #2 — And we need admin console…" working.
  describe('a pair that already split rejoins on the next hook', () => {
    const S = '01a18661-codex';
    function deafCard(): Session {
      return makeSession({
        sessionId: TERM,
        title: 'AASC New Website',
        status: SESSION_STATUS.IDLE as Session['status'],
        terminalId: TERM,
        pinned: true,
        queueCount: 2,
        startupCommand: 'codex --no-daemon resume 01a18661',
      });
    }
    function twin(overrides: Partial<Session> = {}): Session {
      return makeSession({
        sessionId: S,
        title: 'website #2 — And we need admin console services to…',
        status: SESSION_STATUS.WORKING as Session['status'],
        terminalId: TERM,
        isExternal: false,
        transcriptPath: '/Users/k/.codex/sessions/rollout-01a18661.jsonl',
        promptHistory: [{ text: 'and we need admin console services', timestamp: 1 }],
        totalToolCalls: 40,
        cachedPid: 5480,
        ...overrides,
      });
    }
    const hook = (p: Partial<HookPayloadBase> = {}) => run({ session_id: S, cli_source: 'codex', ...p } as Partial<HookPayloadBase>);

    it('folds them into one card under the real session id', () => {
      sessions.set(TERM, deafCard());
      sessions.set(S, twin());

      const result = hook();

      expect(sessions.size).toBe(1);
      expect(sessions.has(TERM)).toBe(false);
      expect(sessions.get(S)).toBe(result);
      expect(result?.sessionId).toBe(S);
      expect(result?.replacesId).toBe(TERM); // server moves the queue rows, clients follow
    });

    it('keeps what the person set on the card and what Codex did on the twin', () => {
      sessions.set(TERM, deafCard());
      sessions.set(S, twin());

      const result = hook();

      expect(result?.title).toBe('AASC New Website');
      expect(result?.pinned).toBe(true);
      expect(result?.queueCount).toBe(2);
      expect(result?.startupCommand).toBe('codex --no-daemon resume 01a18661');
      expect(result?.terminalId).toBe(TERM);
      expect(result?.status).toBe(SESSION_STATUS.WORKING);
      expect(result?.transcriptPath).toBe('/Users/k/.codex/sessions/rollout-01a18661.jsonl');
      expect(result?.promptHistory).toHaveLength(1);
      expect(result?.totalToolCalls).toBe(40);
      expect(result?.cachedPid).toBe(5480);
    });

    it('leaves a card with no terminal alone (a historical origin that a fork or clone resumes from)', () => {
      const origin = twin({ terminalId: null, lastTerminalId: 'term-before', status: SESSION_STATUS.IDLE as Session['status'] });
      sessions.set(TERM, deafCard());
      sessions.set(S, origin);

      const result = hook({ hook_event_name: EVENT_TYPES.USER_PROMPT_SUBMIT });

      expect(result).toBe(origin);
      expect(sessions.size).toBe(2);
    });

    it('keeps the twin\'s title when the card never had one', () => {
      sessions.set(TERM, { ...deafCard(), title: '' });
      sessions.set(S, twin());

      expect(hook()?.title).toBe('website #2 — And we need admin console services to…');
    });

    it('never takes a card bound to a different terminal', () => {
      const other = twin({ terminalId: 'term-other-live' });
      sessions.set(TERM, deafCard());
      sessions.set(S, other);

      const result = hook();

      expect(result).toBe(other);
      expect(sessions.size).toBe(2);
    });

    it('leaves a card that already heard its own thread alone (keyed by a session id, not the terminal)', () => {
      const heard = makeSession({ sessionId: 'older-thread', terminalId: TERM });
      sessions.set('older-thread', heard);
      sessions.set(S, twin());

      hook();

      expect(sessions.get('older-thread')).toBe(heard);
      expect(sessions.size).toBe(2);
    });

    it('does not rejoin on SessionEnd or on a subagent\'s hook', () => {
      sessions.set(TERM, deafCard());
      sessions.set(S, twin());

      hook({ hook_event_name: EVENT_TYPES.SESSION_END });
      hook({ parent_session_id: S, agent_name: 'worker' });

      expect(sessions.size).toBe(2);
    });
  });

  it('leaves SessionStart matching to the existing priorities (P1b still wins)', () => {
    sessions.set('a3774303-old', strandedOwner());

    const result = run({ hook_event_name: EVENT_TYPES.SESSION_START });

    expect(sessions.size).toBe(1);
    expect(result?.title).toBe('SMS OPS');
  });
});

// A split pair with no hook coming (Oct 30 2026): sleep closed the twin's terminal, and the card's
// Reconnect relaunched its own launch line, a fresh Codex, instead of thread 01a18661. Resume,
// Reconnect and sleep now fold the pair first (sessionStore.healSplitCard) with these two.
describe('findSplitTwin / foldSplitPair — folding a pair before a relaunch', () => {
  const card = (overrides: Partial<Session> = {}) => makeSession({
    sessionId: TERM,
    title: 'AASC New Website',
    terminalId: null,
    lastTerminalId: 'term-reconnected',
    effortLevel: 'max',
    startupCommand: 'codex --no-daemon --yolo',
    sshConfig: { host: 'localhost', port: 22, username: 'u', workingDir: '/web', command: 'codex --yolo' } as Session['sshConfig'],
    ...overrides,
  });
  const twin = (overrides: Partial<Session> = {}) => makeSession({
    sessionId: '01a18661-thread',
    title: 'website #2',
    status: SESSION_STATUS.ENDED as Session['status'],
    asleepAt: 50,
    terminalId: TERM,
    effortLevel: 'xhigh',
    startupCommand: 'codex --yolo resume --no-daemon 01a18661-thread',
    ...overrides,
  });

  it('finds the twin bound to the terminal the card is keyed by, even after the card moved terminals', () => {
    const t = twin();
    const map = new Map([[TERM, card()], [t.sessionId, t]]);

    expect(findSplitTwin(map.get(TERM)!, map)).toBe(t);
  });

  it('finds no twin for a card keyed by a real id, for two candidates, or for a fork or subagent', () => {
    const real = card({ sessionId: 'real-id' });
    expect(findSplitTwin(real, new Map([['real-id', real], ['t', twin({ terminalId: 'real-id' })]]))).toBeNull();

    const c = card();
    const two = new Map([[TERM, c], ['a', twin({ sessionId: 'a' })], ['b', twin({ sessionId: 'b' })]]);
    expect(findSplitTwin(c, two)).toBeNull();

    expect(findSplitTwin(c, new Map([[TERM, c], ['f', twin({ sessionId: 'f', isFork: true })]]))).toBeNull();
    expect(findSplitTwin(c, new Map([[TERM, c], ['s', twin({ sessionId: 's', parentSessionId: 'x' })]]))).toBeNull();
  });

  it('folds to the twin\'s id with the card\'s identity and the twin\'s resume line', () => {
    const merged = foldSplitPair(card(), twin(), 'term-reconnected');

    expect(merged.sessionId).toBe('01a18661-thread');
    expect(merged.replacesId).toBe(TERM);
    expect(merged.title).toBe('AASC New Website');
    expect(merged.effortLevel).toBe('max');
    expect(merged.sshConfig?.workingDir).toBe('/web');
    expect(merged.startupCommand).toBe('codex --yolo resume --no-daemon 01a18661-thread');
    expect(merged.lastTerminalId).toBe('term-reconnected');
    expect(merged.asleepAt).toBe(50);
  });

  it('keeps the card\'s launch line when the twin has none', () => {
    expect(foldSplitPair(card(), twin({ startupCommand: undefined }), null).startupCommand).toBe('codex --no-daemon --yolo');
  });
});
