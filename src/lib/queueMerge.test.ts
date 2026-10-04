import { describe, it, expect } from 'vitest';
import { mergeQueueItems } from './queueMerge';
import type { QueueItem } from '@/stores/queueStore';

const item = (id: number, over: Partial<QueueItem> = {}): QueueItem => ({
  id,
  sessionId: 's1',
  text: `prompt ${id}`,
  position: 0,
  createdAt: 1,
  ...over,
});

/** A list with positions 0..n-1, the shape the store keeps. */
const list = (...items: QueueItem[]): QueueItem[] => items.map((it, i) => ({ ...it, position: i }));
const ids = (items: readonly QueueItem[]) => items.map((i) => i.id);
const textOf = (items: readonly QueueItem[], id: number) => items.find((i) => i.id === id)?.text;

const X = item(1);
const Y = item(2);
const Z = item(3);

// `mergeQueueItems(base, local, remote)`: base is the list this window last knew the
// server to hold, local is what it holds now (with edits the server has not seen), and
// remote is what just arrived. The result is what to hold AND push next.
describe('mergeQueueItems', () => {
  it('is just the remote list when this window has changed nothing since base', () => {
    const base = list(X, Y);
    const remote = list(X, Y, Z);
    expect(ids(mergeQueueItems(base, base, remote))).toEqual([1, 2, 3]);
  });

  it('does not bring back an item this window sent and removed (the double-send)', () => {
    // M's scheduler sent X and removed it; F's push, built before it saw that, still has X.
    const base = list(X, Y);
    const local = list(Y);
    const remote = list(X, Y, Z);
    expect(ids(mergeQueueItems(base, local, remote))).toEqual([2, 3]);
  });

  it("keeps the other window's add alongside this window's removal", () => {
    const merged = mergeQueueItems(list(X, Y), list(Y), list(X, Y, Z));
    expect(ids(merged)).toContain(3);
    expect(ids(merged)).not.toContain(1);
  });

  it('keeps an item only this window added, after the remote ones', () => {
    // The mirror image: F's pending add must survive M's removal arriving.
    const base = list(X, Y);
    const local = list(X, Y, Z);
    const remote = list(Y);
    expect(ids(mergeQueueItems(base, local, remote))).toEqual([2, 3]);
  });

  it('puts remote items first, in the remote order, then this window’s additions', () => {
    const base = list(X);
    const local = list(X, item(10), item(11));
    const remote = list(item(5), X, item(6));
    expect(ids(mergeQueueItems(base, local, remote))).toEqual([5, 1, 6, 10, 11]);
  });

  it('takes the remote copy of an item this window left alone', () => {
    const base = list(X, Y);
    const local = list(X, Y);
    const remote = list(X, { ...Y, text: 'edited elsewhere' });
    expect(textOf(mergeQueueItems(base, local, remote), 2)).toBe('edited elsewhere');
  });

  it('keeps this window’s copy of an item it edited', () => {
    const base = list(X, Y);
    const local = list(X, { ...Y, text: 'edited here' });
    const remote = list(X, { ...Y, text: 'edited elsewhere' });
    expect(textOf(mergeQueueItems(base, local, remote), 2)).toBe('edited here');
  });

  describe('an item both sides changed', () => {
    // The scheduler keeps rewriting an item's own bookkeeping (lastFiredAt, nextFireAt, execState)
    // while someone edits its text in another window. Keeping one side's whole copy would throw the
    // other side's change away, so the item is merged field by field.
    it('keeps both when the changes are to different fields', () => {
      const base = list({ ...X, totalFires: 1 });
      const local = list({ ...X, totalFires: 2, lastFiredAt: 500 }); // the scheduler fired it here
      const remote = list({ ...X, totalFires: 1, text: 'reworded in the float' });
      const merged = mergeQueueItems(base, local, remote)[0];
      expect(merged.text).toBe('reworded in the float');
      expect(merged.totalFires).toBe(2);
      expect(merged.lastFiredAt).toBe(500);
    });

    it('lets this window win a field both of them changed', () => {
      const base = list(X);
      const local = list({ ...X, text: 'mine' });
      const remote = list({ ...X, text: 'theirs' });
      expect(textOf(mergeQueueItems(base, local, remote), 1)).toBe('mine');
    });

    it('keeps a field this window cleared cleared', () => {
      // ⚡ NOW's `forceStart` is consumed here after it fires; the remote copy still says true.
      const base = list({ ...X, forceStart: true });
      const local = list({ ...X, forceStart: undefined });
      const remote = list({ ...X, forceStart: true, text: 'reworded in the float' });
      const merged = mergeQueueItems(base, local, remote)[0];
      expect(merged.forceStart).toBeUndefined();
      expect(Object.keys(merged)).not.toContain('forceStart'); // gone, not set to undefined
      expect(merged.text).toBe('reworded in the float');
    });

    it('merges nested values as a whole: the chain this window changed replaces the other one', () => {
      const base = list({ ...X, beforeChain: [{ id: 1, text: 'a' }] });
      const local = list({ ...X, beforeChain: [{ id: 1, text: 'b' }] });
      const remote = list({ ...X, beforeChain: [{ id: 1, text: 'c' }], text: 'reworded in the float' });
      const merged = mergeQueueItems(base, local, remote)[0];
      expect(merged.beforeChain).toEqual([{ id: 1, text: 'b' }]);
      expect(merged.text).toBe('reworded in the float');
    });

    it('takes the position and the session from the remote list, which the merge numbers itself', () => {
      const base = list(X, Y);
      const local = list({ ...Y, text: 'edited here' }, { ...X });
      const remote = list(X, Y);
      const merged = mergeQueueItems(base, local, remote);
      expect(ids(merged)).toEqual([1, 2]);
      expect(merged.map((i) => i.position)).toEqual([0, 1]);
    });
  });

  it('keeps this window’s edit when the other side did not touch the item', () => {
    const base = list(X, Y);
    const local = list(X, { ...Y, text: 'edited here' });
    const remote = list(X, Y, Z);
    const merged = mergeQueueItems(base, local, remote);
    expect(textOf(merged, 2)).toBe('edited here');
    expect(ids(merged)).toEqual([1, 2, 3]);
  });

  it('lets a remote deletion beat a local edit of that item', () => {
    // Someone removed Y (it was sent). Editing it here must not resurrect it.
    const base = list(X, Y);
    const local = list(X, { ...Y, text: 'edited here' });
    const remote = list(X);
    expect(ids(mergeQueueItems(base, local, remote))).toEqual([1]);
  });

  it('drops an unchanged item the remote deleted', () => {
    expect(ids(mergeQueueItems(list(X, Y), list(X, Y), list(X)))).toEqual([1]);
  });

  it('treats everything local as new when there is no base, and keeps the remote items too', () => {
    // A session this window created and has not synced yet.
    const merged = mergeQueueItems([], list(Z), list(X, Y));
    expect(ids(merged)).toEqual([1, 2, 3]);
  });

  it('prefers the local copy of an id both sides hold when there is no base to say who changed it', () => {
    const local = list({ ...X, text: 'mine' });
    const remote = list({ ...X, text: 'theirs' });
    expect(textOf(mergeQueueItems([], local, remote), 1)).toBe('mine');
  });

  it('numbers the result densely in list order', () => {
    const merged = mergeQueueItems(list(X, Y), list(Y), list(X, Y, Z));
    expect(merged.map((i) => i.position)).toEqual([0, 1]);
    expect(ids(merged)).toEqual([2, 3]);
  });

  describe('what counts as "this window changed the item"', () => {
    it('ignores position: a renumbering is not an edit', () => {
      const base = list(X, Y);
      const local = [{ ...X, position: 7 }, { ...Y, position: 9 }];
      const remote = list({ ...X, text: 'edited elsewhere' }, Y);
      const merged = mergeQueueItems(base, local, remote);
      expect(textOf(merged, 1)).toBe('edited elsewhere');
      // Nothing was changed here, so the remote's own objects come back untouched.
      expect(merged[0]).toBe(remote[0]);
      expect(merged[1]).toBe(remote[1]);
    });

    it('ignores sessionId: a re-key is not an edit', () => {
      const base = list(X);
      const local = list({ ...X, sessionId: 'rekeyed' });
      const remote = list({ ...X, text: 'edited elsewhere' });
      const merged = mergeQueueItems(base, local, remote);
      expect(textOf(merged, 1)).toBe('edited elsewhere');
      expect(merged[0]).toBe(remote[0]);
    });

    it('does count a change inside a nested field', () => {
      const base = list({ ...X, beforeChain: [{ id: 1, text: 'a' }] });
      const local = list({ ...X, beforeChain: [{ id: 1, text: 'b' }] });
      const remote = list({ ...X, beforeChain: [{ id: 1, text: 'a' }], text: 'edited elsewhere' });
      const merged = mergeQueueItems(base, local, remote)[0];
      // The chain edit is this window's change and survives; the text edit is the remote's and lands too.
      expect(merged.beforeChain).toEqual([{ id: 1, text: 'b' }]);
      expect(merged.text).toBe('edited elsewhere');
    });

    it('does not count a field that is absent on one side and undefined on the other', () => {
      const base = list(X);
      const local = list({ ...X, intervalMs: undefined });
      const remote = list({ ...X, text: 'edited elsewhere' });
      expect(textOf(mergeQueueItems(base, local, remote), 1)).toBe('edited elsewhere');
    });

    it('does count a flipped flag such as ⚡ NOW', () => {
      const base = list(X);
      const local = list({ ...X, forceStart: true });
      const remote = list({ ...X, text: 'edited elsewhere' });
      expect(mergeQueueItems(base, local, remote)[0].forceStart).toBe(true);
    });
  });

  it('never modifies the lists it is given', () => {
    const deepFreeze = <T extends object>(o: T): T => {
      Object.values(o).forEach((v) => { if (v && typeof v === 'object') deepFreeze(v as object); });
      return Object.freeze(o);
    };
    const base = deepFreeze(list(X, Y));
    const local = deepFreeze(list(Y, item(9)));
    const remote = deepFreeze(list(X, Y, Z));
    expect(() => mergeQueueItems(base, local, remote)).not.toThrow();
  });

  it('returns an empty list when nothing is left on either side', () => {
    expect(mergeQueueItems(list(X), [], [])).toEqual([]);
    expect(mergeQueueItems([], [], [])).toEqual([]);
  });
});
