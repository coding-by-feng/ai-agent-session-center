import { describe, it, expect } from 'vitest';
import { buildDigest, statusChanges, DIGEST_MAX, type DigestSession } from '../../server/voice/digest.js';

const NOW = Date.UTC(2026, 10, 15, 7, 0, 0);
const s = (over: Partial<DigestSession>): DigestSession => ({
  sessionId: over.sessionId ?? 'id',
  title: 'Card',
  status: 'idle',
  lastActivityAt: NOW,
  isCentral: false,
  ...over,
});

describe('buildDigest', () => {
  it('groups sessions by what they need, waiting-for-you first', () => {
    const text = buildDigest([
      s({ sessionId: '1', title: 'Fix login', status: 'approval' }),
      s({ sessionId: '2', title: 'Codex review', status: 'working', lastActivityAt: NOW - 120_000 }),
      s({ sessionId: '3', title: 'Plan usage', status: 'waiting', lastActivityAt: NOW - 4 * 60_000 }),
      s({ sessionId: '4', title: 'Old', status: 'idle' }),
    ], NOW);
    expect(text).toMatch(/^AASC status: 4 sessions\./);
    expect(text.indexOf('Fix login')).toBeLessThan(text.indexOf('Codex review'));
    expect(text).toContain('Needs the user: "Fix login" (approval)');
    expect(text).toContain('Working: "Codex review"');
    expect(text).toContain('Finished recently: "Plan usage" (4 min ago)');
    expect(text).toContain('Idle: 1');
  });

  it('leaves out ended sessions and centrals', () => {
    const text = buildDigest([
      s({ sessionId: '1', status: 'ended', title: 'Gone' }),
      s({ sessionId: '2', isCentral: true, title: 'Brain' }),
      s({ sessionId: '3', title: 'Only' }),
    ], NOW);
    expect(text).not.toContain('Gone');
    expect(text).not.toContain('Brain');
    expect(text).toMatch(/1 session\./);
  });

  it('says so when there is nothing', () => {
    expect(buildDigest([], NOW)).toBe('AASC status: no sessions are open.');
  });

  it('stays within the limit with many long titles', () => {
    const many = Array.from({ length: 80 }, (_, i) => s({ sessionId: String(i), title: `T${i} ${'x'.repeat(80)}`, status: 'working' }));
    const text = buildDigest(many, NOW);
    expect(text.length).toBeLessThanOrEqual(DIGEST_MAX);
    expect(text).toMatch(/and \d+ more/);
  });

  it('counts a finished session older than 30 minutes as idle', () => {
    expect(buildDigest([s({ status: 'waiting', lastActivityAt: NOW - 31 * 60_000 })], NOW)).toContain('Idle: 1');
  });
});

describe('statusChanges', () => {
  it('reports sessions that went from busy to finished, and ones that now need the user', () => {
    const prev = new Map([['a', 'working'], ['b', 'prompting'], ['c', 'waiting'], ['d', 'working']]);
    const next = [
      s({ sessionId: 'a', title: 'A', status: 'waiting' }),
      s({ sessionId: 'b', title: 'B', status: 'input' }),
      s({ sessionId: 'c', title: 'C', status: 'waiting' }),
      s({ sessionId: 'd', title: 'D', status: 'working' }),
    ];
    expect(statusChanges(prev, next)).toEqual({ finished: ['A'], finishedIds: ['a'], needsUser: ['B'] });
  });

  it('ignores centrals and sessions it never saw', () => {
    const prev = new Map([['a', 'working']]);
    const next = [s({ sessionId: 'a', isCentral: true, status: 'waiting' }), s({ sessionId: 'z', status: 'waiting' })];
    expect(statusChanges(prev, next)).toEqual({ finished: [], finishedIds: [], needsUser: [] });
  });
});
