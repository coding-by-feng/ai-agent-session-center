// test/mcp/tools.queueWriteLimits.test.ts — B-M4 and B-M5. A queue holds at most 200 prompts and a prompt at most 20
// chain steps, before and after together: past that a central's add is INVALID, in AASC's words, and nothing is
// written. A `runAt` that is a date alone ("2026-10-25") means midnight on the Mac, as a date and time with no zone
// does, not midnight UTC (which is how JavaScript reads a date alone), and the schema says so. The zone is set to one
// that is not UTC for those tests, so the two readings differ.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { item, itemWith } from './queueFixtures.js';
import { queueWorld, toolNamed } from './queueToolFixtures.js';

vi.mock('../../server/logger.js', () => ({
  default: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), debugJson: vi.fn(), isDebug: false },
}));

/** `count` paused prompts, numbered from 1. */
const prompts = (count: number) => Array.from({ length: count }, (_, i) => item(i + 1, { position: i, disabled: true }));
/** `count` steps with ids from `from`. */
const steps = (count: number, from: number) => Array.from({ length: count }, (_, i) => ({ id: from + i, text: `step ${from + i}` }));

describe('how many prompts a queue holds', () => {
  it('201st item is INVALID', async () => {
    const w = queueWorld({ rows: { s1: { items: prompts(200) } } });

    const err = await w.refused('queue_add_item', { id: 's1', text: 'one more' });

    expect(err.code).toBe('INVALID');
    expect(err.message).toBe('This queue already holds 200 prompts, the most one may hold.');
    expect(err.hint).toBe('Remove prompts that are no longer needed first.');
    expect(w.store.writes).toEqual([]);
  });

  it('takes the 200th', async () => {
    const w = queueWorld({ rows: { s1: { items: prompts(199) } } });

    await w.call('queue_add_item', { id: 's1', text: 'the last that fits' });

    expect(w.store.rows.get('s1')?.items).toHaveLength(200);
  });

  it('counts the prompts, not the entries that are not prompts', async () => {
    const w = queueWorld({ rows: { s1: { items: [...prompts(199), ...(['junk', 7, null] as never[])] } } });

    await w.call('queue_add_item', { id: 's1', text: 'still fits' });

    expect(w.store.writes).toHaveLength(1);
  });

  it('still lets a queue that is already over (the window took them) change, lose and reorder prompts', async () => {
    const w = queueWorld({ rows: { s1: { items: prompts(205) } } });

    await w.call('queue_edit_item', { id: 's1', itemId: 3, text: 'changed' });
    await w.call('queue_remove_item', { id: 's1', itemId: 4 });
    await w.call('queue_move_item', { id: 's1', itemId: 5, position: 0 });

    expect(w.store.writes).toHaveLength(3);
    expect((await w.refused('queue_add_item', { id: 's1', text: 'no room' })).code).toBe('INVALID');
  });
});

describe('how many steps a prompt carries', () => {
  it('21st step is INVALID: the before and after chains count together', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(1, { disabled: true, beforeChain: steps(12, 100), afterChain: steps(8, 200) })] } } });

    const before = await w.refused('queue_add_step', { id: 's1', itemId: 1, chain: 'before', text: 'one more' });
    const after = await w.refused('queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: 'one more' });

    for (const err of [before, after]) {
      expect(err.code).toBe('INVALID');
      expect(err.message).toBe('That prompt already has 20 chain steps, the most one may have.');
      expect(err.hint).toBe('Remove a step it no longer needs first, or queue the rest as another prompt.');
    }
    expect(w.store.writes).toEqual([]);
  });

  it('takes the 20th', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(1, { disabled: true, beforeChain: steps(12, 100), afterChain: steps(7, 200) })] } } });

    await w.call('queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: 'the last that fits' });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).afterChain).toHaveLength(8);
  });

  it('still lets a step of a full chain change, move and go', async () => {
    const w = queueWorld({ rows: { s1: { items: [item(1, { disabled: true, beforeChain: steps(20, 100) })] } } });

    await w.call('queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 100, text: 'changed' });
    await w.call('queue_move_step', { id: 's1', itemId: 1, chain: 'before', stepId: 100, position: 5 });
    await w.call('queue_remove_step', { id: 's1', itemId: 1, chain: 'before', stepId: 101 });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1).beforeChain).toHaveLength(19);
  });
});

describe('a runAt that is a date alone', () => {
  let zone: string | undefined;
  beforeAll(() => {
    zone = process.env.TZ;
    process.env.TZ = 'Pacific/Auckland';
  });
  afterAll(() => {
    if (zone === undefined) delete process.env.TZ;
    else process.env.TZ = zone;
  });

  const paused = () => queueWorld({ rows: { s1: { items: [item(1, { disabled: true })] } } });

  it('runAt "2026-10-25" is local midnight', async () => {
    const midnight = new Date(2026, 9, 25).getTime();
    expect(midnight).not.toBe(Date.UTC(2026, 9, 25));
    const w = paused();

    await w.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt: '2026-10-25' });

    expect(itemWith(w.store.rows.get('s1')?.items ?? [], 1)).toMatchObject({ type: 'schedule', runAt: midnight, nextFireAt: midnight });
  });

  it('reads a date with a time as before: local with no zone, and the zone it names when it has one', async () => {
    const local = paused();
    const zoned = paused();

    await local.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt: '2026-10-25T09:30' });
    await zoned.call('queue_set_item_schedule', { id: 's1', itemId: 1, type: 'schedule', runAt: '2026-10-25T09:30:00Z' });

    expect(itemWith(local.store.rows.get('s1')?.items ?? [], 1).runAt).toBe(new Date(2026, 9, 25, 9, 30).getTime());
    expect(itemWith(zoned.store.rows.get('s1')?.items ?? [], 1).runAt).toBe(Date.UTC(2026, 9, 25, 9, 30));
  });

  it('says so in the schema a client reads', () => {
    const runAt = toolNamed(paused().tools, 'queue_set_item_schedule').input.runAt as z.ZodType;

    expect(runAt.description).toMatch(/date alone/i);
    expect(runAt.description).toMatch(/midnight/i);
  });
});
