import { describe, expect, it } from 'vitest';
import type { Session } from '@/types';
import { RESTART_GIVE_UP_MS, findRestartedSession, restartStep, type RestartTrack } from './restartProgress';

const T = 1_000_000;
const NEW = 'term-new';
const OLD = 'term-old';

function track(over: Partial<RestartTrack> = {}): RestartTrack {
  return { sessionId: 's1', name: 'KTS', cli: 'Claude', phase: 'starting', terminalId: NEW, error: null, startedAt: T, ...over };
}

function session(over: Partial<Session> = {}): Session {
  return { sessionId: 's1', status: 'connecting', terminalId: NEW, ...over } as unknown as Session;
}

describe('restartStep', () => {
  it('waits while the agent is still starting on the new terminal', () => {
    expect(restartStep(track(), session(), T + 1_000)).toBeNull();
  });

  it('waits while the card still shows the old terminal (the reply beat the broadcast)', () => {
    expect(restartStep(track(), session({ status: 'idle', terminalId: OLD }), T + 1_000)).toBeNull();
  });

  it('is done once the card leaves connecting on the new terminal', () => {
    expect(restartStep(track(), session({ status: 'idle' }), T + 5_000)).toEqual({ phase: 'done', error: null });
    expect(restartStep(track(), session({ status: 'waiting' }), T + 5_000)?.phase).toBe('done');
  });

  it('fails when the Mac gave up on it (left ended, no terminal)', () => {
    const step = restartStep(track(), session({ status: 'ended', terminalId: null }), T + 3_000);
    expect(step?.phase).toBe('failed');
    expect(step?.error).toMatch(/Resume in Info/);
  });

  it('fails when the resume timed out (back to idle, terminal unlinked)', () => {
    const step = restartStep(track(), session({ status: 'idle', terminalId: null }), T + 120_000);
    expect(step?.phase).toBe('failed');
    expect(step?.error).toMatch(/didn’t start/);
  });

  it('fails when the session is gone', () => {
    expect(restartStep(track(), undefined, T + 1_000)?.phase).toBe('failed');
  });

  it('gives up by itself when no word comes (the Mac’s own timeout was missed)', () => {
    expect(restartStep(track(), session(), T + RESTART_GIVE_UP_MS - 1)).toBeNull();
    expect(restartStep(track(), session(), T + RESTART_GIVE_UP_MS)?.phase).toBe('failed');
  });

  it('leaves a finished or not-yet-answered restart alone', () => {
    expect(restartStep(track({ phase: 'stopping', terminalId: null }), session({ status: 'idle' }), T)).toBeNull();
    expect(restartStep(track({ phase: 'done' }), session({ status: 'ended', terminalId: null }), T)).toBeNull();
  });
});

describe('findRestartedSession', () => {
  it('finds the card by its id, or by the id it replaced (a re-keyed resume)', () => {
    const same = session();
    expect(findRestartedSession(new Map([['s1', same]]), 's1')).toBe(same);
    const rekeyed = session({ sessionId: 's2', replacesId: 's1' } as Partial<Session>);
    expect(findRestartedSession(new Map([['s2', rekeyed]]), 's1')).toBe(rekeyed);
    expect(findRestartedSession(new Map(), 's1')).toBeUndefined();
  });
});
