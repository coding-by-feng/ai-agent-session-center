// sessionStatusStyle.test.ts — one name and one colour per session status,
// shared by the panel's rail and the LIVE board so a status reads the same on
// both (they list the same sessions side by side in a user's head).
import { describe, it, expect } from 'vitest';
import { PROCEED, STATUS_COLORS, STATUS_LEGEND, displayStatus, owesProceed, statusColor, statusLabel } from './sessionStatusStyle';
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

// Oct 23 2026: a finished session whose last answer asks "Reply proceed…" shows a P until someone replies.
describe('the "asks you to proceed" reminder', () => {
  it('shows in place of a finished or idle status while a reply is owed', () => {
    expect(owesProceed({ status: 'waiting', pendingProceedAt: 1 })).toBe(true);
    expect(owesProceed({ status: 'idle', pendingProceedAt: 1 })).toBe(true);
    expect(displayStatus({ status: 'idle', pendingProceedAt: 1 })).toBe(PROCEED);
    expect(displayStatus({ status: 'idle', pendingProceedAt: null })).toBe('idle');
  });

  it('never hides a status that blocks the session or means it is busy or gone', () => {
    for (const status of ['approval', 'input', 'working', 'prompting', 'ended', 'connecting']) {
      expect(displayStatus({ status, pendingProceedAt: 1 })).toBe(status);
    }
  });

  it('has its own words and an amber colour, and stays out of the status legend', () => {
    expect(statusLabel(PROCEED)).toBe('Asks you to proceed');
    expect(statusColor(PROCEED)).toBe('var(--accent-yellow)');
    expect(STATUS_LEGEND.some((e) => e.status === PROCEED)).toBe(false);
  });
});
