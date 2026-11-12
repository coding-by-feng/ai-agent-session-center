// projectsListModel.test.ts — the order a phone keeps for its By project list
// (Nov 4 2026): what localStorage may hold, how it applies, and what a drop saves
// when a filter hides some projects and others have no live session right now.
import { describe, it, expect } from 'vitest';
import { applyProjectOrder, parseProjectOrder, projectOrderAfterDrag } from './projectsListModel';

describe('parseProjectOrder', () => {
  it('reads anything malformed as no order', () => {
    for (const raw of [null, '', 'not json', '{"a":1}', '"a"', '42']) {
      expect(parseProjectOrder(raw)).toEqual([]);
    }
  });

  it('keeps only real keys, once each', () => {
    expect(parseProjectOrder(JSON.stringify(['a', 7, '', null, 'b', 'a']))).toEqual(['a', 'b']);
  });

  it('caps what it reads, so a corrupt value cannot grow forever', () => {
    const many = Array.from({ length: 250 }, (_, i) => `k${i}`);
    const read = parseProjectOrder(JSON.stringify(many));
    expect(read).toHaveLength(200);
    expect(read[0]).toBe('k0');
    expect(read[199]).toBe('k199');
  });
});

describe('applyProjectOrder', () => {
  const self = (k: string) => k;

  it('leaves the list as it came when nothing is stored', () => {
    expect(applyProjectOrder(['app', 'site', 'web'], self, [])).toEqual(['app', 'site', 'web']);
  });

  it('puts stored projects in their order and a new one after them, so nothing shifts when it appears', () => {
    expect(applyProjectOrder(['app', 'new', 'site', 'web'], self, ['web', 'app', 'site'])).toEqual(['web', 'app', 'site', 'new']);
  });

  it('skips a stored project that has no live session right now', () => {
    expect(applyProjectOrder(['app', 'site'], self, ['gone', 'site', 'app'])).toEqual(['site', 'app']);
  });

  it('never changes what it was given', () => {
    const items = ['app', 'site'];
    applyProjectOrder(items, self, ['site', 'app']);
    expect(items).toEqual(['app', 'site']);
  });
});

describe('projectOrderAfterDrag', () => {
  it('first drag: a project a filter hides keeps its slot', () => {
    // On screen: app and web (site hidden). web is carried above app.
    expect(projectOrderAfterDrag([], ['app', 'site', 'web'], ['web', 'app'])).toEqual(['web', 'site', 'app']);
  });

  it('a project with no live session right now keeps its slot too', () => {
    // x has no session; b is hidden by a filter. c is carried above a.
    expect(projectOrderAfterDrag(['a', 'x', 'b', 'c'], ['a', 'b', 'c'], ['c', 'a'])).toEqual(['c', 'x', 'b', 'a']);
  });

  it('takes in a live project the stored order has not met yet', () => {
    // Shown as b, a, c: c is new, so it sits last until it is carried to the top.
    expect(projectOrderAfterDrag(['b', 'a'], ['a', 'b', 'c'], ['c', 'b', 'a'])).toEqual(['c', 'b', 'a']);
  });

  it('is null when nothing moves', () => {
    expect(projectOrderAfterDrag(['b', 'a'], ['a', 'b'], ['b', 'a'])).toBeNull();
    expect(projectOrderAfterDrag([], ['a', 'b'], ['a', 'b'])).toBeNull();
  });

  it('never saves more than it can read back', () => {
    const stored = Array.from({ length: 200 }, (_, i) => `k${i}`);
    const after = projectOrderAfterDrag(stored, [...stored, 'new'], ['new', 'k0']);
    expect(after).toHaveLength(200);
    expect(after?.[0]).toBe('new');
  });

  describe('at the limit, with old projects filling the list', () => {
    const dead = (n: number) => Array.from({ length: n }, (_, i) => `dead${i}`);

    it('a drop between two new projects still lands', () => {
      // Shown as A, B, C. B and C are past the 200th slot, so a plain cut would save nothing new.
      const after = projectOrderAfterDrag([...dead(199), 'A'], ['A', 'B', 'C'], ['A', 'C', 'B']);
      expect(after).toHaveLength(200);
      expect(after?.slice(-3)).toEqual(['A', 'C', 'B']);
    });

    it('forgets a project with no live session, never a live one', () => {
      const after = projectOrderAfterDrag([...dead(198), 'A', 'B'], ['A', 'B', 'N'], ['N', 'A', 'B']);
      expect(after).toHaveLength(200);
      expect(after?.slice(-3)).toEqual(['N', 'A', 'B']);
    });

    it('forgets the oldest first: the keys at the front have sat longest', () => {
      const after = projectOrderAfterDrag([...dead(199), 'A'], ['A', 'B', 'C'], ['A', 'C', 'B']);
      expect(after?.[0]).toBe('dead2');
    });
  });
});
