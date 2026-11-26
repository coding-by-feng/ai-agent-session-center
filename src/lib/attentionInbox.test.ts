import { describe, expect, it } from 'vitest';
import { DEFAULT_ALERT_CONFIG, type AlertLevel } from '@/lib/attention';
import type { RaisedAlert } from '@/types';
import {
  HINT_MERGE_MS,
  mergeHint,
  newMoments,
  pruneHidden,
  waitAge,
  waitKindOf,
  waitingItems,
  type InboxSession,
  type WaitItem,
} from './attentionInbox';

const levelOf = (levels: Record<string, AlertLevel>) => (s: InboxSession) => {
  const level = levels[s.sessionId] ?? 'normal';
  return { level, outputs: DEFAULT_ALERT_CONFIG.levels[level] };
};
const ctx = (levels: Record<string, AlertLevel> = {}, seenAt = new Map<string, number>()) => ({
  alertOf: levelOf(levels),
  outputsOf: (level: AlertLevel) => DEFAULT_ALERT_CONFIG.levels[level],
  seenAt,
  now: 10_000,
});

const session = (sessionId: string, over: Partial<InboxSession> = {}): InboxSession => ({
  sessionId,
  status: 'working',
  title: `Title ${sessionId}`,
  projectName: 'proj',
  lastActivityAt: 1_000,
  ...over,
});

const alert = (over: Partial<RaisedAlert> = {}): RaisedAlert => ({
  id: 'a1', key: 'stuck', sessionId: 'c1', centralId: 'central-1', centralSessionId: 'c1',
  message: 'Package stuck 45m', raisedAt: 5_000, updatedAt: 6_000, count: 1, ...over,
});

describe('waitKindOf', () => {
  it('reads what the session waits on', () => {
    expect(waitKindOf(session('s', { status: 'approval' }))).toBe('approval');
    expect(waitKindOf(session('s', { status: 'input' }))).toBe('question');
    expect(waitKindOf(session('s', { status: 'approval', pendingRequest: { kind: 'question', raisedAt: 1, tool: 'AskUserQuestion' } }))).toBe('question');
    expect(waitKindOf(session('s', { status: 'waiting', pendingProceedAt: 5 }))).toBe('proceed');
    expect(waitKindOf(session('s', { status: 'idle', pendingProceedAt: 5 }))).toBe('proceed');
    expect(waitKindOf(session('s', { status: 'working', pendingProceedAt: 5 }))).toBeNull();
    expect(waitKindOf(session('s', { status: 'waiting' }))).toBeNull();
    expect(waitKindOf(session('s', { status: 'ended' }))).toBeNull();
  });
});

describe('waitingItems', () => {
  it('lists what waits on the person, newest first, with what each asks', () => {
    const items = waitingItems(
      [
        session('q', { status: 'input', pendingRequest: { kind: 'question', raisedAt: 9_000, tool: 'AskUserQuestion' } }),
        session('a', { status: 'approval', pendingTool: 'Bash', pendingRequest: { kind: 'permission', raisedAt: 7_000, tool: 'Bash' } }),
        session('p', { status: 'waiting', pendingProceedAt: 8_000 }),
        session('w', { status: 'working' }),
      ],
      [],
      ctx(),
    );
    expect(items.map((i) => [i.key, i.kind, i.detail, i.since])).toEqual([
      ['q:question', 'question', 'needs your answer', 9_000],
      ['p:proceed', 'proceed', 'asks to proceed', 8_000],
      ['a:approval', 'approval', 'approve Bash', 7_000],
    ]);
    expect(items[0].title).toBe('Title q');
  });

  it('dates a wait with no request by when it was first seen, else its last activity', () => {
    const seen = new Map([['a:approval', 4_000]]);
    const items = waitingItems([session('a', { status: 'approval' }), session('b', { status: 'input' })], [], ctx({}, seen));
    expect(items.map((i) => [i.key, i.since, i.detail])).toEqual([
      ['a:approval', 4_000, 'approval'],
      ['b:question', 1_000, 'needs your answer'],
    ]);
  });

  it('leaves out a level that shows no hint (Silent), a floating popup, and an ended session', () => {
    const items = waitingItems(
      [
        session('silent', { status: 'input' }),
        session('quiet', { status: 'input' }),
        session('pop', { status: 'input', isFloating: true }),
        session('gone', { status: 'ended' }),
      ],
      [],
      ctx({ silent: 'silent', quiet: 'quiet' }),
    );
    expect(items.map((i) => i.sessionId)).toEqual(['quiet']);
  });

  it('lists a central’s alert at its level under the session’s own, and names the central when it is about another card', () => {
    const items = waitingItems(
      [session('c1', { title: 'Content Central' }), session('s1', { title: 'Pipeline Build' })],
      [alert({ level: 'urgent' }), alert({ id: 'a2', key: 'review', sessionId: 's1', updatedAt: 7_000, level: 'quiet' })],
      ctx({ c1: 'loud' }),
    );
    expect(items.map((i) => [i.key, i.kind, i.level, i.title, i.detail, i.from ?? null, i.alertId])).toEqual([
      ['alert:a2', 'alert', 'quiet', 'Pipeline Build', 'Package stuck 45m', 'Content Central', 'a2'],
      ['alert:a1', 'alert', 'loud', 'Content Central', 'Package stuck 45m', null, 'a1'],
    ]);
  });

  it('drops an alert on a Silent session, or on a session this window does not have', () => {
    const items = waitingItems([session('c1')], [alert(), alert({ id: 'a2', sessionId: 'nobody' })], ctx({ c1: 'silent' }));
    expect(items).toEqual([]);
  });
});

const item = (key: string, since = 1): WaitItem => ({
  key, kind: 'question', sessionId: key, title: key, detail: 'question', since, level: 'normal',
});

describe('newMoments', () => {
  it('never counts a first look', () => {
    expect(newMoments(null, [item('a')])).toEqual([]);
  });

  it('gives the items that were not there at the last look', () => {
    expect(newMoments(new Set(['a']), [item('a'), item('b')]).map((i) => i.key)).toEqual(['b']);
  });
});

describe('pruneHidden', () => {
  it('forgets a hidden item once its moment is over, so the next one shows', () => {
    const hidden = new Set(['a', 'b']);
    const next = pruneHidden(hidden, [item('a')]);
    expect([...next]).toEqual(['a']);
    expect(pruneHidden(next, [item('a')])).toBe(next);
  });
});

describe('mergeHint', () => {
  it('shows the newest moment, and folds moments close together into one hint', () => {
    const first = mergeHint(null, [item('a', 1)], 1_000);
    expect(first).toEqual({ item: item('a', 1), more: 0, shownAt: 1_000 });
    const merged = mergeHint(first, [item('b', 2), item('c', 3)], 1_000 + HINT_MERGE_MS - 1);
    expect(merged).toMatchObject({ item: { key: 'c' }, more: 2 });
    const fresh = mergeHint(merged, [item('d', 4)], 1_000 + HINT_MERGE_MS + 10_000);
    expect(fresh).toMatchObject({ item: { key: 'd' }, more: 0 });
  });

  it('keeps the hint it has when nothing is new', () => {
    const first = mergeHint(null, [item('a')], 1);
    expect(mergeHint(first, [], 2)).toBe(first);
    expect(mergeHint(null, [], 2)).toBeNull();
  });
});

describe('waitAge', () => {
  it('says how long it has waited, in one short word', () => {
    expect(waitAge(0, 59_000)).toBe('now');
    expect(waitAge(0, 4 * 60_000)).toBe('4m');
    expect(waitAge(0, 3 * 3_600_000 + 5)).toBe('3h');
    expect(waitAge(0, 50 * 3_600_000)).toBe('2d');
    expect(waitAge(10, 0)).toBe('now');
  });
});
