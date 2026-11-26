import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('../server/logger.js', () => ({ default: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { createLaunchQueue } from '../server/launchQueue.js';

describe('launchQueue (restore pacing, Nov 25 2026)', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  function setup(max = 2, slotTimeoutMs = 1000) {
    const started: string[] = [];
    const q = createLaunchQueue({ max, slotTimeoutMs });
    const add = (id: string) => q.enqueue(id, () => { started.push(id); });
    return { q, started, add };
  }

  it('starts at most `max` launches, in order, and the next when one reports', () => {
    const { q, started, add } = setup(2);
    ['a', 'b', 'c', 'd'].forEach(add);
    expect(started).toEqual(['a', 'b']);
    expect(q.stats()).toEqual({ running: 2, waiting: 2 });
    q.release('b');
    expect(started).toEqual(['a', 'b', 'c']);
    q.release('a');
    expect(started).toEqual(['a', 'b', 'c', 'd']);
  });

  it('frees a slot after the timeout when a CLI never reports', () => {
    const { started, add } = setup(1, 1000);
    ['a', 'b'].forEach(add);
    vi.advanceTimersByTime(999);
    expect(started).toEqual(['a']);
    vi.advanceTimersByTime(1);
    expect(started).toEqual(['a', 'b']);
  });

  it('drops a waiting launch whose terminal went away', () => {
    const { q, started, add } = setup(1);
    ['a', 'b', 'c'].forEach(add);
    q.release('b');
    q.release('a');
    expect(started).toEqual(['a', 'c']);
  });

  it('starts an opened card at once, even past `max`', () => {
    const { q, started, add } = setup(1);
    ['a', 'b', 'c'].forEach(add);
    q.promote('c');
    expect(started).toEqual(['a', 'c']);
    expect(q.stats()).toEqual({ running: 2, waiting: 1 });
    q.promote('a'); // already running: nothing happens
    expect(started).toEqual(['a', 'c']);
  });

  it('ignores a second enqueue for one terminal and a release for an unknown one', () => {
    const { q, started, add } = setup(2);
    add('a');
    add('a');
    q.release('zzz');
    expect(started).toEqual(['a']);
    expect(q.stats()).toEqual({ running: 1, waiting: 0 });
  });

  it('frees the slot of a launch that throws', () => {
    const q = createLaunchQueue({ max: 1, slotTimeoutMs: 1000 });
    const started: string[] = [];
    q.enqueue('bad', () => { throw new Error('boom'); });
    q.enqueue('good', () => { started.push('good'); });
    expect(started).toEqual(['good']);
  });
});
