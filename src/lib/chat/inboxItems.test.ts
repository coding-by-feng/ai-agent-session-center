// inboxItems.test.ts — what the Inbox lists (AASC-43): approvals, questions,
// interruptions with Continue, finished turns, the "continue interrupted sessions"
// offer, and what this phone has read.
import { describe, it, expect, beforeEach } from 'vitest';
import type { PendingRequest, Session } from '@/types';
import {
  FINISHED_WINDOW_MS,
  filterInbox,
  inboxAge,
  inboxItems,
  loadReadState,
  markRead,
  saveReadState,
  unreadCount,
} from './inboxItems';

const NOW = 10_000_000;

function session(id: string, status: string, extra: Partial<Session> = {}): Session {
  return {
    sessionId: id,
    status,
    title: `Session ${id}`,
    projectName: 'proj',
    lastActivityAt: NOW - 1000,
    responseLog: [],
    pendingRequest: null,
    pendingTool: null,
    pendingToolDetail: null,
    waitingDetail: null,
    terminalId: `term-${id}`,
    ...extra,
  } as unknown as Session;
}

const bash = (id = 'toolu_1'): PendingRequest => ({
  id, kind: 'permission', cli: 'claude', tool: 'Bash', raisedAt: NOW - 120_000, source: 'permission_request', input: { command: 'npm run build' },
});

const map = (...list: Session[]) => new Map(list.map((s) => [s.sessionId, s]));
const titleOf = (s: Session) => s.title;

describe('inboxItems', () => {
  it('lists an approval with what it wants to do', () => {
    const [item] = inboxItems(map(session('a', 'approval', { pendingRequest: bash() })), { titleOf, now: NOW });
    expect(item).toMatchObject({ kind: 'approval', sessionId: 'a', title: 'Session a', line: 'Wants to run: npm run build', waiting: true, at: NOW - 120_000 });
    expect(item.id).toBe('approval:a:toolu_1');
  });

  it('lists a question with what it asks', () => {
    const ask: PendingRequest = {
      id: 'q1', kind: 'question', cli: 'claude', tool: 'AskUserQuestion', raisedAt: NOW - 5000, source: 'pre_tool_use',
      input: { questions: [{ question: 'Which payment phase applies?', options: [] }] }, options: [{ label: 'Deposit' }],
    };
    const [item] = inboxItems(map(session('b', 'input', { pendingRequest: ask })), { titleOf, now: NOW });
    expect(item).toMatchObject({ kind: 'question', line: 'Which payment phase applies?', waiting: true });
  });

  it('lists a waiting session with no request from its status alone', () => {
    const items = inboxItems(map(
      session('a', 'approval', { pendingTool: 'Bash', pendingToolDetail: 'npm test' }),
      session('b', 'input', { waitingDetail: 'Which branch?' }),
    ), { titleOf, now: NOW });
    expect(items.map((i) => [i.kind, i.line])).toEqual([['approval', 'Wants to run: npm test'], ['question', 'Which branch?']]);
  });

  it('lists an interrupted turn, ready to continue', () => {
    const [item] = inboxItems(map(session('c', 'waiting', {
      interruption: { kind: 'api_error', line: 'API Error: 529', detectedAt: NOW - 60_000 } as Session['interruption'],
    })), { titleOf, now: NOW });
    expect(item).toMatchObject({ kind: 'interrupted', line: 'Stopped: API Error: 529', waiting: true, at: NOW - 60_000, id: `interrupted:c:${NOW - 60_000}` });
  });

  it('lists a finished turn with the start of its answer, not as waiting', () => {
    const [item] = inboxItems(map(session('d', 'waiting', {
      responseLog: [{ text: 'Updated the pricing page and checked the build.', timestamp: NOW - 720_000 }],
    })), { titleOf, now: NOW });
    expect(item).toMatchObject({ kind: 'finished', line: 'Updated the pricing page and checked the build.', waiting: false, at: NOW - 720_000 });
  });

  it('forgets a finished turn after a while, and never lists working or ended sessions', () => {
    const items = inboxItems(map(
      session('old', 'idle', { responseLog: [{ text: 'old', timestamp: NOW - FINISHED_WINDOW_MS - 1 }] }),
      session('w', 'working', { responseLog: [{ text: 'mid-turn', timestamp: NOW - 10 }] }),
      session('e', 'ended', { pendingRequest: bash(), responseLog: [{ text: 'x', timestamp: NOW }] }),
    ), { titleOf, now: NOW });
    expect(items).toEqual([]);
  });

  it('puts what waits first (the longest waiting first), then finished turns, newest first', () => {
    const items = inboxItems(map(
      session('f1', 'waiting', { responseLog: [{ text: 'one', timestamp: NOW - 50 }] }),
      session('a', 'approval', { pendingRequest: { ...bash(), raisedAt: NOW - 10 } }),
      session('f2', 'waiting', { responseLog: [{ text: 'two', timestamp: NOW - 5 }] }),
      session('b', 'approval', { pendingRequest: { ...bash('t2'), raisedAt: NOW - 900 } }),
    ), { titleOf, now: NOW });
    expect(items.map((i) => i.sessionId)).toEqual(['b', 'a', 'f2', 'f1']);
  });

  it('offers "continue all" once two or more turns were interrupted', () => {
    const interruption = (at: number) => ({ kind: 'network', line: 'Network error', detectedAt: at } as Session['interruption']);
    const items = inboxItems(map(
      session('x', 'waiting', { interruption: interruption(NOW - 30) }),
      session('y', 'idle', { interruption: interruption(NOW - 20) }),
    ), { titleOf, now: NOW });
    expect(items[0]).toMatchObject({ kind: 'continue-all', sessionIds: ['x', 'y'], title: '2 sessions stopped', waiting: true });
    expect(items.filter((i) => i.kind === 'interrupted')).toHaveLength(2);
  });

  it('turns the restart offer into one item for the sessions it names', () => {
    const items = inboxItems(map(session('r1', 'idle'), session('r2', 'idle')), {
      titleOf,
      now: NOW,
      offer: { restoreStartedAt: NOW - 5000, items: [{ terminalId: 'term-r1', title: 'R1', status: 'working' }, { terminalId: 'term-r2', title: 'R2', status: 'approval' }] },
    });
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ kind: 'continue-all', reason: 'restart', sessionIds: ['r1', 'r2'], title: '2 sessions were interrupted', id: `restart:${NOW - 5000}` });
    expect(items[0].line).toMatch(/restarted/);
  });

  it('ignores a restart offer naming no session this phone can see', () => {
    const items = inboxItems(map(session('r1', 'idle')), {
      titleOf, now: NOW, offer: { restoreStartedAt: 1, items: [{ terminalId: 'term-hidden', title: 'H', status: 'working' }] },
    });
    expect(items).toEqual([]);
  });
});

describe('filterInbox', () => {
  const items = inboxItems(map(
    session('a', 'approval', { pendingRequest: bash() }),
    session('d', 'waiting', { responseLog: [{ text: 'done', timestamp: NOW - 5 }] }),
  ), { titleOf, now: NOW });

  it('splits waiting from finished', () => {
    expect(filterInbox(items, 'waiting').map((i) => i.kind)).toEqual(['approval']);
    expect(filterInbox(items, 'finished').map((i) => i.kind)).toEqual(['finished']);
    expect(filterInbox(items, 'all')).toHaveLength(2);
  });
});

describe('read state, per phone', () => {
  beforeEach(() => localStorage.clear());

  it('counts what this phone has not read, and marks items read', () => {
    const items = inboxItems(map(session('a', 'approval', { pendingRequest: bash() }), session('d', 'waiting', { responseLog: [{ text: 'x', timestamp: NOW }] })), { titleOf, now: NOW });
    expect(unreadCount(items, {})).toBe(2);
    const read = markRead({}, [items[0].id], NOW);
    expect(unreadCount(items, read)).toBe(1);
  });

  it('a new request on the same session is unread again', () => {
    const before = inboxItems(map(session('a', 'approval', { pendingRequest: bash('t1') })), { titleOf, now: NOW });
    const read = markRead({}, before.map((i) => i.id), NOW);
    const after = inboxItems(map(session('a', 'approval', { pendingRequest: bash('t2') })), { titleOf, now: NOW });
    expect(unreadCount(after, read)).toBe(1);
  });

  it('survives a reload, and an unreadable store reads as nothing read', () => {
    saveReadState({ 'approval:a:t1': NOW });
    expect(loadReadState()).toEqual({ 'approval:a:t1': NOW });
    localStorage.setItem('aasc.inboxRead', '{not json');
    expect(loadReadState()).toEqual({});
  });

  it('keeps only the newest entries', () => {
    let read = {};
    for (let i = 0; i < 600; i += 1) read = markRead(read, [`k${i}`], i);
    expect(Object.keys(read).length).toBeLessThanOrEqual(500);
    expect(read).toHaveProperty('k599');
  });
});

describe('inboxAge', () => {
  it('says how long ago, briefly', () => {
    expect(inboxAge(NOW - 20_000, NOW)).toBe('now');
    expect(inboxAge(NOW - 2 * 60_000, NOW)).toBe('2m');
    expect(inboxAge(NOW - 90 * 60_000, NOW)).toBe('1h');
    expect(inboxAge(NOW - 30 * 3600_000, NOW)).toBe('1d');
    expect(inboxAge(NOW + 5000, NOW)).toBe('now');
  });
});
