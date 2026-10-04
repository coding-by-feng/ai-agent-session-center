import { describe, it, expect } from 'vitest';
import type { PlanUsage, PlanUsageWindow } from '@/types/session';
import {
  HIGH_AT_PERCENT,
  STALE_AFTER_MS,
  WARN_AT_PERCENT,
  activeWindows,
  describePlanUsage,
  formatAsOf,
  formatPercent,
  formatResetAt,
  formatResetIn,
  isStale,
  pickWindow,
  severityFor,
  windowLabel,
  windowName,
} from './planUsage';

// Saturday 3 Oct 2026, 13:08 UTC. Every formatter is told the locale and zone
// so the assertions do not depend on the machine running them.
const NOW = Date.UTC(2026, 9, 3, 13, 8, 0);
const FMT = { locale: 'en-GB', timeZone: 'UTC' } as const;
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

const win = (minutes: number, usedPercent: number, resetsAt: number | null = NOW + HOUR): PlanUsageWindow => ({
  minutes,
  usedPercent,
  resetsAt,
});
const usage = (windows: PlanUsageWindow[], over: Partial<PlanUsage> = {}): PlanUsage => ({
  cli: 'claude',
  windows,
  asOf: NOW - MIN,
  ...over,
});

describe('windowLabel / windowName', () => {
  it('names the two windows the CLIs report', () => {
    expect(windowLabel(300)).toBe('5h');
    expect(windowLabel(10080)).toBe('wk');
    expect(windowName(300)).toBe('5-hour');
    expect(windowName(10080)).toBe('weekly');
  });

  it('falls back to minutes, hours or days for any other length', () => {
    expect(windowLabel(30)).toBe('30m');
    expect(windowLabel(120)).toBe('2h');
    expect(windowLabel(1440)).toBe('1d');
    expect(windowLabel(43200)).toBe('30d');
    expect(windowName(120)).toBe('2h');
    expect(windowName(43200)).toBe('30d');
  });

  it('never prints NaN for a window length it cannot read', () => {
    expect(windowLabel(Number.NaN)).toBe('?');
    expect(windowLabel(0)).toBe('?');
    expect(windowName(-5)).toBe('?');
  });
});

describe('formatPercent', () => {
  it('rounds to a whole number', () => {
    expect(formatPercent(63.4)).toBe('63%');
    expect(formatPercent(63.6)).toBe('64%');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(100)).toBe('100%');
  });

  it('says "<1%" for a sliver rather than a misleading 0%', () => {
    expect(formatPercent(0.4)).toBe('<1%');
    expect(formatPercent(0.99)).toBe('<1%');
    expect(formatPercent(1)).toBe('1%');
  });

  it('clamps out-of-range and unreadable values', () => {
    expect(formatPercent(140)).toBe('100%');
    expect(formatPercent(-3)).toBe('0%');
    expect(formatPercent(Number.NaN)).toBe('0%');
  });
});

describe('severityFor', () => {
  it('has the documented thresholds', () => {
    expect(WARN_AT_PERCENT).toBe(60);
    expect(HIGH_AT_PERCENT).toBe(85);
  });

  it('is ok below 60, warn from 60 to just under 85, high from 85', () => {
    expect(severityFor(0)).toBe('ok');
    expect(severityFor(59)).toBe('ok');
    expect(severityFor(60)).toBe('warn');
    expect(severityFor(84)).toBe('warn');
    expect(severityFor(85)).toBe('high');
    expect(severityFor(100)).toBe('high');
  });

  it('judges the number the user reads, so "85%" is never drawn as a warning', () => {
    expect(severityFor(84.5)).toBe('high'); // shows as 85%
    expect(severityFor(84.4)).toBe('warn'); // shows as 84%
    expect(severityFor(59.5)).toBe('warn'); // shows as 60%
  });

  it('is high whenever the CLI says a limit was hit', () => {
    expect(severityFor(10, true)).toBe('high');
    expect(severityFor(10, false)).toBe('ok');
  });
});

describe('activeWindows', () => {
  it('drops a window that has already reset — its stored percentage is the old one', () => {
    const u = usage([win(300, 90, NOW - 1), win(10080, 20, NOW + DAY)]);
    expect(activeWindows(u, NOW).map((w) => w.minutes)).toEqual([10080]);
  });

  it('treats a reset exactly now as reset', () => {
    expect(activeWindows(usage([win(300, 50, NOW)]), NOW)).toEqual([]);
  });

  it('keeps a window whose reset time is unknown', () => {
    expect(activeWindows(usage([win(300, 50, null)]), NOW)).toHaveLength(1);
  });

  it('lists the shortest window first and leaves its input alone', () => {
    const windows = [win(10080, 20), win(300, 60)];
    const u = usage(windows);
    expect(activeWindows(u, NOW).map((w) => w.minutes)).toEqual([300, 10080]);
    expect(u.windows.map((w) => w.minutes)).toEqual([10080, 300]);
  });

  it('ignores a window whose percentage cannot be read', () => {
    expect(activeWindows(usage([win(300, Number.NaN), win(10080, 5)]), NOW).map((w) => w.minutes)).toEqual([10080]);
  });
});

describe('pickWindow', () => {
  it('picks the most-used window', () => {
    expect(pickWindow([win(300, 40), win(10080, 70)])?.minutes).toBe(10080);
  });

  it('breaks a tie in favour of the shorter window', () => {
    expect(pickWindow([win(10080, 50), win(300, 50)])?.minutes).toBe(300);
    expect(pickWindow([win(300, 50), win(10080, 50)])?.minutes).toBe(300);
  });

  it('has nothing to pick from an empty list', () => {
    expect(pickWindow([])).toBeNull();
  });
});

describe('isStale', () => {
  it('is stale only after ten full minutes', () => {
    expect(STALE_AFTER_MS).toBe(10 * MIN);
    expect(isStale(usage([win(300, 1)], { asOf: NOW - 10 * MIN }), NOW)).toBe(false);
    expect(isStale(usage([win(300, 1)], { asOf: NOW - 10 * MIN - 1 }), NOW)).toBe(true);
  });

  it('is not stale when the clock reads earlier than the report', () => {
    expect(isStale(usage([win(300, 1)], { asOf: NOW + HOUR }), NOW)).toBe(false);
  });
});

describe('formatResetIn', () => {
  it('counts down in minutes, then hours and minutes', () => {
    expect(formatResetIn(NOW + 30_000, NOW, FMT)).toBe('<1m');
    expect(formatResetIn(NOW + MIN, NOW, FMT)).toBe('1m');
    expect(formatResetIn(NOW + 59 * MIN, NOW, FMT)).toBe('59m');
    expect(formatResetIn(NOW + 72 * MIN, NOW, FMT)).toBe('1h 12m');
    expect(formatResetIn(NOW + 2 * HOUR, NOW, FMT)).toBe('2h');
    expect(formatResetIn(NOW + 47 * HOUR + 59 * MIN, NOW, FMT)).toBe('47h 59m');
  });

  it('floors, so the countdown never promises more time than is left', () => {
    expect(formatResetIn(NOW + 72 * MIN + 59_000, NOW, FMT)).toBe('1h 12m');
  });

  it('switches to a short date from 48 hours out', () => {
    const at = NOW + 48 * HOUR;
    const text = formatResetIn(at, NOW, FMT);
    expect(text).toBe(new Intl.DateTimeFormat('en-GB', { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(at));
    expect(text).toMatch(/Oct/);
  });

  it('does not print a negative countdown for a reset that just passed', () => {
    expect(formatResetIn(NOW - 5 * MIN, NOW, FMT)).toBe('<1m');
  });
});

describe('formatResetAt', () => {
  it('shows only the time when the reset is later today', () => {
    const text = formatResetAt(Date.UTC(2026, 9, 3, 14, 20), NOW, FMT);
    expect(text).toBe('14:20');
  });

  it('adds the weekday for a reset later this week', () => {
    const text = formatResetAt(Date.UTC(2026, 9, 5, 9, 0), NOW, FMT); // Monday
    expect(text).toContain('Mon');
    expect(text).toContain('09:00');
  });

  it('shows a date, without a time, a week or more away', () => {
    const text = formatResetAt(Date.UTC(2026, 9, 12, 9, 0), NOW, FMT);
    expect(text).toMatch(/12/);
    expect(text).toMatch(/Oct/);
    expect(text).not.toContain('09:00');
  });

  it('reads the calendar day in the zone it is given, not in UTC', () => {
    // 08:00 and 22:00 UTC on the 3rd are the same day in UTC, but in Auckland
    // (UTC+13 in October) they are 21:00 on the 3rd and 11:00 on the 4th.
    const now = Date.UTC(2026, 9, 3, 8, 0);
    const at = Date.UTC(2026, 9, 3, 22, 0);
    expect(formatResetAt(at, now, FMT)).toBe('22:00');
    const auckland = formatResetAt(at, now, { locale: 'en-GB', timeZone: 'Pacific/Auckland' });
    expect(auckland).toContain('Sun');
    expect(auckland).toContain('11:00');
  });
});

describe('formatAsOf', () => {
  it('shows only the time for a report from today', () => {
    expect(formatAsOf(Date.UTC(2026, 9, 3, 11, 5), NOW, FMT)).toBe('11:05');
  });

  it('adds the date for a report from an earlier day', () => {
    const text = formatAsOf(Date.UTC(2026, 9, 1, 11, 5), NOW, FMT);
    expect(text).toMatch(/Oct/);
    expect(text).toContain('11:05');
  });
});

describe('describePlanUsage', () => {
  it('describes the headline window, every window, and a sentence for a screen reader', () => {
    const u = usage([win(300, 63, NOW + 72 * MIN), win(10080, 21, NOW + 2 * DAY + 3 * HOUR)]);
    const v = describePlanUsage('claude', u, NOW, FMT);
    expect(v.state).toBe('ready');
    expect(v.headline?.label).toBe('5h');
    expect(v.headline?.percentText).toBe('63%');
    expect(v.headline?.resetInText).toBe('1h 12m');
    expect(v.severity).toBe('warn');
    expect(v.rows.map((r) => r.label)).toEqual(['5h', 'wk']);
    expect(v.ariaLabel).toBe('Claude plan usage: 63% of the 5-hour limit used, resets in 1 hour 12 minutes');
    expect(v.tooltipTitle).toBe('Claude Code · plan usage');
    expect(v.reason).toBeNull();
    expect(v.stale).toBe(false);
  });

  it('headlines the weekly window when it is the more used one', () => {
    const v = describePlanUsage('claude', usage([win(300, 10), win(10080, 80, NOW + 3 * DAY)]), NOW, FMT);
    expect(v.headline?.label).toBe('wk');
    expect(v.ariaLabel).toContain('of the weekly limit used');
  });

  it('speaks a reset two days or more away as a date', () => {
    const v = describePlanUsage('claude', usage([win(10080, 40, NOW + 3 * DAY)]), NOW, FMT);
    expect(v.ariaLabel).toMatch(/resets on /);
    expect(v.ariaLabel).not.toMatch(/resets in /);
  });

  it('flags a high reading with the alert severity', () => {
    const v = describePlanUsage('claude', usage([win(300, 91)]), NOW, FMT);
    expect(v.severity).toBe('high');
    expect(v.headline?.severity).toBe('high');
  });

  it('treats a reported limit as high whatever the percentage, and says so', () => {
    const v = describePlanUsage('codex', usage([win(10080, 12)], { cli: 'codex', limitReached: true }), NOW, FMT);
    expect(v.severity).toBe('high');
    expect(v.limitReached).toBe(true);
    expect(v.ariaLabel).toContain('limit reached');
  });

  it('marks a report older than ten minutes as stale and says when it was made', () => {
    const v = describePlanUsage('claude', usage([win(300, 63)], { asOf: NOW - 11 * MIN }), NOW, FMT);
    expect(v.stale).toBe(true);
    expect(v.asOf).toBe('12:57');
    expect(v.ariaLabel).toContain('as of 12:57');
  });

  it('names the Codex plan in the tooltip title, raw, and falls back without one', () => {
    const withPlan = describePlanUsage('codex', usage([win(10080, 26)], { cli: 'codex', plan: 'prolite' }), NOW, FMT);
    expect(withPlan.tooltipTitle).toBe('Codex · prolite');
    expect(withPlan.plan).toBe('prolite');
    const without = describePlanUsage('codex', usage([win(10080, 26)], { cli: 'codex' }), NOW, FMT);
    expect(without.tooltipTitle).toBe('Codex · plan usage');
    expect(without.ariaLabel).toMatch(/^Codex plan usage: 26% of the weekly limit used/);
  });

  it('skips an expired window and keeps the live one', () => {
    const v = describePlanUsage('claude', usage([win(300, 95, NOW - MIN), win(10080, 30, NOW + 2 * DAY)]), NOW, FMT);
    expect(v.state).toBe('ready');
    expect(v.headline?.label).toBe('wk');
    expect(v.rows).toHaveLength(1);
  });

  it('explains itself when every window has reset', () => {
    const v = describePlanUsage('claude', usage([win(300, 95, NOW - MIN)]), NOW, FMT);
    expect(v.state).toBe('expired');
    expect(v.headline).toBeNull();
    expect(v.reason).toBe('The usage window has reset since the last report.');
    expect(v.ariaLabel).toBe('Claude plan usage unavailable: The usage window has reset since the last report.');
  });

  it('explains why there are no numbers yet, per CLI', () => {
    const claude = describePlanUsage('claude', null, NOW, FMT);
    expect(claude.state).toBe('empty');
    expect(claude.reason).toBe('Plan usage is read from Claude sessions started in this dashboard — none has reported yet.');
    const codex = describePlanUsage('codex', undefined, NOW, FMT);
    expect(codex.state).toBe('empty');
    expect(codex.reason).toBe('Plan usage appears once Codex has made a request.');
    expect(codex.tooltipTitle).toBe('Codex · plan usage');
  });

  it('treats an observation with no readable window as empty', () => {
    const v = describePlanUsage('claude', usage([win(300, Number.NaN)]), NOW, FMT);
    expect(v.state).toBe('empty');
  });

  it('reads "<1%" aloud as "under 1%"', () => {
    const v = describePlanUsage('claude', usage([win(300, 0.2)]), NOW, FMT);
    expect(v.headline?.percentText).toBe('<1%');
    expect(v.ariaLabel).toContain('under 1% of the 5-hour limit');
  });

  it('says whether a reset text is a countdown or a date, so the tooltip never prints both', () => {
    const near = describePlanUsage('claude', usage([win(300, 40, NOW + 72 * MIN)]), NOW, FMT);
    expect(near.headline?.resetIsCountdown).toBe(true);
    const far = describePlanUsage('claude', usage([win(10080, 40, NOW + 3 * DAY)]), NOW, FMT);
    expect(far.headline?.resetIsCountdown).toBe(false);
    const unknown = describePlanUsage('claude', usage([win(300, 40, null)]), NOW, FMT);
    expect(unknown.headline?.resetIsCountdown).toBe(false);
  });

  it('never draws more than a full bar, or less than an empty one', () => {
    const over = describePlanUsage('claude', usage([win(300, 140)]), NOW, FMT);
    expect(over.headline?.usedPercent).toBe(100);
    expect(over.headline?.percentText).toBe('100%');
    const under = describePlanUsage('claude', usage([win(300, -8)]), NOW, FMT);
    expect(under.headline?.usedPercent).toBe(0);
    expect(under.headline?.percentText).toBe('0%');
  });

  it('keeps a window with no reset time and does not invent one', () => {
    const v = describePlanUsage('claude', usage([win(300, 40, null)]), NOW, FMT);
    expect(v.headline?.resetInText).toBeNull();
    expect(v.headline?.resetAtText).toBeNull();
    expect(v.ariaLabel).toBe('Claude plan usage: 40% of the 5-hour limit used');
  });
});
