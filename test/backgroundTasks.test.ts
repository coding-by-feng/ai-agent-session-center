import { describe, it, expect } from 'vitest';
import {
  toBackgroundTasks,
  BACKGROUND_TASKS_KEEP,
  BACKGROUND_DESCRIPTION_CAP,
  BACKGROUND_COMMAND_CAP,
} from '../server/backgroundTasks.js';

const teammate = (i: number, status = 'running') => ({ id: `t${i}`, type: 'teammate', status, description: `Task ${i}` });
const shell = { id: 'b1', type: 'shell', status: 'running', description: 'Wait for harness report', command: 'cd /x && until [ -f done ]; do sleep 5; done' };

describe('toBackgroundTasks', () => {
  it('is undefined when the hook sent no list, so the session keeps what it had', () => {
    expect(toBackgroundTasks(undefined, null, 1)).toBeUndefined();
    expect(toBackgroundTasks('nope', null, 1)).toBeUndefined();
  });

  it('counts agents, shells and active shells, and puts shells first', () => {
    const out = toBackgroundTasks([teammate(1), shell, teammate(2), { id: 'b2', type: 'shell', status: 'completed', command: 'ls' }], null, 100)!;
    expect(out).toMatchObject({ agents: 2, shells: 2, activeShells: 1, at: 100 });
    expect(out.items.map((t) => t.id)).toEqual(['b1', 'b2', 't1', 't2']);
    expect(out.items[0]).toEqual({ id: 'b1', type: 'shell', status: 'running', description: 'Wait for harness report', command: shell.command, firstSeenAt: 100 });
    expect(out.items[2].command).toBeNull();
  });

  it('keeps the time an id was first seen across Stops', () => {
    const first = toBackgroundTasks([shell], null, 100)!;
    const second = toBackgroundTasks([shell, teammate(1)], first, 200)!;
    expect(second.items.find((t) => t.id === 'b1')!.firstSeenAt).toBe(100);
    expect(second.items.find((t) => t.id === 't1')!.firstSeenAt).toBe(200);
  });

  it('caps the list but keeps the true totals', () => {
    const many = Array.from({ length: 82 }, (_, i) => teammate(i));
    const out = toBackgroundTasks([...many, shell], null, 1)!;
    expect(out.items).toHaveLength(BACKGROUND_TASKS_KEEP);
    expect(out.items[0].id).toBe('b1');
    expect(out).toMatchObject({ agents: 82, shells: 1, activeShells: 1 });
  });

  it('drops malformed entries and caps long text', () => {
    const out = toBackgroundTasks([
      null, 'x', { type: 'shell' }, { id: '', type: 'shell' },
      { id: 'b9', type: 'shell', status: 'running', description: 'd'.repeat(999), command: 'c'.repeat(9999) },
      { id: 't9', type: 7, status: null },
    ], null, 1)!;
    expect(out.items.map((t) => t.id)).toEqual(['b9', 't9']);
    expect(out.items[0].description).toHaveLength(BACKGROUND_DESCRIPTION_CAP);
    expect(out.items[0].command).toHaveLength(BACKGROUND_COMMAND_CAP);
    expect(out.items[1]).toMatchObject({ type: 'unknown', status: '' });
    expect(out).toMatchObject({ agents: 1, shells: 1 });
  });

  it('an empty list means nothing is running', () => {
    expect(toBackgroundTasks([], null, 5)).toEqual({ items: [], agents: 0, shells: 0, activeShells: 0, at: 5 });
  });

  it('never mutates the previous value', () => {
    const prev = toBackgroundTasks([shell], null, 1)!;
    const frozen = JSON.stringify(prev);
    toBackgroundTasks([], prev, 2);
    expect(JSON.stringify(prev)).toBe(frozen);
  });
});
