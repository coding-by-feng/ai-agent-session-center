// roomColor.test.ts — the one palette every room-coloured surface shares: the
// session strip's room frames, the header strip, and the LIVE board's room chips.
import { describe, it, expect } from 'vitest';
import { ROOM_COLOR_PALETTE, roomColor } from './roomColor';

describe('ROOM_COLOR_PALETTE', () => {
  it('keeps the eight slots the strip and the header strip were drawn with', () => {
    expect(ROOM_COLOR_PALETTE).toEqual([
      'var(--accent-orange)',
      '#4a9eff',
      'var(--accent-green)',
      'var(--accent-purple)',
      'var(--accent-yellow)',
      '#ff69b4',
      'var(--accent-cyan)',
      '#ff7043',
    ]);
  });
});

describe('roomColor', () => {
  it('takes a room its colour from its roomIndex', () => {
    expect(roomColor({ roomIndex: 0 })).toBe(ROOM_COLOR_PALETTE[0]);
    expect(roomColor({ roomIndex: 3 })).toBe(ROOM_COLOR_PALETTE[3]);
    expect(roomColor({ roomIndex: 7 })).toBe(ROOM_COLOR_PALETTE[7]);
  });

  it('cycles when there are more rooms than colours', () => {
    expect(roomColor({ roomIndex: 8 })).toBe(ROOM_COLOR_PALETTE[0]);
    expect(roomColor({ roomIndex: 11 })).toBe(ROOM_COLOR_PALETTE[3]);
  });

  it('gives a room with no roomIndex (a corridor room) the first colour', () => {
    expect(roomColor({})).toBe(ROOM_COLOR_PALETTE[0]);
    expect(roomColor({ roomIndex: undefined })).toBe(ROOM_COLOR_PALETTE[0]);
  });

  it('wraps a negative index instead of returning undefined', () => {
    expect(roomColor({ roomIndex: -1 })).toBe(ROOM_COLOR_PALETTE[7]);
  });
});
