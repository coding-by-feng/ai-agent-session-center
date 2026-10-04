// sessionStatusStyle.test.ts — one name and one colour per session status,
// shared by the panel's rail and the LIVE board so a status reads the same on
// both (they list the same sessions side by side in a user's head).
import { describe, it, expect } from 'vitest';
import { STATUS_COLORS, STATUS_LEGEND, statusColor, statusLabel } from './sessionStatusStyle';
import { STATUS_ORDER } from './sessionSort';

describe('session status names and colours', () => {
  it('names every status the sort knows, in the sort order', () => {
    const legendOrder = STATUS_LEGEND.map((e) => e.status);
    expect(new Set(legendOrder)).toEqual(new Set(Object.keys(STATUS_ORDER)));
    const weights = legendOrder.map((st) => STATUS_ORDER[st]);
    expect(weights).toEqual([...weights].sort((a, b) => a - b));
  });

  it('gives every named status a theme colour', () => {
    for (const { status } of STATUS_LEGEND) {
      expect(STATUS_COLORS[status]).toMatch(/^var\(--/);
    }
  });

  it('labels the two "needs you" states by what they need', () => {
    expect(statusLabel('approval')).toBe('Approval needed');
    expect(statusLabel('input')).toBe('Waiting for input');
    expect(statusLabel('ended')).toBe('Disconnected');
  });

  it('falls back to the raw status and a dim colour for anything unknown', () => {
    expect(statusLabel('mystery')).toBe('mystery');
    expect(statusColor('mystery')).toBe('var(--text-dim)');
    expect(statusColor('working')).toBe('var(--accent-orange)');
  });
});
