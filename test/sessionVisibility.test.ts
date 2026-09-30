import { describe, it, expect } from 'vitest';
import {
  canSeeSession,
  filterVisibleSessions,
  countHiddenSessions,
} from '../server/sessionVisibility.js';

const LOCAL = true;
const REMOTE = false;

describe('canSeeSession', () => {
  it('lets localhost see everything, opted in or not', () => {
    expect(canSeeSession(LOCAL, { remoteVisible: true })).toBe(true);
    expect(canSeeSession(LOCAL, { remoteVisible: false })).toBe(true);
    expect(canSeeSession(LOCAL, {})).toBe(true);
  });

  it('shows a remote client only what was opted in', () => {
    expect(canSeeSession(REMOTE, { remoteVisible: true })).toBe(true);
  });

  it.each([
    ['never set (pre-feature row)', {}],
    ['explicitly false', { remoteVisible: false }],
    ['null from a SQLite column', { remoteVisible: null }],
  ])('hides a session from a remote client when remoteVisible is %s', (_l, session) => {
    // Deny by default is the whole point: a session that predates this feature,
    // or one nobody has thought about, must not be exposed.
    expect(canSeeSession(REMOTE, session)).toBe(false);
  });

  it('hides a missing session from remote rather than erroring', () => {
    // A remote client must not be able to tell "no such session" apart from
    // "hidden from you" — otherwise the 404/403 split enumerates session ids.
    expect(canSeeSession(REMOTE, null)).toBe(false);
    expect(canSeeSession(REMOTE, undefined)).toBe(false);
  });

  it('still resolves a missing session for localhost', () => {
    expect(canSeeSession(LOCAL, null)).toBe(true);
  });
});

describe('filterVisibleSessions', () => {
  const sessions = {
    a: { remoteVisible: true },
    b: { remoteVisible: false },
    c: {},
    d: { remoteVisible: true },
  };

  it('returns the SAME object for localhost (no per-broadcast rebuild)', () => {
    // Identity, not deep-equality: this runs on the hottest path in the server.
    expect(filterVisibleSessions(LOCAL, sessions)).toBe(sessions);
  });

  it('returns only opted-in sessions for a remote client', () => {
    expect(Object.keys(filterVisibleSessions(REMOTE, sessions)).sort()).toEqual(['a', 'd']);
  });

  it('does not mutate the input', () => {
    const before = JSON.stringify(sessions);
    filterVisibleSessions(REMOTE, sessions);
    expect(JSON.stringify(sessions)).toBe(before);
  });

  it('returns an empty record when nothing is opted in', () => {
    expect(filterVisibleSessions(REMOTE, { x: {}, y: { remoteVisible: false } })).toEqual({});
  });

  it('handles an empty session set', () => {
    expect(filterVisibleSessions(REMOTE, {})).toEqual({});
  });
});

describe('countHiddenSessions', () => {
  it('reports zero for localhost, which is withheld nothing', () => {
    expect(countHiddenSessions(LOCAL, { a: {}, b: {} })).toBe(0);
  });

  it('counts what a remote client is not being shown', () => {
    // Surfaced in the UI so a phone shows "18 hidden" instead of looking broken.
    expect(countHiddenSessions(REMOTE, {
      a: { remoteVisible: true },
      b: {},
      c: { remoteVisible: false },
    })).toBe(2);
  });
});
