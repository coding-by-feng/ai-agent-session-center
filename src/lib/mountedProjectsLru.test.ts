import { describe, it, expect } from 'vitest';
import { retainRecentProjects, isMostRecentProject } from './mountedProjectsLru';

/** Build a Map in least- → most-recently-used order. */
const lru = (...ids: string[]) => new Map(ids.map((id) => [id, { id }]));

describe('retainRecentProjects', () => {
  it('does not mutate the input map', () => {
    const prev = lru('a');
    const next = retainRecentProjects(prev, 'b', { id: 'b' }, 3);
    expect([...prev.keys()]).toEqual(['a']);
    expect(next).not.toBe(prev);
  });

  it('appends a new session as most-recently-used', () => {
    const next = retainRecentProjects(lru('a', 'b'), 'c', { id: 'c' }, 3);
    expect([...next.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('promotes a revisited session to most-recently-used', () => {
    const next = retainRecentProjects(lru('a', 'b', 'c'), 'a', { id: 'a' }, 3);
    expect([...next.keys()]).toEqual(['b', 'c', 'a']);
  });

  it('evicts the least-recently-used session past the cap', () => {
    const next = retainRecentProjects(lru('a', 'b', 'c'), 'd', { id: 'd' }, 3);
    expect([...next.keys()]).toEqual(['b', 'c', 'd']);
  });

  it('evicts as many as needed when the map starts oversized', () => {
    const next = retainRecentProjects(lru('a', 'b', 'c', 'd', 'e'), 'f', { id: 'f' }, 3);
    expect([...next.keys()]).toEqual(['d', 'e', 'f']);
  });

  it('never evicts the session just visited', () => {
    // 'a' is both the LRU entry and the one being visited — it must survive.
    const next = retainRecentProjects(lru('a', 'b', 'c'), 'a', { id: 'a' }, 1);
    expect([...next.keys()]).toEqual(['a']);
  });

  it('never evicts a pinned session, even when it is least-recently-used', () => {
    const next = retainRecentProjects(
      lru('a', 'b', 'c'),
      'd',
      { id: 'd' },
      3,
      (id) => id === 'a',
    );
    // 'a' is pinned (unsaved edits), so 'b' is dropped instead.
    expect([...next.keys()]).toEqual(['a', 'c', 'd']);
  });

  it('exceeds the cap rather than dropping unsaved work', () => {
    const next = retainRecentProjects(
      lru('a', 'b'),
      'c',
      { id: 'c' },
      1,
      (id) => id === 'a' || id === 'b',
    );
    expect([...next.keys()]).toEqual(['a', 'b', 'c']);
  });

  it('shrinks back to the cap once pins are released', () => {
    const oversized = lru('a', 'b', 'c');
    const next = retainRecentProjects(oversized, 'd', { id: 'd' }, 2);
    expect([...next.keys()]).toEqual(['c', 'd']);
  });

  it('replaces the stored entry for a revisited session', () => {
    const next = retainRecentProjects(lru('a'), 'a', { id: 'updated' }, 3);
    expect(next.get('a')).toEqual({ id: 'updated' });
  });

  it('handles an empty starting map', () => {
    const next = retainRecentProjects(new Map(), 'a', { id: 'a' }, 3);
    expect([...next.keys()]).toEqual(['a']);
  });
});

describe('isMostRecentProject', () => {
  it('is true only for the last-inserted key', () => {
    const mounted = lru('a', 'b', 'c');
    expect(isMostRecentProject(mounted, 'c')).toBe(true);
    expect(isMostRecentProject(mounted, 'b')).toBe(false);
    expect(isMostRecentProject(mounted, 'a')).toBe(false);
  });

  it('is false for an unknown session and for an empty map', () => {
    expect(isMostRecentProject(lru('a'), 'zzz')).toBe(false);
    expect(isMostRecentProject(new Map(), 'a')).toBe(false);
  });
});
