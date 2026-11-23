import { describe, it, expect } from 'vitest';
import { EMPTY_PUT_DOWN, dayKey, parsePutDown, putBack, putDown, putDownToday } from './recentPutDown';

// Nov 23 2026, local time: 10:00 and 23:59, then the next day.
const morning = new Date(2026, 10, 23, 10, 0).getTime();
const lateNight = new Date(2026, 10, 23, 23, 59).getTime();
const tomorrow = new Date(2026, 10, 24, 0, 1).getTime();

describe('recentPutDown', () => {
  it('dayKey is the local calendar day', () => {
    expect(dayKey(morning)).toBe('2026-11-23');
    expect(dayKey(tomorrow)).toBe('2026-11-24');
  });

  it('a session put down stays down for the rest of the day, then everything comes back', () => {
    const s = putDown(EMPTY_PUT_DOWN, 's1', morning);
    expect(putDownToday(s, lateNight)).toEqual(['s1']);
    expect(putDownToday(s, tomorrow)).toEqual([]);
  });

  it('put back returns one; putting the same one down twice keeps it once; returns new objects', () => {
    const a = putDown(EMPTY_PUT_DOWN, 's1', morning);
    const b = putDown(putDown(a, 's2', morning), 's1', morning);
    expect(putDownToday(b, morning)).toEqual(['s1', 's2']);
    const c = putBack(b, 's1', morning);
    expect(putDownToday(c, morning)).toEqual(['s2']);
    expect(putDownToday(b, morning)).toEqual(['s1', 's2']);
  });

  it('putting one down on a new day starts that day afresh', () => {
    const old = putDown(EMPTY_PUT_DOWN, 's1', morning);
    expect(putDown(old, 's2', tomorrow)).toEqual({ day: '2026-11-24', ids: ['s2'] });
  });

  it('parsePutDown keeps only a well-formed record', () => {
    expect(parsePutDown('{"day":"2026-11-23","ids":["a",3,"b"]}')).toEqual({ day: '2026-11-23', ids: ['a', 'b'] });
    for (const raw of [null, '', 'nope', '[]', '{"day":5,"ids":[]}', '{"day":"x"}']) expect(parsePutDown(raw)).toEqual(EMPTY_PUT_DOWN);
  });
});
