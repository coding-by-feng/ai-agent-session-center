import { describe, it, expect } from 'vitest';
import { recentRailIds } from './useSessionStrip';
import type { Session } from '@/types/session';

const NOW = 1_794_722_740_000;
const session = (sessionId: string, over: Partial<Session> = {}): Session => ({
  sessionId,
  status: 'waiting',
  events: [{ type: 'Stop', timestamp: NOW - 60_000, detail: '' }],
  ...over,
} as Session);

describe('recentRailIds (the session rail\'s RECENT frame)', () => {
  it('never lists an AI popup session: it belongs to its popup, and closing the popup must leave no card', () => {
    const sessions = new Map([
      ['main', session('main')],
      ['vocab-float', session('vocab-float', { isFloating: true, isFork: true, originSessionId: 'main' })],
    ]);
    expect(recentRailIds(sessions, NOW)).toEqual(['main']);
  });

  it('leaves out ended sessions, as before', () => {
    const sessions = new Map([['gone', session('gone', { status: 'ended' })]]);
    expect(recentRailIds(sessions, NOW)).toEqual([]);
  });
});
