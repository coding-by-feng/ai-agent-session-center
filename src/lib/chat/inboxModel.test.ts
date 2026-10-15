// inboxModel.test.ts — what "needs you" means on the phone (AASC-39): the Inbox
// badge, the waiting list and the session screen's "N more need you ›" jump.
import { describe, it, expect } from 'vitest';
import type { Session } from '@/types';
import { inboxCount, needsYou, nextWaitingSession, waitingLine, waitingSessions } from './inboxModel';

function session(id: string, status: string, extra: Partial<Session> = {}): Session {
  return { sessionId: id, status, lastActivityAt: 0, ...extra } as unknown as Session;
}

const interruption = { kind: 'api-error', at: 1, message: '529' } as unknown as Session['interruption'];

describe('needsYou', () => {
  it('is an approval, a question or an interruption', () => {
    expect(needsYou(session('a', 'approval'))).toBe(true);
    expect(needsYou(session('a', 'input'))).toBe(true);
    expect(needsYou(session('a', 'waiting', { interruption }))).toBe(true);
  });

  it('is not working, finished, idle or ended (an ended one never needs you)', () => {
    for (const status of ['working', 'prompting', 'waiting', 'idle', 'connecting']) {
      expect(needsYou(session('a', status)), status).toBe(false);
    }
    expect(needsYou(session('a', 'ended', { interruption }))).toBe(false);
  });
});

describe('waitingSessions / inboxCount', () => {
  const sessions = new Map([
    ['a', session('a', 'working', { lastActivityAt: 5 })],
    ['b', session('b', 'approval', { lastActivityAt: 1 })],
    ['c', session('c', 'input', { lastActivityAt: 9 })],
    ['d', session('d', 'idle', { interruption, lastActivityAt: 3 })],
    ['e', session('e', 'ended', { lastActivityAt: 7 })],
  ]);

  it('lists the waiting sessions, the longest waiting first', () => {
    expect(waitingSessions(sessions).map((s) => s.sessionId)).toEqual(['b', 'd', 'c']);
  });

  it('counts them for the badge', () => {
    expect(inboxCount(sessions)).toBe(3);
    expect(inboxCount(new Map())).toBe(0);
  });
});

describe('nextWaitingSession', () => {
  const sessions = new Map([
    ['b', session('b', 'approval', { lastActivityAt: 1 })],
    ['c', session('c', 'input', { lastActivityAt: 2 })],
    ['d', session('d', 'approval', { lastActivityAt: 3 })],
    ['w', session('w', 'working', { lastActivityAt: 4 })],
  ]);

  it('steps to the next waiting session and wraps around', () => {
    expect(nextWaitingSession(sessions, 'b')).toBe('c');
    expect(nextWaitingSession(sessions, 'd')).toBe('b');
  });

  it('starts at the first one from a session that is not waiting', () => {
    expect(nextWaitingSession(sessions, 'w')).toBe('b');
  });

  it('is null when nothing else waits', () => {
    expect(nextWaitingSession(new Map([['b', session('b', 'approval')]]), 'b')).toBeNull();
    expect(nextWaitingSession(new Map(), 'x')).toBeNull();
  });
});

describe('waitingLine', () => {
  it('says what the session waits for', () => {
    expect(waitingLine(session('a', 'approval', { pendingTool: 'Bash', pendingToolDetail: 'npm test' }))).toBe('Wants to run: npm test');
    expect(waitingLine(session('a', 'approval'))).toBe('Wants your approval');
    expect(waitingLine(session('a', 'input', { waitingDetail: 'Which branch?' }))).toBe('Asks: Which branch?');
    expect(waitingLine(session('a', 'input'))).toBe('Has a question for you');
    expect(waitingLine(session('a', 'waiting', { interruption: { kind: 'x', line: 'API Error: 529', detectedAt: 1 } as unknown as Session['interruption'] })))
      .toBe('Stopped: API Error: 529');
  });
});
