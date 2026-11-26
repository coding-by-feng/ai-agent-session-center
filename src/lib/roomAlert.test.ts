import { describe, expect, it } from 'vitest';
import { liveRoomIds, roomAlertClick, roomAlertState } from './roomAlert';

const map = (entries: Record<string, { status: string; alerted?: boolean }>) => new Map(Object.entries(entries));

describe('room Alert', () => {
  const sessions = map({
    a: { status: 'idle', alerted: true },
    b: { status: 'working' },
    c: { status: 'ended', alerted: false },
    d: { status: 'waiting', alerted: false },
  });

  it('counts only live members, in the room’s order, and skips dropped ids', () => {
    expect(liveRoomIds(['d', 'gone', 'c', 'a', 'b'], sessions)).toEqual(['d', 'a', 'b']);
  });

  it('reads all, some or none of the live sessions alerted', () => {
    expect(roomAlertState(['a', 'b', 'd'], sessions)).toBe('some');
    expect(roomAlertState(['a'], sessions)).toBe('all');
    expect(roomAlertState(['b', 'd'], sessions)).toBe('none');
    expect(roomAlertState([], sessions)).toBe('none');
  });

  it('turns Alert on for all when any is off, writing only the ones that change', () => {
    expect(roomAlertClick(['a', 'b', 'd'], sessions)).toEqual({ next: true, changes: ['b', 'd'] });
    expect(roomAlertClick(['b', 'd'], sessions)).toEqual({ next: true, changes: ['b', 'd'] });
  });

  it('turns Alert off for all when every live session is alerted', () => {
    const allOn = map({ a: { status: 'idle', alerted: true }, b: { status: 'working', alerted: true }, c: { status: 'ended' } });
    const live = liveRoomIds(['a', 'b', 'c'], allOn);
    expect(roomAlertClick(live, allOn)).toEqual({ next: false, changes: ['a', 'b'] });
  });
});
