// test/mcp/queueOps.test.ts — the queue's pure operations (server/mcp/queueOps.ts) and the one synchronous
// read-modify-write that applies them. Each op takes the queue as it is and answers a new one: the ids follow the
// client's scheme (`max(now, maxId + 1)`), positions are clamped, an id that is not there is NOT_FOUND, and nothing
// it is given is changed. `applyQueueOp` reads the row, applies the op and writes, with nothing in between.
import { describe, expect, it } from 'vitest';
import { appendPausedItem } from '../../server/sessionQueueCodec.js';
import {
  addItem,
  addStep,
  applyQueueOp,
  clearItems,
  editItem,
  editStep,
  fireNow,
  moveItem,
  moveStep,
  QUEUE_PAYLOAD_MAX,
  queueItemIds,
  removeItem,
  removeStep,
  setAutomation,
  setAutoSend,
  setItemEnabled,
  setItemSchedule,
  setPaused,
} from '../../server/mcp/queueOps.js';
import { deepFreeze } from './readFixtures.js';
import {
  automationOf,
  fakeQueueStore,
  idsOf,
  item,
  itemWith,
  NOW,
  queueOf,
  refusalOf,
  stateOf,
} from './queueFixtures.js';

const NEEDLE = 424_242;

/** A refusal's words and hint as one string: nothing a caller sent may be in it. */
const words = (e: { message: string; hint?: string }): string => `${e.message} ${e.hint ?? ''}`;

// ---------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------

describe('addItem', () => {
  const add = (state = stateOf([]), over: Record<string, unknown> = {}) =>
    addItem(state, { sessionId: 's1', text: 'next', disabled: true, ...over } as Parameters<typeof addItem>[1], NOW);

  it('appends last, with the id max(now, maxId + 1) and the position after the last', () => {
    const out = add(stateOf([item(NOW + 50, { position: 0 }), item(5, { position: 1 })]));

    expect(out.result.itemId).toBe(NOW + 51);
    expect(out.items).toHaveLength(3);
    expect(out.items[2]).toEqual({ id: NOW + 51, sessionId: 's1', text: 'next', position: 2, createdAt: NOW, disabled: true });
  });

  it('takes now for the id when it is later than every id there is', () => {
    expect(add(stateOf([item(5)])).result.itemId).toBe(NOW);
    expect(add().result.itemId).toBe(NOW);
  });

  it('agrees with the phone share path (appendPausedItem) on the id and the position of an append', () => {
    const base = [item(NOW + 7, { position: 0 }), item(9, { position: 4 })];

    const mine = add(stateOf(base)).items;
    const theirs = appendPausedItem(base, 's1', 'next', NOW);

    expect(mine).toEqual(theirs);
  });

  it('adds enabled when it is told to (the key is left out, as the dashboard leaves it)', () => {
    const out = add(stateOf([]), { disabled: false });

    expect(out.items[0]).not.toHaveProperty('disabled');
  });

  it('inserts at a position and numbers the whole queue 0..n-1', () => {
    const out = add(stateOf([item(1, { position: 0 }), item(2, { position: 5 })]), { position: 1 });

    expect(idsOf(out.items)).toEqual([1, NOW, 2]);
    expect(out.items.map((i) => (i as { position: number }).position)).toEqual([0, 1, 2]);
  });

  it('clamps a position to the queue: below 0 is the front, past the end is the end', () => {
    expect(idsOf(add(stateOf(queueOf(1, 2)), { position: -4 }).items)).toEqual([NOW, 1, 2]);
    expect(idsOf(add(stateOf(queueOf(1, 2)), { position: 99 }).items)).toEqual([1, 2, NOW]);
    // A negative place must not count from the end, as an array index would: on a longer queue it shows.
    expect(idsOf(add(stateOf(queueOf(1, 2, 3, 4)), { position: -1 }).items)).toEqual([NOW, 1, 2, 3, 4]);
  });

  it('cleans the text: both ends trimmed, CRLF as LF, control bytes out', () => {
    const out = add(stateOf([]), { text: '  hello\r\nworld\u001b[31m\u0007 a\u009bb  ' });

    expect((out.items[0] as { text: string }).text).toBe('hello\nworld[31m ab');
  });

  it('refuses text that is blank once it is clean, without saying what it was', () => {
    for (const text of ['', '   \n\t ', '\u0007\u001b']) {
      const err = refusalOf(() => add(stateOf([]), { text }));
      expect(err.code).toBe('INVALID');
    }
  });

  it('refuses a shell line: text that starts with ! after whitespace, and after the literal \\n the scheduler types as a line break', () => {
    for (const text of ['!ls', '  !ls', '\n!ls', '\\n!rm -rf ~', '\u0007!x']) {
      const err = refusalOf(() => add(stateOf([]), { text }));
      expect(err.code, text).toBe('INVALID');
      expect(words(err)).not.toContain('rm -rf');
    }
    expect(() => add(stateOf([]), { text: 'wow! really' })).not.toThrow();
    expect(() => add(stateOf([]), { text: 'first line\n!second line' })).not.toThrow();
  });

  it('keeps what it does not know about: entries that are not items and fields it has never heard of', () => {
    const odd = [null, 'junk', { text: 'no id' }, item(3, { futureField: { a: 1 } })];

    const out = add(stateOf(odd));

    expect(out.items.slice(0, 4)).toEqual(odd);
  });

  it('changes nothing it was given', () => {
    const base = deepFreeze({ items: [item(1), item(2, { beforeChain: [{ id: 1, text: 'a' }] })], automation: automationOf() });

    expect(() => add(base, { position: 1 })).not.toThrow();
  });
});

describe('editItem', () => {
  const base = [
    item(1, { position: 0 }),
    item(2, {
      position: 1,
      type: 'loop',
      intervalMs: 60_000,
      disabled: true,
      images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }],
      beforeChain: [{ id: 9, text: 'before' }],
      futureField: 7,
    }),
  ];

  it('replaces the text of one item and keeps every other field of it', () => {
    const out = editItem(stateOf(base), { itemId: 2, text: ' new words ' });

    expect(itemWith(out.items, 2)).toEqual({ ...base[1], text: 'new words' });
    expect(itemWith(out.items, 1)).toEqual(base[0]);
    expect(out.result).toEqual({ itemId: 2 });
  });

  it('is NOT_FOUND for an id that is not in the queue, and never repeats it', () => {
    const err = refusalOf(() => editItem(stateOf(base), { itemId: NEEDLE, text: 'x' }));

    expect(err.code).toBe('NOT_FOUND');
    expect(words(err)).not.toContain(String(NEEDLE));
  });

  it('refuses blank text and a shell line like an add does', () => {
    expect(refusalOf(() => editItem(stateOf(base), { itemId: 1, text: ' ' })).code).toBe('INVALID');
    expect(refusalOf(() => editItem(stateOf(base), { itemId: 1, text: '!ls' })).code).toBe('INVALID');
  });
});

describe('removeItem', () => {
  it('removes one item and leaves the others where they are', () => {
    const base = [item(1, { position: 0 }), item(2, { position: 1 }), item(3, { position: 2 })];

    const out = removeItem(stateOf(base), { itemId: 2 });

    expect(out.items).toEqual([base[0], base[2]]);
    expect(out.result).toEqual({ itemId: 2 });
  });

  it('keeps entries it cannot read', () => {
    const out = removeItem(stateOf([null, item(1), 'junk']), { itemId: 1 });

    expect(out.items).toEqual([null, 'junk']);
  });

  it('is NOT_FOUND for an id that is not there', () => {
    expect(refusalOf(() => removeItem(stateOf(queueOf(1)), { itemId: NEEDLE })).code).toBe('NOT_FOUND');
  });
});

describe('clearItems (P5-10)', () => {
  it('takes every prompt out when the ids are the ones the person was shown, in any order', () => {
    const base = [item(3, { position: 0 }), item(1, { position: 1 }), item(2, { position: 2, disabled: true })];

    const out = clearItems(stateOf(base, automationOf({ paused: true })), { expectIds: [2, 3, 1] });

    expect(out.items).toEqual([]);
    expect(out.result).toEqual({ cleared: 3 });
  });

  it('clearItems refuses when the ids differ and keeps automation', () => {
    const automation = automationOf({ autoSend: false, resumePrompt: 'go on' });
    const state = stateOf(queueOf(1, 2, NEEDLE), automation);

    const grown = refusalOf(() => clearItems(state, { expectIds: [1, 2] }));
    const shrunk = refusalOf(() => clearItems(stateOf(queueOf(1), automation), { expectIds: [1, 2] }));
    const swapped = refusalOf(() => clearItems(state, { expectIds: [1, 2, 9] }));

    for (const err of [grown, shrunk, swapped]) {
      expect(err).toMatchObject({ code: 'INVALID', message: 'The queue changed since the person was asked.' });
      expect(words(err)).not.toContain(String(NEEDLE));
    }
    // Allowed, the record of switches is the one stored, untouched.
    expect(clearItems(state, { expectIds: [NEEDLE, 2, 1] }).automation).toBe(automation);
  });

  it('keeps entries it cannot read, and counts only prompts', () => {
    const out = clearItems(stateOf([null, item(1), 'junk']), { expectIds: [1] });

    expect(out.items).toEqual([null, 'junk']);
    expect(out.result).toEqual({ cleared: 1 });
  });

  it('queueItemIds lists the stored prompt ids, sorted, and nothing that is not one', () => {
    expect(queueItemIds(stateOf([item(5), null, item(2), { text: 'no id' }, item(9)]).items)).toEqual([2, 5, 9]);
    expect(queueItemIds([])).toEqual([]);
  });
});

describe('moveItem', () => {
  it('moves an item to a position and numbers the queue 0..n-1', () => {
    const out = moveItem(stateOf(queueOf(1, 2, 3)), { itemId: 3, position: 0 });

    expect(idsOf(out.items)).toEqual([3, 1, 2]);
    expect(out.items.map((i) => (i as { position: number }).position)).toEqual([0, 1, 2]);
    expect(out.result).toEqual({ itemId: 3, from: 2, to: 0 });
  });

  it('puts it behind the ones before it when it moves later', () => {
    expect(idsOf(moveItem(stateOf(queueOf(1, 2, 3)), { itemId: 1, position: 1 }).items)).toEqual([2, 1, 3]);
  });

  it('clamps the position: below 0 is the front, past the end is the end', () => {
    expect(idsOf(moveItem(stateOf(queueOf(1, 2, 3)), { itemId: 2, position: -3 }).items)).toEqual([2, 1, 3]);
    expect(idsOf(moveItem(stateOf(queueOf(1, 2, 3, 4)), { itemId: 4, position: -1 }).items)).toEqual([4, 1, 2, 3]);
    const out = moveItem(stateOf(queueOf(1, 2, 3)), { itemId: 1, position: 50 });
    expect(idsOf(out.items)).toEqual([2, 3, 1]);
    expect(out.result).toMatchObject({ from: 0, to: 2 });
  });

  it('goes by the stored positions, not by where the list happens to hold an item', () => {
    const shuffled = [item(2, { position: 1 }), item(1, { position: 0 }), item(3, { position: 2 })];

    const out = moveItem(stateOf(shuffled), { itemId: 3, position: 0 });

    expect(idsOf(out.items)).toEqual([3, 1, 2]);
  });

  it('is NOT_FOUND for an id that is not there', () => {
    expect(refusalOf(() => moveItem(stateOf(queueOf(1)), { itemId: NEEDLE, position: 0 })).code).toBe('NOT_FOUND');
  });
});

describe('setItemEnabled', () => {
  it('turns an item off by marking it disabled, and on by leaving the mark out', () => {
    const off = setItemEnabled(stateOf([item(1)]), { itemId: 1, enabled: false });
    expect(itemWith(off.items, 1).disabled).toBe(true);

    const on = setItemEnabled(off, { itemId: 1, enabled: true });
    expect(itemWith(on.items, 1)).not.toHaveProperty('disabled');
  });

  it('is NOT_FOUND for an id that is not there', () => {
    expect(refusalOf(() => setItemEnabled(stateOf([]), { itemId: NEEDLE, enabled: true })).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Timing
// ---------------------------------------------------------------------------

describe('setItemSchedule', () => {
  const schedule = (base: Record<string, unknown>, input: Record<string, unknown>) =>
    setItemSchedule(stateOf([item(1, base)]), { itemId: 1, ...input } as Parameters<typeof setItemSchedule>[1], NOW);
  const stored = (out: { items: readonly unknown[] }): Record<string, unknown> => itemWith(out.items as never, 1);

  it('makes a loop: the interval, the first fire one interval from now, no run time', () => {
    const out = schedule({ nextFireAt: 0, runAt: 5 }, { type: 'loop', intervalMs: 300_000 });

    expect(stored(out)).toMatchObject({ type: 'loop', intervalMs: 300_000, nextFireAt: NOW + 300_000 });
    expect(stored(out)).not.toHaveProperty('runAt');
  });

  it('keeps a loop’s next fire time while it is still ahead, and renews one that has passed', () => {
    expect(stored(schedule({ nextFireAt: NOW + 1_000 }, { type: 'loop', intervalMs: 300_000 })).nextFireAt).toBe(NOW + 1_000);
    expect(stored(schedule({ nextFireAt: NOW - 1 }, { type: 'loop', intervalMs: 300_000 })).nextFireAt).toBe(NOW + 300_000);
  });

  it('sets a loop’s first fire of the day and quiet-hours windows, with ids, and clears them when told', () => {
    const set = schedule({}, {
      type: 'loop',
      intervalMs: 60_000,
      firstFireOfDay: '07:30',
      excludeWindows: [{ start: '22:00', end: '06:00' }, { start: '12:00', end: '13:00' }],
    });
    expect(stored(set)).toMatchObject({
      firstFireOfDay: '07:30',
      excludeWindows: [
        { id: NOW, startHHMM: '22:00', endHHMM: '06:00' },
        { id: NOW + 1, startHHMM: '12:00', endHHMM: '13:00' },
      ],
    });

    const cleared = setItemSchedule(set, { itemId: 1, type: 'loop', intervalMs: 60_000, firstFireOfDay: null, excludeWindows: [] }, NOW);
    expect(stored(cleared)).not.toHaveProperty('firstFireOfDay');
    expect(stored(cleared)).not.toHaveProperty('excludeWindows');
  });

  it('leaves a loop’s first fire of the day and windows alone when it is not told about them', () => {
    const base = { firstFireOfDay: '08:00', excludeWindows: [{ id: 3, startHHMM: '01:00', endHHMM: '02:00' }] };

    const out = schedule(base, { type: 'loop', intervalMs: 60_000 });

    expect(stored(out)).toMatchObject(base);
  });

  it('makes a schedule: the run time is the first fire; no interval, no first fire of the day; windows stay', () => {
    const base = { type: 'loop', intervalMs: 60_000, firstFireOfDay: '08:00', excludeWindows: [{ id: 3, startHHMM: '01:00', endHHMM: '02:00' }] };

    const out = schedule(base, { type: 'schedule', runAt: NOW + 3_600_000 });

    expect(stored(out)).toMatchObject({ type: 'schedule', runAt: NOW + 3_600_000, nextFireAt: NOW + 3_600_000 });
    expect(stored(out)).not.toHaveProperty('intervalMs');
    expect(stored(out)).not.toHaveProperty('firstFireOfDay');
    expect(stored(out).excludeWindows).toEqual(base.excludeWindows);
  });

  it('makes a once item: next fire time 0 so it sorts first; no interval, run time or first fire of the day', () => {
    const base = { type: 'loop', intervalMs: 60_000, runAt: 9, nextFireAt: NOW + 5, firstFireOfDay: '08:00', excludeWindows: [{ id: 3, startHHMM: '01:00', endHHMM: '02:00' }] };

    const out = schedule(base, { type: 'once' });

    expect(stored(out)).toMatchObject({ type: 'once', nextFireAt: 0 });
    for (const key of ['intervalMs', 'runAt', 'firstFireOfDay']) expect(stored(out), key).not.toHaveProperty(key);
    expect(stored(out).excludeWindows).toEqual(base.excludeWindows);
  });

  it('keeps the rest of the item: its text, steps, fire history and paused mark', () => {
    const base = { text: 'keep me', disabled: true, lastFiredAt: 4, totalFires: 3, beforeChain: [{ id: 1, text: 'b' }] };

    expect(stored(schedule(base, { type: 'loop', intervalMs: 60_000 }))).toMatchObject(base);
  });

  it('refuses what does not fit the type, naming the field and never a value', () => {
    const refused: Array<Record<string, unknown>> = [
      { type: 'loop' },
      { type: 'loop', intervalMs: 60_000, runAt: NOW + 5_000 },
      { type: 'schedule' },
      { type: 'schedule', runAt: NOW + 5_000, intervalMs: 60_000 },
      { type: 'schedule', runAt: NOW + 5_000, firstFireOfDay: '07:00' },
      { type: 'schedule', runAt: NOW + 5_000, excludeWindows: [] },
      { type: 'once', intervalMs: 60_000 },
      { type: 'once', runAt: NOW + 5_000 },
      { type: 'once', firstFireOfDay: null },
    ];
    for (const input of refused) {
      const err = refusalOf(() => schedule({}, input));
      expect(err.code, JSON.stringify(input)).toBe('INVALID');
    }
  });

  it('refuses an interval under a second, a run time that has passed, a bad clock time, and a window that starts where it ends', () => {
    const refused: Array<Record<string, unknown>> = [
      { type: 'loop', intervalMs: 999 },
      { type: 'loop', intervalMs: 1.5 },
      { type: 'schedule', runAt: NOW },
      { type: 'schedule', runAt: NOW - 60_000 },
      { type: 'loop', intervalMs: 60_000, firstFireOfDay: '7:30' },
      { type: 'loop', intervalMs: 60_000, firstFireOfDay: '24:00' },
      { type: 'loop', intervalMs: 60_000, excludeWindows: [{ start: '25:00', end: '06:00' }] },
      { type: 'loop', intervalMs: 60_000, excludeWindows: [{ start: '09:00', end: '09:00' }] },
    ];
    for (const input of refused) {
      expect(refusalOf(() => schedule({}, input)).code, JSON.stringify(input)).toBe('INVALID');
    }
  });

  it('is NOT_FOUND for an id that is not there', () => {
    const err = refusalOf(() => setItemSchedule(stateOf([]), { itemId: NEEDLE, type: 'once' }, NOW));

    expect(err.code).toBe('NOT_FOUND');
  });
});

describe('fireNow', () => {
  it('flags a fresh item to start now, and clears a cursor a past run left behind', () => {
    const base = item(1, { execState: 'idle', execStepIdx: 2, beforeChain: [{ id: 5, text: 'b' }] });

    const out = fireNow(stateOf([base]), { itemId: 1 });

    expect(itemWith(out.items, 1)).toMatchObject({ forceStart: true, beforeChain: [{ id: 5, text: 'b' }] });
    expect(itemWith(out.items, 1)).not.toHaveProperty('execState');
    expect(itemWith(out.items, 1)).not.toHaveProperty('execStepIdx');
    expect(out.result).toEqual({ itemId: 1, resumed: false });
  });

  it('on an item partway through its chain releases the step it waits on, and leaves the cursor where it is', () => {
    const base = item(1, { execState: 'before', execStepIdx: 1, beforeChain: [{ id: 5, text: 'b' }, { id: 6, text: 'c' }] });

    const out = fireNow(stateOf([base]), { itemId: 1 });

    expect(itemWith(out.items, 1)).toMatchObject({ forceStart: true, execState: 'before', execStepIdx: 1 });
    expect(out.result).toEqual({ itemId: 1, resumed: true });
  });

  it('refuses a paused item: a flag on it would sit there and fire the moment a person turned it on', () => {
    const err = refusalOf(() => fireNow(stateOf([item(1, { disabled: true })]), { itemId: 1 }));

    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/paused/i);
  });

  it('refuses while the queue is paused: that is a hard stop, and a flag would fire on resume', () => {
    const err = refusalOf(() => fireNow(stateOf([item(1)], automationOf({ paused: true })), { itemId: 1 }));

    expect(err.code).toBe('INVALID');
    expect(err.message).toMatch(/paused/i);
  });

  it('is NOT_FOUND for an id that is not there', () => {
    expect(refusalOf(() => fireNow(stateOf([]), { itemId: NEEDLE })).code).toBe('NOT_FOUND');
  });
});

// ---------------------------------------------------------------------------
// Chain steps
// ---------------------------------------------------------------------------

describe('chain steps', () => {
  const chained = (over: Record<string, unknown> = {}) =>
    stateOf([
      item(1, {
        beforeChain: [{ id: 10, text: 'b1' }, { id: 11, text: 'b2', images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }] }],
        afterChain: [{ id: 20, text: 'a1' }],
        ...over,
      }),
    ]);
  const chain = (out: { items: readonly unknown[] }, key: 'beforeChain' | 'afterChain'): Array<Record<string, unknown>> =>
    (itemWith(out.items as never, 1)[key] ?? []) as Array<Record<string, unknown>>;

  describe('addStep', () => {
    it('appends a step to the chain it names, with the id max(now, the highest step id + 1)', () => {
      const out = addStep(chained(), { itemId: 1, chain: 'before', text: 'b3' }, NOW);

      expect(chain(out, 'beforeChain').map((s) => [s.id, s.text])).toEqual([[10, 'b1'], [11, 'b2'], [NOW, 'b3']]);
      expect(chain(out, 'afterChain')).toHaveLength(1);
      expect(out.result).toEqual({ itemId: 1, stepId: NOW });
    });

    it('goes past every step id there is, even in the other chain', () => {
      const out = addStep(chained({ afterChain: [{ id: NOW + 9, text: 'late' }] }), { itemId: 1, chain: 'before', text: 'x' }, NOW);

      expect(out.result.stepId).toBe(NOW + 10);
    });

    it('starts a chain the item does not have yet', () => {
      const out = addStep(stateOf([item(1)]), { itemId: 1, chain: 'after', text: 'first' }, NOW);

      expect(chain(out, 'afterChain')).toEqual([{ id: NOW, text: 'first' }]);
    });

    it('inserts at a position, clamped to the chain', () => {
      const front = addStep(chained(), { itemId: 1, chain: 'before', text: 'x', position: 0 }, NOW);
      expect(chain(front, 'beforeChain').map((s) => s.text)).toEqual(['x', 'b1', 'b2']);
      const wayPast = addStep(chained(), { itemId: 1, chain: 'before', text: 'x', position: 40 }, NOW);
      expect(chain(wayPast, 'beforeChain').map((s) => s.text)).toEqual(['b1', 'b2', 'x']);
      const below = addStep(chained(), { itemId: 1, chain: 'before', text: 'x', position: -2 }, NOW);
      expect(chain(below, 'beforeChain').map((s) => s.text)).toEqual(['x', 'b1', 'b2']);
      const longer = chained({ beforeChain: [{ id: 10, text: 'b1' }, { id: 11, text: 'b2' }, { id: 12, text: 'b3' }] });
      expect(chain(addStep(longer, { itemId: 1, chain: 'before', text: 'x', position: -1 }, NOW), 'beforeChain').map((s) => s.text)).toEqual(['x', 'b1', 'b2', 'b3']);
    });

    it('cleans the text and refuses blank text and a shell line', () => {
      expect(chain(addStep(chained(), { itemId: 1, chain: 'after', text: ' go\u0007 ' }, NOW), 'afterChain').at(-1)?.text).toBe('go');
      expect(refusalOf(() => addStep(chained(), { itemId: 1, chain: 'after', text: '  ' }, NOW)).code).toBe('INVALID');
      expect(refusalOf(() => addStep(chained(), { itemId: 1, chain: 'after', text: '!ls' }, NOW)).code).toBe('INVALID');
    });

    it('is NOT_FOUND for an item that is not there', () => {
      expect(refusalOf(() => addStep(chained(), { itemId: NEEDLE, chain: 'before', text: 'x' }, NOW)).code).toBe('NOT_FOUND');
    });

    it('is BUSY while the item is partway through its chain: a step added or taken out would move the cursor', () => {
      for (const execState of ['before', 'main', 'after']) {
        const err = refusalOf(() => addStep(chained({ execState, execStepIdx: 0 }), { itemId: 1, chain: 'before', text: 'x' }, NOW));
        expect(err.code, execState).toBe('BUSY');
      }
      expect(() => addStep(chained({ execState: 'idle' }), { itemId: 1, chain: 'before', text: 'x' }, NOW)).not.toThrow();
    });
  });

  describe('editStep', () => {
    it('replaces the text of one step and keeps its id and images', () => {
      const out = editStep(chained(), { itemId: 1, chain: 'before', stepId: 11, text: ' changed ' });

      expect(chain(out, 'beforeChain')[1]).toEqual({ id: 11, text: 'changed', images: [{ name: 'a.png', dataUrl: 'data:image/png;base64,AAAA' }] });
      expect(chain(out, 'beforeChain')[0]).toEqual({ id: 10, text: 'b1' });
      expect(out.result).toEqual({ itemId: 1, stepId: 11 });
    });

    it('works on a chain that is running: the cursor does not move when a text changes', () => {
      expect(() => editStep(chained({ execState: 'before', execStepIdx: 1 }), { itemId: 1, chain: 'before', stepId: 11, text: 'x' })).not.toThrow();
    });

    it('looks only in the chain it was told: a step id in the other chain is not found', () => {
      expect(refusalOf(() => editStep(chained(), { itemId: 1, chain: 'after', stepId: 10, text: 'x' })).code).toBe('NOT_FOUND');
    });

    it('is NOT_FOUND for an item or a step that is not there, never repeating the ids', () => {
      const noItem = refusalOf(() => editStep(chained(), { itemId: NEEDLE, chain: 'before', stepId: 10, text: 'x' }));
      const noStep = refusalOf(() => editStep(chained(), { itemId: 1, chain: 'before', stepId: NEEDLE, text: 'x' }));

      expect([noItem.code, noStep.code]).toEqual(['NOT_FOUND', 'NOT_FOUND']);
      expect(`${words(noItem)} ${words(noStep)}`).not.toContain(String(NEEDLE));
    });

    it('refuses blank text and a shell line', () => {
      expect(refusalOf(() => editStep(chained(), { itemId: 1, chain: 'before', stepId: 10, text: '' })).code).toBe('INVALID');
      expect(refusalOf(() => editStep(chained(), { itemId: 1, chain: 'before', stepId: 10, text: ' !x' })).code).toBe('INVALID');
    });
  });

  describe('removeStep', () => {
    it('removes one step, and drops the chain’s key when it was the last', () => {
      const out = removeStep(chained(), { itemId: 1, chain: 'before', stepId: 10 });
      expect(chain(out, 'beforeChain').map((s) => s.id)).toEqual([11]);

      const last = removeStep(chained(), { itemId: 1, chain: 'after', stepId: 20 });
      expect(itemWith(last.items, 1)).not.toHaveProperty('afterChain');
      expect(chain(last, 'beforeChain')).toHaveLength(2);
    });

    it('is NOT_FOUND for a step that is not there, and BUSY on a chain that is running', () => {
      expect(refusalOf(() => removeStep(chained(), { itemId: 1, chain: 'before', stepId: NEEDLE })).code).toBe('NOT_FOUND');
      expect(refusalOf(() => removeStep(chained({ execState: 'main' }), { itemId: 1, chain: 'before', stepId: 10 })).code).toBe('BUSY');
    });
  });

  describe('moveStep', () => {
    it('moves a step within its chain, clamped', () => {
      const out = moveStep(chained(), { itemId: 1, chain: 'before', stepId: 11, position: 0 });
      expect(chain(out, 'beforeChain').map((s) => s.id)).toEqual([11, 10]);
      expect(out.result).toEqual({ itemId: 1, stepId: 11, from: 1, to: 0 });

      const far = moveStep(chained(), { itemId: 1, chain: 'before', stepId: 10, position: 99 });
      expect(chain(far, 'beforeChain').map((s) => s.id)).toEqual([11, 10]);
      const longer = chained({ beforeChain: [{ id: 10, text: 'b1' }, { id: 11, text: 'b2' }, { id: 12, text: 'b3' }] });
      expect(chain(moveStep(longer, { itemId: 1, chain: 'before', stepId: 12, position: -1 }), 'beforeChain').map((s) => s.id)).toEqual([12, 10, 11]);
    });

    it('is NOT_FOUND for a step that is not there, and BUSY on a chain that is running', () => {
      expect(refusalOf(() => moveStep(chained(), { itemId: 1, chain: 'before', stepId: NEEDLE, position: 0 })).code).toBe('NOT_FOUND');
      expect(refusalOf(() => moveStep(chained({ execState: 'after' }), { itemId: 1, chain: 'before', stepId: 10, position: 1 })).code).toBe('BUSY');
    });
  });

  it('keeps the other fields of the item and the entries of a chain it cannot read', () => {
    const odd = stateOf([item(1, { text: 'main', disabled: true, beforeChain: ['bad', { id: 10, text: 'ok' }] })]);

    const out = editStep(odd, { itemId: 1, chain: 'before', stepId: 10, text: 'new' });

    expect(itemWith(out.items, 1)).toMatchObject({ text: 'main', disabled: true, beforeChain: ['bad', { id: 10, text: 'new' }] });
  });
});

// ---------------------------------------------------------------------------
// Automation
// ---------------------------------------------------------------------------

describe('automation', () => {
  describe('setPaused', () => {
    it('sets the flag and keeps the rest of the record', () => {
      const out = setPaused(stateOf([], automationOf({ autoSend: false, futureField: 1 })), true);

      expect(out.automation).toEqual(automationOf({ paused: true, autoSend: false, futureField: 1 }));
    });

    // Ruling 52: these two pinned the old fill (a record with no row, or one that lacked a switch, was written back with
    // the dashboard's defaults, every switch ON). The window reads a switch that is absent as off, so that turned sends on.
    it('is refused, to resume, when the server holds no record: the window keeps settings the server cannot see', () => {
      const err = refusalOf(() => setPaused(stateOf([]), false));

      expect(err.code).toBe('INVALID');
      expect(err.hint).toBe('Change one queue switch in AASC first.');
    });

    // P4-32 M6: pausing only stops things, so a central may pause a runaway queue whose window never stored a record.
    it('pauses with no record stored, writing the safe defaults: every send switch off, the guards on', () => {
      const out = setPaused(stateOf([]), true);

      expect(out.automation).toEqual({
        paused: true,
        autoSend: false,
        autoEnter: false,
        idleGuard: true,
        skipWhenPrompting: true,
        autoResume: false,
        resumeMaxRetries: 3,
        resumePrompt: '',
      });
    });

    it('writes a switch the record lacks as off, the way the window reads it, never on', () => {
      const out = setPaused(stateOf([], { paused: false } as never), true);

      expect(out.automation).toEqual({
        paused: true,
        autoSend: false,
        autoEnter: false,
        idleGuard: false,
        skipWhenPrompting: false,
        autoResume: false,
        resumeMaxRetries: 3,
        resumePrompt: '',
      });
    });

    it('leaves the items alone', () => {
      const items = queueOf(1, 2);

      expect(setPaused(stateOf(items, automationOf()), false).items).toEqual(items);
    });
  });

  describe('setAutoSend', () => {
    it('turns auto-send off with no record stored (it only stops sends), but not on', () => {
      expect(setAutoSend(stateOf([]), false).automation).toEqual({
        paused: false,
        autoSend: false,
        autoEnter: false,
        idleGuard: true,
        skipWhenPrompting: true,
        autoResume: false,
        resumeMaxRetries: 3,
        resumePrompt: '',
      });
      expect(refusalOf(() => setAutoSend(stateOf([]), true)).hint).toBe('Change one queue switch in AASC first.');
    });

    it('sets the flag and keeps the rest', () => {
      const out = setAutoSend(stateOf([], automationOf({ paused: true })), false);

      expect(out.automation).toEqual(automationOf({ paused: true, autoSend: false }));
    });
  });

  describe('setAutomation', () => {
    const set = (patch: Record<string, unknown>, base = automationOf()) =>
      setAutomation(stateOf([], base), patch as Parameters<typeof setAutomation>[1], NOW);

    it('sets only the fields it is given', () => {
      const out = set({ autoEnter: false, idleGuard: false, skipWhenPrompting: false, autoResume: false });

      expect(out.automation).toEqual(automationOf({ autoEnter: false, idleGuard: false, skipWhenPrompting: false, autoResume: false }));
    });

    it('sets the retry count and the resume prompt, which is text a person’s CLI will be typed', () => {
      const out = set({ resumeMaxRetries: 7, resumePrompt: ' keep going ' });

      expect(out.automation).toMatchObject({ resumeMaxRetries: 7, resumePrompt: 'keep going' });
    });

    it('allows an empty resume prompt, which brings back the default wording', () => {
      expect(set({ resumePrompt: '' }, automationOf({ resumePrompt: 'old' })).automation).toMatchObject({ resumePrompt: '' });
    });

    it('refuses a retry count outside 1 to 10 and a resume prompt that is a shell line or too long', () => {
      for (const patch of [{ resumeMaxRetries: 0 }, { resumeMaxRetries: 11 }, { resumeMaxRetries: 2.5 }, { resumePrompt: '!rm -rf ~' }, { resumePrompt: 'x'.repeat(4_001) }]) {
        expect(refusalOf(() => set(patch)).code, JSON.stringify(patch).slice(0, 40)).toBe('INVALID');
      }
    });

    it('sets the quiet hours of every loop, with ids, and clears them with an empty list', () => {
      const out = set({ loopExcludeWindows: [{ start: '23:00', end: '06:30' }] });
      expect(out.automation).toMatchObject({ loopExcludeWindows: [{ id: NOW, startHHMM: '23:00', endHHMM: '06:30' }] });

      const cleared = setAutomation(out, { loopExcludeWindows: [] }, NOW);
      expect(cleared.automation).not.toHaveProperty('loopExcludeWindows');
    });

    it('refuses a quiet-hours window that starts where it ends or is not a clock time', () => {
      expect(refusalOf(() => set({ loopExcludeWindows: [{ start: '09:00', end: '09:00' }] })).code).toBe('INVALID');
      expect(refusalOf(() => set({ loopExcludeWindows: [{ start: '9:00', end: '10:00' }] })).code).toBe('INVALID');
    });

    it('refuses a call that changes nothing', () => {
      expect(refusalOf(() => set({})).code).toBe('INVALID');
    });

    it('does not touch the paused or auto-send flags', () => {
      const out = set({ autoEnter: false }, automationOf({ paused: true, autoSend: false }));

      expect(out.automation).toMatchObject({ paused: true, autoSend: false });
    });
  });

  it('changes nothing it was given', () => {
    const frozen = deepFreeze({ items: queueOf(1), automation: automationOf({ loopExcludeWindows: [{ id: 1, startHHMM: '01:00', endHHMM: '02:00' }] }) });

    expect(() => setPaused(frozen, true)).not.toThrow();
    expect(() => setAutomation(frozen, { autoEnter: false, loopExcludeWindows: [] }, NOW)).not.toThrow();
  });
});

describe('what is not a kind of timing or a chain', () => {
  it('is refused as INVALID, including names every object has', () => {
    for (const type of ['weekly', 'constructor', '__proto__', 'toString']) {
      const err = refusalOf(() => setItemSchedule(stateOf([item(1)]), { itemId: 1, type } as never, NOW));
      expect(err.code, type).toBe('INVALID');
    }
    for (const chain of ['middle', 'constructor', '__proto__']) {
      const state = stateOf([item(1, { beforeChain: [{ id: 10, text: 'a' }] })]);
      expect(refusalOf(() => addStep(state, { itemId: 1, chain, text: 'x' } as never, NOW)).code, chain).toBe('INVALID');
      expect(refusalOf(() => editStep(state, { itemId: 1, chain, stepId: 10, text: 'x' } as never)).code, chain).toBe('INVALID');
    }
  });
});

describe('no op changes what it is given', () => {
  it('on a queue frozen all the way down, every op answers without touching it', () => {
    const state = deepFreeze({
      items: [
        item(1, { position: 0, beforeChain: [{ id: 10, text: 'a' }, { id: 11, text: 'b' }], afterChain: [{ id: 20, text: 'c' }], excludeWindows: [{ id: 5, startHHMM: '01:00', endHHMM: '02:00' }] }),
        item(2, { position: 1, type: 'loop', intervalMs: 60_000, nextFireAt: NOW + 9_000 }),
        item(3, { position: 2, disabled: true }),
      ],
      automation: automationOf({ loopExcludeWindows: [{ id: 7, startHHMM: '03:00', endHHMM: '04:00' }] }),
    });

    const ops = [
      () => addItem(state, { sessionId: 's1', text: 'x', disabled: true, position: 1 }, NOW),
      () => addItem(state, { sessionId: 's1', text: 'x', disabled: false }, NOW),
      () => editItem(state, { itemId: 1, text: 'x' }),
      () => removeItem(state, { itemId: 1 }),
      () => moveItem(state, { itemId: 3, position: 0 }),
      () => setItemEnabled(state, { itemId: 3, enabled: true }),
      () => setItemEnabled(state, { itemId: 1, enabled: false }),
      () => setItemSchedule(state, { itemId: 2, type: 'loop', intervalMs: 5_000, firstFireOfDay: '07:00', excludeWindows: [{ start: '01:00', end: '02:00' }] }, NOW),
      () => setItemSchedule(state, { itemId: 2, type: 'schedule', runAt: NOW + 5_000 }, NOW),
      () => setItemSchedule(state, { itemId: 2, type: 'once' }, NOW),
      () => fireNow(state, { itemId: 1 }),
      () => addStep(state, { itemId: 1, chain: 'before', text: 'x', position: 1 }, NOW),
      () => editStep(state, { itemId: 1, chain: 'after', stepId: 20, text: 'x' }),
      () => removeStep(state, { itemId: 1, chain: 'before', stepId: 10 }),
      () => moveStep(state, { itemId: 1, chain: 'before', stepId: 11, position: 0 }),
      () => setPaused(state, true),
      () => setAutoSend(state, false),
      () => setAutomation(state, { autoEnter: false, resumePrompt: 'go', resumeMaxRetries: 4, loopExcludeWindows: [] }, NOW),
      () => clearItems(state, { expectIds: [3, 2, 1] }),
    ];
    for (const [i, op] of ops.entries()) expect(op, `op ${i}`).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The read-modify-write
// ---------------------------------------------------------------------------

describe('applyQueueOp', () => {
  const add = (text: string) => (state: Parameters<typeof addItem>[0]) =>
    addItem(state, { sessionId: 's1', text, disabled: true }, NOW);

  it('reads the row, applies the op and writes the result under the origin it was given', () => {
    const store = fakeQueueStore({ s1: { items: queueOf(1), automation: automationOf({ paused: true }) } });

    const out = applyQueueOp(store, 's1', add('two'), 'mcp:central-1');

    expect(store.calls).toEqual(['read s1', 'write s1']);
    expect(store.writes).toHaveLength(1);
    expect(store.writes[0]).toMatchObject({ sessionId: 's1', originClientId: 'mcp:central-1' });
    expect(store.writes[0].items).toEqual(out.items);
    expect(idsOf(store.writes[0].items)).toEqual([1, NOW]);
    expect(store.writes[0].automation).toEqual(automationOf({ paused: true }));
    expect(out.result).toEqual({ itemId: NOW });
  });

  it('rmw reads the latest row: a write that landed between two ops is kept, and the second op builds on it', () => {
    const store = fakeQueueStore({ s1: { items: queueOf(1) } });

    applyQueueOp(store, 's1', add('one'), 'mcp:central-1');
    // The desktop window pushes its own list after the first op: its edit, and the first op's item kept.
    store.rows.set('s1', { items: [...store.read('s1').items, item(777, { text: 'the window’s edit', position: 2 })], automation: null });
    applyQueueOp(store, 's1', add('two'), 'mcp:central-1');

    const texts = store.read('s1').items.map((i) => (i as { text: string }).text);
    expect(texts).toEqual(['item 1', 'one', 'the window’s edit', 'two']);
  });

  it('is one synchronous call: nothing can run between the read and the write', () => {
    const store = fakeQueueStore({ s1: { items: queueOf(1) } });
    let interleaved = false;
    queueMicrotask(() => {
      interleaved = true;
    });
    const write = store.write.bind(store);
    let seenAtWrite: boolean | null = null;
    store.write = (...args) => {
      seenAtWrite = interleaved;
      write(...args);
    };

    const out = applyQueueOp(store, 's1', add('x'), 'mcp:central-1');

    expect(typeof (out as unknown as { then?: unknown }).then).toBe('undefined');
    expect(seenAtWrite).toBe(false);
    expect(store.calls).toEqual(['read s1', 'write s1']);
  });

  it('writes nothing when the op refuses', () => {
    const store = fakeQueueStore({ s1: { items: queueOf(1) } });

    const err = refusalOf(() => applyQueueOp(store, 's1', (state) => removeItem(state, { itemId: NEEDLE }), 'mcp:central-1'));

    expect(err.code).toBe('NOT_FOUND');
    expect(store.calls).toEqual(['read s1']);
    expect(store.writes).toEqual([]);
  });

  it('reads a session that has no row as an empty queue, and writes the first row', () => {
    const store = fakeQueueStore();

    applyQueueOp(store, 's9', add('first'), 'mcp:central-1');

    expect(idsOf(store.rows.get('s9')?.items ?? [])).toEqual([NOW]);
    expect(store.rows.get('s9')?.automation).toBeNull();
  });

  it('passes the stored automation through an item op untouched', () => {
    const automation = automationOf({ futureField: 'x' });
    const store = fakeQueueStore({ s1: { items: queueOf(1), automation } });

    applyQueueOp(store, 's1', add('x'), 'mcp:central-1');

    expect(store.writes[0].automation).toBe(automation);
  });

  it('refuses a queue that would grow past what one sync carries, writing nothing', () => {
    const big = item(1, { text: 'x'.repeat(1_000), images: [{ name: 'p.png', dataUrl: `data:image/png;base64,${'A'.repeat(QUEUE_PAYLOAD_MAX - 2_000)}` }] });
    const store = fakeQueueStore({ s1: { items: [big] } });

    const err = refusalOf(() => applyQueueOp(store, 's1', add('y'.repeat(5_000)), 'mcp:central-1'));

    expect(err.code).toBe('INVALID');
    expect(store.writes).toEqual([]);
  });

  it('still lets a queue that is already over the limit shrink', () => {
    const big = item(1, { images: [{ name: 'p.png', dataUrl: `data:image/png;base64,${'A'.repeat(QUEUE_PAYLOAD_MAX)}` }] });
    const store = fakeQueueStore({ s1: { items: [big, item(2)] } });

    applyQueueOp(store, 's1', (state) => removeItem(state, { itemId: 2 }), 'mcp:central-1');

    expect(store.writes).toHaveLength(1);
  });
});
