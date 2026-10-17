import { describe, it, expect } from 'vitest';
import { shareIntentChanged } from './shareIntentDiff';
import type { Session } from '@/types';

const s = (id: string, remoteVisible?: boolean) => ({ sessionId: id, remoteVisible }) as unknown as Session;
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
});
