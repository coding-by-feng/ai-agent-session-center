// sessionNeeds.test.ts — the two numbers behind this computer's "N sessions · M need you".
import { describe, it, expect } from 'vitest';
import { countListedSessions, countSessionsNeedingYou } from './sessionNeeds';
import type { Session, SessionStatus } from '@/types';

function sessions(...list: [string, SessionStatus, Partial<Session>?][]): Map<string, Session> {
  return new Map(list.map(([sessionId, status, over]) => [sessionId, { sessionId, status, ...over } as Session]));
}

describe('sessionNeeds', () => {
  it('counts the listed sessions, and those waiting for an approval or an answer', () => {
    const all = sessions(['a', 'working'], ['b', 'approval'], ['c', 'input'], ['d', 'idle'], ['e', 'waiting'], ['f', 'prompting'], ['g', 'connecting']);
    expect(countListedSessions(all)).toBe(7);
    expect(countSessionsNeedingYou(all)).toBe(2);
  });

  it('leaves out an ended session and an AI popup’s, whatever they wait for', () => {
    const all = sessions(['a', 'input'], ['gone', 'ended'], ['popup', 'approval', { isFloating: true }]);
    expect(countListedSessions(all)).toBe(1);
    expect(countSessionsNeedingYou(all)).toBe(1);
  });

  it('is zero and zero with no sessions', () => {
    expect(countListedSessions(new Map())).toBe(0);
    expect(countSessionsNeedingYou(new Map())).toBe(0);
  });
});
