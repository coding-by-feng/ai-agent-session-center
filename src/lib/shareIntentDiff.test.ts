import { describe, it, expect } from 'vitest';
import { handsOffIntentChanged, shareIntentChanged } from './shareIntentDiff';
import type { Session } from '@/types';

const s = (id: string, remoteVisible?: boolean) => ({ sessionId: id, remoteVisible }) as unknown as Session;
const h = (id: string, handsOff?: boolean) => ({ sessionId: id, handsOff }) as unknown as Session;
const map = (...xs: Session[]) => new Map(xs.map((x) => [x.sessionId, x]));

describe('shareIntentChanged', () => {
  it('sees a share and an un-share', () => {
    expect(shareIntentChanged(map(s('a')), map(s('a', true)))).toBe(true);
    expect(shareIntentChanged(map(s('a', true)), map(s('a', false)))).toBe(true);
  });

  it('treats absent and false as the same (both hidden)', () => {
    expect(shareIntentChanged(map(s('a')), map(s('a', false)))).toBe(false);
  });

  it('ignores sessions that appear, end or are re-keyed', () => {
    expect(shareIntentChanged(map(s('a')), map(s('a'), s('b', true)))).toBe(false);
    expect(shareIntentChanged(map(s('a', true), s('b')), map(s('a', true)))).toBe(false);
    expect(shareIntentChanged(map(s('term-1', true)), map(s('cli-1', true)))).toBe(false);
  });

  it('is false for the same map', () => {
    const m = map(s('a', true));
    expect(shareIntentChanged(m, m)).toBe(false);
  });

  it('does not take a hands-off flip for a share decision', () => {
    expect(shareIntentChanged(map(h('a')), map(h('a', true)))).toBe(false);
  });
});

// Hands off (server/mcp) is the person's other per-session switch: a flip must reach the snapshot as fast as a
// share does, because a restore recreates the card with `handsOff` from the snapshot only.
describe('handsOffIntentChanged', () => {
  it('sees Hands off turned on and turned off', () => {
    expect(handsOffIntentChanged(map(h('a')), map(h('a', true)))).toBe(true);
    expect(handsOffIntentChanged(map(h('a', true)), map(h('a', false)))).toBe(true);
    expect(handsOffIntentChanged(map(h('a', true)), map(h('a')))).toBe(true);
  });

  it('treats absent and false as the same (both open to centrals)', () => {
    expect(handsOffIntentChanged(map(h('a')), map(h('a', false)))).toBe(false);
  });

  it('is false while the flag stays as it was', () => {
    expect(handsOffIntentChanged(map(h('a', true)), map(h('a', true)))).toBe(false);
  });

  it('ignores sessions that appear, end or are re-keyed', () => {
    expect(handsOffIntentChanged(map(h('a')), map(h('a'), h('b', true)))).toBe(false);
    expect(handsOffIntentChanged(map(h('a', true), h('b')), map(h('a', true)))).toBe(false);
    expect(handsOffIntentChanged(map(h('term-1', true)), map(h('cli-1', true)))).toBe(false);
  });

  it('is false for the same map', () => {
    const m = map(h('a', true));
    expect(handsOffIntentChanged(m, m)).toBe(false);
  });

  it('does not take a share flip for a hands-off decision', () => {
    expect(handsOffIntentChanged(map(s('a')), map(s('a', true)))).toBe(false);
  });

  it('sees a flip on any one session among many', () => {
    expect(handsOffIntentChanged(map(h('a'), h('b'), h('c')), map(h('a'), h('b'), h('c', true)))).toBe(true);
  });
});
