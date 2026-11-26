// inboxItems.test.ts — what the Inbox lists (AASC-43): approvals, questions,
// interruptions with Continue, finished turns, the "continue interrupted sessions"
// offer, and what this phone has read.
import { describe, it, expect, beforeEach } from 'vitest';
import type { PendingRequest, RaisedAlert, Session } from '@/types';
import { inboxCount } from './inboxModel';
import {
  FINISHED_WINDOW_MS,
  filterInbox,
  waitingCount,
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
    expect(item.command).toBe('npm run build');
  });

  it('keeps the whole command of an approval, however long, for the row to show before Allow', () => {
    const long = `rm -rf ./build && ${'x'.repeat(200)} && echo done`;
    const req = { ...bash(), input: { command: long } };
    const [item] = inboxItems(map(session('a', 'approval', { pendingRequest: req })), { titleOf, now: NOW });
    expect(item.line.length).toBeLessThanOrEqual(140);
    expect(item.command).toBe(long);
  });

  it('gives a question no command', () => {
    const [item] = inboxItems(map(session('b', 'input', { waitingDetail: 'Which branch?' })), { titleOf, now: NOW });
    expect(item.command).toBeUndefined();
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

  it('lists a turn stopped on the usage limit with its reset', () => {
    const [item] = inboxItems(map(session('c', 'waiting', {
      interruption: { kind: 'usage_limit', line: "You've hit your 5-hour limit · resets 1:30pm (Pacific/Auckland)", detectedAt: 1 } as Session['interruption'],
    })), { titleOf, now: NOW });
    expect(item).toMatchObject({ kind: 'interrupted', line: 'Limit reached · resets 1:30pm' });
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

describe('waitingCount', () => {
  it('counts the sessions waiting, as the tab badge does: a "continue all" card is no extra wait (AASC-48)', () => {
    const interruption = (at: number) => ({ kind: 'network', line: 'Network error', detectedAt: at } as Session['interruption']);
    const sessions = map(
      session('a', 'approval', { pendingRequest: bash() }),
      session('x', 'waiting', { interruption: interruption(NOW - 30) }),
      session('y', 'idle', { interruption: interruption(NOW - 20) }),
    );
    const items = inboxItems(sessions, { titleOf, now: NOW });
    expect(filterInbox(items, 'waiting')).toHaveLength(4);
    expect(waitingCount(items)).toBe(3);
    expect(waitingCount(items)).toBe(inboxCount(sessions));
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

// Nov 26 2026: a central's alert waits in the Inbox like a question.
describe('inboxItems: raised alerts', () => {
  const raised = (over: Partial<RaisedAlert> = {}): RaisedAlert => ({
    id: 'al1', key: 'stuck', sessionId: 'w', centralId: '', centralSessionId: 'c', message: 'Package step stuck 45m',
    raisedAt: NOW - 600_000, updatedAt: NOW - 600_000, count: 1, ...over,
  });
  const sessions = () => new Map([
    ['w', session('w', 'working')],
    ['c', session('c', 'working')],
    ['q', session('q', 'input', { lastActivityAt: NOW - 60_000 })],
  ]);
  const titleOf = (s: Session) => s.title ?? s.sessionId;

  it('lists one as waiting, with its message, the central it came from and its id', () => {
    const items = inboxItems(sessions(), { titleOf, now: NOW, alerts: [raised()] });
    const item = items.find((i) => i.kind === 'alert');
    expect(item).toMatchObject({
      id: 'alert:al1:1', sessionId: 'w', title: 'Session w', line: 'Package step stuck 45m', at: NOW - 600_000,
      waiting: true, alertId: 'al1', from: 'Session c',
    });
    expect(waitingCount(items)).toBe(2);
  });

  it('sorts it among the waiting by when it was raised, oldest first', () => {
    const items = filterInbox(inboxItems(sessions(), { titleOf, now: NOW, alerts: [raised()] }), 'waiting');
    expect(items.map((i) => i.kind)).toEqual(['alert', 'question']);
  });

  it('names no central for an alert about the central’s own card, or one this device can’t see', () => {
    const own = inboxItems(sessions(), { titleOf, now: NOW, alerts: [raised({ centralSessionId: 'w' })] });
    expect(own.find((i) => i.kind === 'alert')?.from).toBeUndefined();
    const unseen = inboxItems(sessions(), { titleOf, now: NOW, alerts: [raised({ centralSessionId: null })] });
    expect(unseen.find((i) => i.kind === 'alert')?.from).toBeUndefined();
  });

  it('is unread again when the central raises it again', () => {
    const first = inboxItems(sessions(), { titleOf, now: NOW, alerts: [raised()] }).find((i) => i.kind === 'alert');
    const again = inboxItems(sessions(), { titleOf, now: NOW, alerts: [raised({ count: 2 })] }).find((i) => i.kind === 'alert');
    expect(first?.id).not.toBe(again?.id);
  });

  it('skips an alert on an ended or unknown session', () => {
    const map = sessions();
    map.set('w', session('w', 'ended'));
    expect(inboxItems(map, { titleOf, now: NOW, alerts: [raised(), raised({ id: 'al2', sessionId: 'x' })] }).some((i) => i.kind === 'alert')).toBe(false);
  });
});
