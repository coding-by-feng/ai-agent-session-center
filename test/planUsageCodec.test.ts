import { describe, it, expect } from 'vitest';
import {
  FIVE_HOUR_MINUTES,
  WEEK_MINUTES,
  MERGE_HORIZON_MS,
  SAME_WINDOW_TOLERANCE_MS,
  MAX_FUTURE_SKEW_MS,
  MAX_RESET_AHEAD_MS,
  toEpochMs,
  toPercent,
  parseCodexLine,
  latestCodexUsage,
  parseClaudeSnapshot,
  mergeObservations,
  sameInstance,
  sameNumbers,
  sanitizeObservation,
  planCliOf,
} from '../server/planUsageCodec.js';
import { detectCli } from '../src/lib/cliDetect';
import type { PlanUsage } from '../src/types/session.js';

// A real Codex `token_count` line, shape taken from a local rollout (numbers only).
const RESETS_AT_S = 1791581013;
const codexLine = (over: { rateLimits?: unknown; timestamp?: string | null } = {}): string =>
  JSON.stringify({
    ...(over.timestamp === null ? {} : { timestamp: over.timestamp ?? '2026-10-03T21:40:04.507Z' }),
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: { total_token_usage: { input_tokens: 10 }, model_context_window: 258400 },
      rate_limits: 'rateLimits' in over ? over.rateLimits : {
        limit_id: 'codex',
        limit_name: null,
        primary: { used_percent: 26.0, window_minutes: 10080, resets_at: RESETS_AT_S },
        secondary: null,
        credits: { has_credits: false, unlimited: false, balance: '0' },
        individual_limit: null,
        spend_control_reached: null,
        plan_type: 'prolite',
        rate_limit_reached_type: null,
      },
    },
  });

const claudeSnap = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({
    session_id: '13ab37cc-aeac-4906-8f67-360aee1d1b87',
    ts: 1791500000000,
    rate_limits: {
      five_hour: { used_percentage: 23.5, resets_at: 1791514800 },
      seven_day: { used_percentage: 41.2, resets_at: 1791857600 },
    },
    ...over,
  });

const usage = (over: Partial<PlanUsage> = {}): PlanUsage => ({
  cli: 'claude',
  windows: [{ minutes: FIVE_HOUR_MINUTES, usedPercent: 30, resetsAt: 2_000_000_000_000 }],
  asOf: 1_000_000,
  ...over,
});

describe('toEpochMs', () => {
  it('treats ~10-digit numbers as epoch seconds', () => {
    expect(toEpochMs(RESETS_AT_S)).toBe(RESETS_AT_S * 1000);
  });
  it('keeps ~13-digit numbers as epoch milliseconds', () => {
    expect(toEpochMs(1791581013000)).toBe(1791581013000);
  });
  it('switches unit exactly at 1e12', () => {
    expect(toEpochMs(999_999_999_999)).toBe(999_999_999_999_000);
    expect(toEpochMs(1e12)).toBe(1e12);
  });
  it('parses ISO strings and numeric strings', () => {
    expect(toEpochMs('2026-10-03T21:40:04.507Z')).toBe(Date.parse('2026-10-03T21:40:04.507Z'));
    expect(toEpochMs(String(RESETS_AT_S))).toBe(RESETS_AT_S * 1000);
  });
  it('rejects anything that is not a plausible time', () => {
    for (const bad of [null, undefined, '', 'soon', NaN, Infinity, 5, -1, {}, [], true]) {
      expect(toEpochMs(bad)).toBeNull();
    }
  });
});

describe('toPercent', () => {
  it('clamps to 0–100 and keeps one decimal', () => {
    expect(toPercent(26)).toBe(26);
    expect(toPercent(23.456)).toBe(23.5);
    expect(toPercent(-3)).toBe(0);
    expect(toPercent(140)).toBe(100);
  });
  it('rejects non-numbers (a stringly percent is not trusted)', () => {
    for (const bad of [null, undefined, '26', NaN, Infinity, {}, []]) {
      expect(toPercent(bad)).toBeNull();
    }
  });
});

describe('parseCodexLine', () => {
  it('reads the weekly window, plan and time of a real token_count line', () => {
    expect(parseCodexLine(codexLine())).toEqual({
      cli: 'codex',
      plan: 'prolite',
      windows: [{ minutes: WEEK_MINUTES, usedPercent: 26, resetsAt: RESETS_AT_S * 1000 }],
      asOf: Date.parse('2026-10-03T21:40:04.507Z'),
    });
  });

  it('reads both windows when the account has a 5-hour and a weekly one, in report order', () => {
    const line = codexLine({
      rateLimits: {
        primary: { used_percent: 63, window_minutes: 300, resets_at: RESETS_AT_S },
        secondary: { used_percent: 20, window_minutes: 10080, resets_at: RESETS_AT_S + 86400 },
        plan_type: 'pro',
        rate_limit_reached_type: null,
      },
    });
    expect(parseCodexLine(line)?.windows.map((w) => [w.minutes, w.usedPercent])).toEqual([
      [300, 63],
      [10080, 20],
    ]);
  });

  it('returns null when the event carries no limits (null rate_limits, or both windows null)', () => {
    expect(parseCodexLine(codexLine({ rateLimits: null }))).toBeNull();
    expect(parseCodexLine(codexLine({ rateLimits: { primary: null, secondary: null } }))).toBeNull();
  });

  it('skips a window it cannot label or measure, and keeps the other', () => {
    const line = codexLine({
      rateLimits: {
        primary: { used_percent: 12, resets_at: RESETS_AT_S }, // no window_minutes
        secondary: { used_percent: 20, window_minutes: 10080, resets_at: RESETS_AT_S },
      },
    });
    expect(parseCodexLine(line)?.windows).toEqual([
      { minutes: 10080, usedPercent: 20, resetsAt: RESETS_AT_S * 1000 },
    ]);
    const none = codexLine({
      rateLimits: { primary: { window_minutes: 300, resets_at: RESETS_AT_S }, secondary: null },
    });
    expect(parseCodexLine(none)).toBeNull();
  });

  it('keeps a window whose reset time is unknown, with resetsAt null', () => {
    const line = codexLine({
      rateLimits: { primary: { used_percent: 5, window_minutes: 300 }, secondary: null },
    });
    expect(parseCodexLine(line)?.windows).toEqual([{ minutes: 300, usedPercent: 5, resetsAt: null }]);
  });

  it('flags a reached limit', () => {
    const line = codexLine({
      rateLimits: {
        primary: { used_percent: 100, window_minutes: 300, resets_at: RESETS_AT_S },
        secondary: null,
        rate_limit_reached_type: 'primary',
      },
    });
    expect(parseCodexLine(line)?.limitReached).toBe(true);
    expect(parseCodexLine(codexLine())).not.toHaveProperty('limitReached');
  });

  it('only lets a short, plain plan name through to the client', () => {
    const withPlan = (plan: unknown) => parseCodexLine(codexLine({
      rateLimits: { primary: { used_percent: 1, window_minutes: 300, resets_at: RESETS_AT_S }, secondary: null, plan_type: plan },
    }));
    expect(withPlan('plus')?.plan).toBe('plus');
    expect(withPlan('<script>alert(1)</script>')).not.toHaveProperty('plan');
    expect(withPlan('x'.repeat(33))).not.toHaveProperty('plan');
    expect(withPlan(7)).not.toHaveProperty('plan');
  });

  it('needs a timestamp: the line itself, else the caller’s fallback, else it is not usable', () => {
    expect(parseCodexLine(codexLine({ timestamp: null }))).toBeNull();
    expect(parseCodexLine(codexLine({ timestamp: null }), 1_791_000_000_000)?.asOf).toBe(1_791_000_000_000);
  });

  describe('limit families: a rollout carries more than one meter', () => {
    // Real rollouts interleave `limit_id: "codex"` (the account's main meter) with
    // `limit_id: "codex_bengalfox"` (another family), both with a 10080-minute primary window.
    const family = (limitId: unknown, pct: number) => codexLine({
      rateLimits: {
        limit_id: limitId,
        primary: { used_percent: pct, window_minutes: 10080, resets_at: RESETS_AT_S },
        secondary: null,
        plan_type: 'prolite',
        rate_limit_reached_type: null,
      },
    });

    it('reads the main `codex` meter', () => {
      expect(parseCodexLine(family('codex', 26))?.windows[0].usedPercent).toBe(26);
    });

    it('reads a line that names no family at all (absent or null)', () => {
      expect(parseCodexLine(family(undefined, 26))?.windows[0].usedPercent).toBe(26);
      expect(parseCodexLine(family(null, 26))?.windows[0].usedPercent).toBe(26);
    });

    it('ignores every other family — their numbers are not the account\'s', () => {
      for (const other of ['codex_bengalfox', 'codex_mini', 'CODEX', ' codex', '', 5, {}, ['codex']]) {
        expect(parseCodexLine(family(other, 0))).toBeNull();
      }
    });

    it('does not let another family\'s reached-limit flag leak into the main meter', () => {
      const flagged = codexLine({
        rateLimits: {
          limit_id: 'codex_bengalfox',
          primary: { used_percent: 100, window_minutes: 10080, resets_at: RESETS_AT_S },
          secondary: null,
          rate_limit_reached_type: 'primary',
        },
      });
      expect(parseCodexLine(flagged)).toBeNull();
    });
  });

  it('ignores lines that are not token_count events or not JSON', () => {
    expect(parseCodexLine('')).toBeNull();
    expect(parseCodexLine('{"type":"event_msg","payload":{"type":"agent_message"}}')).toBeNull();
    expect(parseCodexLine('not json token_count')).toBeNull();
    // Same payload as a real one, but not an event_msg: not ours to read.
    const wrongType = JSON.stringify({
      timestamp: '2026-10-03T21:40:04.507Z',
      type: 'response_item',
      payload: { type: 'token_count', rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: RESETS_AT_S }, secondary: null } },
    });
    expect(parseCodexLine(wrongType)).toBeNull();
  });
});

describe('latestCodexUsage', () => {
  const at = (iso: string, pct: number) => codexLine({
    timestamp: iso,
    rateLimits: { primary: { used_percent: pct, window_minutes: 10080, resets_at: RESETS_AT_S }, secondary: null },
  });

  it('takes the newest usable line', () => {
    const text = [at('2026-10-03T10:00:00Z', 10), '{"type":"noise"}', at('2026-10-03T11:00:00Z', 12), '{"type":"noise"}'].join('\n');
    expect(latestCodexUsage(text)?.windows[0].usedPercent).toBe(12);
  });

  it('steps over newer events that carry no limits instead of reporting nothing', () => {
    const empty = codexLine({ timestamp: '2026-10-03T12:00:00Z', rateLimits: { primary: null, secondary: null } });
    expect(latestCodexUsage([at('2026-10-03T11:00:00Z', 12), empty].join('\n'))?.windows[0].usedPercent).toBe(12);
  });

  it('reports the newest line of the MAIN meter even when another family wrote a newer one', () => {
    const other = (iso: string, pct: number) => codexLine({
      timestamp: iso,
      rateLimits: { limit_id: 'codex_bengalfox', primary: { used_percent: pct, window_minutes: 10080, resets_at: RESETS_AT_S + 86_400 }, secondary: null },
    });
    const text = [at('2026-10-03T11:00:00Z', 27), other('2026-10-03T11:30:00Z', 0), other('2026-10-03T11:45:00Z', 1)].join('\n');
    expect(latestCodexUsage(text)?.windows[0].usedPercent).toBe(27);
  });

  it('survives a first line cut in half by a tail read', () => {
    const cut = at('2026-10-03T11:00:00Z', 12).slice(40);
    expect(latestCodexUsage([cut, at('2026-10-03T11:30:00Z', 13)].join('\n'))?.windows[0].usedPercent).toBe(13);
    expect(latestCodexUsage(cut)).toBeNull();
  });

  it('returns null for empty or unusable text, and handles CRLF', () => {
    expect(latestCodexUsage('')).toBeNull();
    expect(latestCodexUsage('{"type":"noise"}\n')).toBeNull();
    expect(latestCodexUsage(at('2026-10-03T11:00:00Z', 12) + '\r\n')?.windows[0].usedPercent).toBe(12);
  });
});

describe('parseClaudeSnapshot', () => {
  it('reads the documented 5-hour and 7-day windows (resets_at in seconds)', () => {
    expect(parseClaudeSnapshot(claudeSnap())).toEqual({
      cli: 'claude',
      windows: [
        { minutes: FIVE_HOUR_MINUTES, usedPercent: 23.5, resetsAt: 1791514800 * 1000 },
        { minutes: WEEK_MINUTES, usedPercent: 41.2, resetsAt: 1791857600 * 1000 },
      ],
      asOf: 1791500000000,
    });
  });

  it('copes with either window being absent, and ignores windows it does not know', () => {
    const only7 = claudeSnap({ rate_limits: { seven_day: { used_percentage: 9, resets_at: 1791857600 }, spend_limit: { used_usd: 1 } } });
    expect(parseClaudeSnapshot(only7)?.windows.map((w) => w.minutes)).toEqual([WEEK_MINUTES]);
  });

  it('is null without any usable window or time', () => {
    expect(parseClaudeSnapshot(claudeSnap({ rate_limits: {} }))).toBeNull();
    expect(parseClaudeSnapshot(claudeSnap({ rate_limits: { five_hour: { resets_at: 1791514800 } } }))).toBeNull();
    expect(parseClaudeSnapshot(claudeSnap({ ts: 'never' }))).toBeNull();
    expect(parseClaudeSnapshot(claudeSnap({ rate_limits: null }))).toBeNull();
    expect(parseClaudeSnapshot('{not json')).toBeNull();
    expect(parseClaudeSnapshot('')).toBeNull();
  });

  it('flags a limit that is used up', () => {
    const full = claudeSnap({ rate_limits: { five_hour: { used_percentage: 100, resets_at: 1791514800 } } });
    expect(parseClaudeSnapshot(full)?.limitReached).toBe(true);
    expect(parseClaudeSnapshot(claudeSnap())).not.toHaveProperty('limitReached');
  });
});

describe('mergeObservations', () => {
  const win = (minutes: number, usedPercent: number, resetsAt: number | null) => ({ minutes, usedPercent, resetsAt });
  const R = 2_000_000_000_000;
  const H = 3_600_000;

  it('is null for nothing', () => {
    expect(mergeObservations([])).toBeNull();
    expect(mergeObservations([], usage())).toBeNull(); // what was known is not an observation
  });

  it('takes the newest observation', () => {
    const merged = mergeObservations([
      usage({ asOf: 1000, windows: [win(300, 10, R)] }),
      usage({ asOf: 3000, windows: [win(300, 30, R + 5_000_000)] }),
      usage({ asOf: 2000, windows: [win(300, 20, R + 1_000_000)] }),
    ]);
    expect(merged?.asOf).toBe(3000);
    expect(merged?.windows).toEqual([win(300, 30, R + 5_000_000)]);
  });

  it('does not let a stale re-render understate usage: same window, lower percent, later write', () => {
    // Session B re-rendered its status line with numbers from its LAST reply (old), stamped now.
    const fresh = usage({ asOf: 1000, windows: [win(300, 45, R)] });
    const staleRerender = usage({ asOf: 5000, windows: [win(300, 40, R)] });
    const merged = mergeObservations([fresh, staleRerender]);
    expect(merged?.windows[0].usedPercent).toBe(45);
    expect(merged?.asOf).toBe(5000);
  });

  it('prefers a window that has rolled over (later resetsAt) whatever the write times say', () => {
    const rolled = usage({ asOf: 1000, windows: [win(300, 2, R + 18_000_000)] });
    const staleRerender = usage({ asOf: 5000, windows: [win(300, 90, R)] });
    expect(mergeObservations([rolled, staleRerender])?.windows[0]).toEqual(win(300, 2, R + 18_000_000));
  });

  it('knows nothing about a window the newest observation does not report', () => {
    const old = usage({ asOf: 1000, windows: [win(300, 50, R), win(10080, 20, R)] });
    const newest = usage({ asOf: 2000, windows: [win(10080, 21, R)] });
    expect(mergeObservations([old, newest])?.windows.map((w) => w.minutes)).toEqual([10080]);
  });

  it('compares like with like: a 5-hour reset time never anchors the weekly window', () => {
    const newest = usage({ asOf: 2000, windows: [win(300, 10, R + 2 * H), win(10080, 50, R)] });
    const older = usage({ asOf: 1000, windows: [win(10080, 70, R)] });
    const merged = mergeObservations([older, newest]);
    expect(merged?.windows.map((w) => w.minutes)).toEqual([300, 10080]);
    expect(merged?.windows[1]).toEqual(win(10080, 70, R));
  });

  it('only compares DIFFERENT windows inside the horizon (another account\'s numbers must not stick)', () => {
    const otherAccount = usage({ asOf: 1000, windows: [win(10080, 80, R + 999_999_999)] });
    const now = usage({ asOf: 1000 + MERGE_HORIZON_MS + 1, windows: [win(10080, 5, R)] });
    expect(mergeObservations([otherAccount, now])?.windows[0].usedPercent).toBe(5);
    const withinHorizon = usage({ asOf: 1000 + MERGE_HORIZON_MS, windows: [win(10080, 5, R)] });
    expect(mergeObservations([otherAccount, withinHorizon])?.windows[0].usedPercent).toBe(80);
  });

  it('never lets a stale re-render after a long quiet gap undercut a reading of the SAME window', () => {
    // Usage only grows within one window, so there is no horizon on percent: overnight, a session that
    // merely re-rendered its status line (30%, stamped now) must not beat the 35% seen last night.
    const lastNight = usage({ asOf: 1000, windows: [win(10080, 35, R)] });
    const staleRerender = usage({ asOf: 1000 + MERGE_HORIZON_MS + H, windows: [win(10080, 30, R)] });
    const merged = mergeObservations([lastNight, staleRerender]);
    expect(merged?.windows[0].usedPercent).toBe(35);
    expect(merged?.asOf).toBe(1000 + MERGE_HORIZON_MS + H);
  });

  it('treats an unknown reset time as older than a known one', () => {
    const known = usage({ asOf: 1000, windows: [win(300, 40, R)] });
    const unknown = usage({ asOf: 2000, windows: [win(300, 10, null)] });
    expect(mergeObservations([known, unknown])?.windows[0]).toEqual(win(300, 40, R));
  });

  it('never mixes CLIs: the newest observation decides which one is merged', () => {
    const merged = mergeObservations([
      usage({ cli: 'codex', asOf: 9000, windows: [win(300, 5, R)] }),
      usage({ cli: 'claude', asOf: 1000, windows: [win(300, 99, R)] }),
    ]);
    expect(merged?.cli).toBe('codex');
    expect(merged?.windows).toEqual([win(300, 5, R)]);
  });

  it('does not touch its inputs', () => {
    const a = Object.freeze(usage({ asOf: 1000, windows: Object.freeze([Object.freeze(win(300, 45, R))]) as never }));
    const b = Object.freeze(usage({ asOf: 5000, windows: Object.freeze([Object.freeze(win(300, 40, R))]) as never }));
    const known = Object.freeze(usage({ asOf: 9000, windows: Object.freeze([Object.freeze(win(300, 50, R))]) as never }));
    expect(() => mergeObservations([a, b], known)).not.toThrow();
  });

  describe('a window whose reset time jitters by a second (real Codex data: 992 changes in 7,092 readings)', () => {
    const rising = (cli: 'claude' | 'codex') => [
      usage({ cli, asOf: 1000, windows: [win(10080, 28, R + 1000)] }),
      usage({ cli, asOf: 2000, windows: [win(10080, 31, R)] }),
      usage({ cli, asOf: 3000, windows: [win(10080, 34, R + 1000)] }),
      usage({ cli, asOf: 4000, windows: [win(10080, 37, R)] }),
    ];

    it('is one window: the rising percent wins, not whichever reading reported the later second', () => {
      const merged = mergeObservations(rising('claude'));
      expect(merged?.windows[0].usedPercent).toBe(37);
      expect(merged?.windows[0].resetsAt).toBe(R); // that of the reading the percent came from
    });

    it('is one window for Codex too', () => {
      expect(mergeObservations(rising('codex'))?.windows[0].usedPercent).toBe(37);
    });

    it('at equal usage reports the later reset time', () => {
      const merged = mergeObservations([
        usage({ asOf: 1000, windows: [win(300, 40, R)] }),
        usage({ asOf: 2000, windows: [win(300, 40, R + 1000)] }),
        usage({ asOf: 3000, windows: [win(300, 40, R + 500)] }),
      ]);
      expect(merged?.windows[0].resetsAt).toBe(R + 1000);
    });

    it('is a rollover only beyond the tolerance, exactly', () => {
      const at = (delta: number) => mergeObservations([
        usage({ asOf: 1000, windows: [win(300, 80, R)] }),
        usage({ asOf: 2000, windows: [win(300, 5, R + delta)] }),
      ])?.windows[0].usedPercent;
      expect(at(SAME_WINDOW_TOLERANCE_MS)).toBe(80); // still the same window: usage cannot have fallen
      expect(at(SAME_WINDOW_TOLERANCE_MS + 1)).toBe(5); // a new window
    });
  });

  describe('known: the previous merged value', () => {
    it('can only RAISE the percent of the same window', () => {
      const known = usage({ asOf: 9000, windows: [win(300, 40, R)] });
      const reading = usage({ asOf: 1000, windows: [win(300, 30, R + 1000)] });
      const merged = mergeObservations([reading], known);
      expect(merged?.windows[0].usedPercent).toBe(40);
      expect(merged?.asOf).toBe(1000); // it does not decide the time
    });

    it('never lowers: a known value below the reading changes nothing', () => {
      const known = usage({ asOf: 9000, windows: [win(300, 10, R)] });
      expect(mergeObservations([usage({ asOf: 1000, windows: [win(300, 30, R)] })], known)?.windows[0].usedPercent).toBe(30);
    });

    it('is ignored once the window has rolled over — which is how another login\'s numbers expire by themselves', () => {
      const known = usage({ asOf: 9000, windows: [win(300, 90, R)] });
      const reading = usage({ asOf: 1000, windows: [win(300, 3, R + 5 * H)] });
      expect(mergeObservations([reading], known)?.windows[0]).toEqual(win(300, 3, R + 5 * H));
    });

    it('never adds a window the newest observation does not report, nor a plan, nor a flag', () => {
      const known = usage({ asOf: 9000, plan: 'pro', limitReached: true, windows: [win(300, 99, R), win(10080, 99, R)] });
      const merged = mergeObservations([usage({ asOf: 1000, windows: [win(300, 30, R)] })], known);
      expect(merged?.windows).toEqual([win(300, 99, R)]);
      expect(merged).not.toHaveProperty('plan');
      expect(merged).not.toHaveProperty('limitReached'); // its flag is not used, and 99% shown is not "reached"
    });

    it('is not used when it belongs to another CLI', () => {
      const known = usage({ cli: 'codex', asOf: 9000, windows: [win(300, 99, R)] });
      expect(mergeObservations([usage({ asOf: 1000, windows: [win(300, 30, R)] })], known)?.windows[0].usedPercent).toBe(30);
    });
  });

  describe('limitReached comes from what is shown', () => {
    it('Claude: a stale 100% of a window that has since rolled over does not flag the new 2%', () => {
      const rolled = usage({ asOf: 1000, windows: [win(300, 2, R + 5 * H)] });
      const staleRerender = usage({ asOf: 2000, limitReached: true, windows: [win(300, 100, R)] });
      const merged = mergeObservations([rolled, staleRerender]);
      expect(merged?.windows[0].usedPercent).toBe(2);
      expect(merged).not.toHaveProperty('limitReached');
    });

    it('Claude: a 100% reading of the window being shown flags it, though the newest reading carried no flag', () => {
      const full = usage({ asOf: 1000, limitReached: true, windows: [win(300, 100, R)] });
      const newest = usage({ asOf: 2000, windows: [win(300, 60, R)] });
      const merged = mergeObservations([full, newest]);
      expect(merged?.windows[0].usedPercent).toBe(100);
      expect(merged?.limitReached).toBe(true);
    });

    it('Codex: the newest reading decides, in both directions', () => {
      const flagged = usage({ cli: 'codex', asOf: 1000, limitReached: true, windows: [win(300, 100, R)] });
      const clear = usage({ cli: 'codex', asOf: 2000, windows: [win(300, 4, R + 5 * H)] });
      expect(mergeObservations([flagged, clear])).not.toHaveProperty('limitReached');
      expect(mergeObservations([clear, { ...flagged, asOf: 3000 }])?.limitReached).toBe(true);
    });
  });

  describe('Codex: event times are real, so the newest reading wins whole', () => {
    it('takes it as it is — no higher percent from an older reading of the same window', () => {
      const older = usage({ cli: 'codex', asOf: 1000, plan: 'pro', windows: [win(10080, 60, R)] });
      const newer = usage({ cli: 'codex', asOf: 2000, windows: [win(10080, 10, R + 1000)] }); // e.g. an admin reset
      const merged = mergeObservations([older, newer]);
      expect(merged?.windows).toEqual([win(10080, 10, R + 1000)]);
      expect(merged?.plan).toBe('pro'); // the newest peer that names one
      expect(merged?.asOf).toBe(2000);
    });

    it('does not use what was known', () => {
      const known = usage({ cli: 'codex', asOf: 9000, windows: [win(10080, 80, R)] });
      const newer = usage({ cli: 'codex', asOf: 2000, windows: [win(10080, 10, R)] });
      expect(mergeObservations([newer], known)?.windows[0].usedPercent).toBe(10);
    });
  });

  it('carries the plan from the newest observation that names one, and the winner\'s limit flag', () => {
    const merged = mergeObservations([
      usage({ cli: 'codex', asOf: 1000, plan: 'pro' }),
      usage({ cli: 'codex', asOf: 2000, limitReached: true }),
    ]);
    expect(merged?.plan).toBe('pro');
    expect(merged?.limitReached).toBe(true);
  });
});

describe('sameInstance', () => {
  const win = (minutes: number, resetsAt: number | null) => ({ minutes, usedPercent: 1, resetsAt });
  const R = 2_000_000_000_000;

  it('tolerates five minutes — resets_at jitters by a second inside one window and moves by hours at a rollover', () => {
    expect(SAME_WINDOW_TOLERANCE_MS).toBe(5 * 60 * 1000);
    expect(sameInstance(win(300, R), win(300, R + 1000))).toBe(true);
    expect(sameInstance(win(300, R), win(300, R - SAME_WINDOW_TOLERANCE_MS))).toBe(true);
    expect(sameInstance(win(300, R), win(300, R + SAME_WINDOW_TOLERANCE_MS + 1))).toBe(false);
    expect(sameInstance(win(300, R), win(300, R + 5 * 3_600_000))).toBe(false);
  });

  it('never matches windows of different lengths', () => {
    expect(sameInstance(win(300, R), win(10080, R))).toBe(false);
  });

  it('matches two unknown reset times, and an unknown one never matches a known one', () => {
    expect(sameInstance(win(300, null), win(300, null))).toBe(true);
    expect(sameInstance(win(300, null), win(300, R))).toBe(false);
    expect(sameInstance(win(300, R), win(300, null))).toBe(false);
  });
});

describe('sameNumbers', () => {
  it('ignores asOf', () => {
    expect(sameNumbers(usage({ asOf: 1 }), usage({ asOf: 999 }))).toBe(true);
  });
  it('compares whole percent: a tenth of a point is not a change worth announcing', () => {
    const a = usage({ windows: [{ minutes: 300, usedPercent: 62.4, resetsAt: 5 }] });
    const sameRounded = usage({ windows: [{ minutes: 300, usedPercent: 62.2, resetsAt: 5 }] });
    const next = usage({ windows: [{ minutes: 300, usedPercent: 62.6, resetsAt: 5 }] });
    expect(sameNumbers(a, sameRounded)).toBe(true);
    expect(sameNumbers(a, next)).toBe(false);
  });
  it('sees a new reset time (a rollover), a different window set, plan, cli and limit flag', () => {
    const base = usage();
    expect(sameNumbers(base, usage({ windows: [{ ...base.windows[0], resetsAt: base.windows[0].resetsAt! + 3_600_000 }] }))).toBe(false);
    expect(sameNumbers(base, usage({ windows: [...base.windows, { minutes: 10080, usedPercent: 1, resetsAt: 1 }] }))).toBe(false);
    expect(sameNumbers(base, usage({ plan: 'pro' }))).toBe(false);
    expect(sameNumbers(base, usage({ cli: 'codex' }))).toBe(false);
    expect(sameNumbers(base, usage({ limitReached: true }))).toBe(false);
  });
  it('does not count a reset time that jitters by a second as a change — every flip would re-broadcast every session', () => {
    const base = usage();
    const jitter = (delta: number) => usage({ windows: [{ ...base.windows[0], resetsAt: base.windows[0].resetsAt! + delta }] });
    expect(sameNumbers(base, jitter(1000))).toBe(true);
    expect(sameNumbers(base, jitter(-1000))).toBe(true);
    expect(sameNumbers(base, jitter(SAME_WINDOW_TOLERANCE_MS))).toBe(true);
    expect(sameNumbers(base, jitter(SAME_WINDOW_TOLERANCE_MS + 1))).toBe(false);
  });
  it('compares unknown reset times: equal to each other, different from a known one', () => {
    const unknown = (pct = 30) => usage({ windows: [{ minutes: 300, usedPercent: pct, resetsAt: null }] });
    expect(sameNumbers(unknown(), unknown())).toBe(true);
    expect(sameNumbers(unknown(), usage())).toBe(false);
    expect(sameNumbers(usage(), unknown())).toBe(false);
  });
  it('handles nothing', () => {
    expect(sameNumbers(null, null)).toBe(true);
    expect(sameNumbers(undefined, null)).toBe(true);
    expect(sameNumbers(null, usage())).toBe(false);
    expect(sameNumbers(usage(), undefined)).toBe(false);
  });
});

describe('sanitizeObservation', () => {
  const NOW = 1_791_500_000_000;
  const H = 3_600_000;
  const win = (minutes: number, usedPercent: number, resetsAt: number | null) => ({ minutes, usedPercent, resetsAt });
  const obs = (over: Partial<PlanUsage> = {}): PlanUsage => usage({ asOf: NOW - 1000, windows: [win(300, 10, NOW + H)], ...over });

  it('has the bounds the service relies on', () => {
    expect(MAX_FUTURE_SKEW_MS).toBe(5 * 60 * 1000);
    expect(MAX_RESET_AHEAD_MS).toBe(14 * 24 * 3600 * 1000);
  });

  it('keeps a plausible observation as it is — the very same object', () => {
    const o = obs();
    expect(sanitizeObservation(o, NOW)).toBe(o);
  });

  it('drops an observation dated beyond the allowed clock skew (one bad timestamp would win forever), keeps one inside it', () => {
    expect(sanitizeObservation(obs({ asOf: NOW + MAX_FUTURE_SKEW_MS }), NOW)).not.toBeNull();
    expect(sanitizeObservation(obs({ asOf: NOW + MAX_FUTURE_SKEW_MS + 1 }), NOW)).toBeNull();
    expect(sanitizeObservation(obs({ asOf: 9e15 }), NOW)).toBeNull();
  });

  it('drops a window that resets implausibly far ahead and keeps the others', () => {
    const o = obs({ windows: [win(300, 10, NOW + 3 * H), win(10080, 20, NOW + MAX_RESET_AHEAD_MS + 1)] });
    expect(sanitizeObservation(o, NOW)?.windows).toEqual([win(300, 10, NOW + 3 * H)]);
    const edge = obs({ windows: [win(10080, 20, NOW + MAX_RESET_AHEAD_MS)] });
    expect(sanitizeObservation(edge, NOW)?.windows).toHaveLength(1);
  });

  it('drops an observation left with no window', () => {
    expect(sanitizeObservation(obs({ windows: [win(300, 10, NOW + MAX_RESET_AHEAD_MS + H)] }), NOW)).toBeNull();
  });

  it('keeps a window whose reset time is unknown', () => {
    expect(sanitizeObservation(obs({ windows: [win(300, 10, null)] }), NOW)?.windows).toEqual([win(300, 10, null)]);
  });

  it('does not touch its input', () => {
    const frozen = Object.freeze(obs({ windows: Object.freeze([win(300, 10, NOW + H), win(10080, 5, NOW + 99 * 24 * H)]) as never }));
    expect(() => sanitizeObservation(frozen, NOW)).not.toThrow();
    expect(frozen.windows).toHaveLength(2);
  });
});

describe('planCliOf', () => {
  it('trusts an explicit cliSource', () => {
    expect(planCliOf({ cliSource: 'codex', model: 'claude-opus' })).toBe('codex');
    expect(planCliOf({ cliSource: 'Claude' })).toBe('claude');
  });
  it('falls back to the launch command, then the model name', () => {
    expect(planCliOf({ startupCommand: '/opt/homebrew/bin/codex --search' })).toBe('codex');
    expect(planCliOf({ sshCommand: 'claude --resume x' })).toBe('claude');
    expect(planCliOf({ sshConfig: { host: 'h', port: 22, command: 'codex' } })).toBe('codex');
    expect(planCliOf({ model: 'claude-opus-5-5' })).toBe('claude');
    expect(planCliOf({ model: 'gpt-5.6-sol' })).toBe('codex');
  });
  it('is null when nothing says (a plain shell is not a CLI with a plan)', () => {
    expect(planCliOf({})).toBeNull();
    expect(planCliOf({ cliSource: 'gemini', model: '' })).toBeNull();
    expect(planCliOf({ startupCommand: 'zsh', model: 'x' })).toBeNull();
  });
});

describe('planCliOf on hostile or odd input', () => {
  it('never throws: a hook payload is not validated for these fields', () => {
    const odd: unknown[] = [
      { cliSource: 1 }, { cliSource: null }, { cliSource: {} }, { model: {} }, { model: 5 }, { model: null },
      { startupCommand: ['claude'] }, { sshCommand: {} }, { sshConfig: { command: 5 } }, { sshConfig: 7 }, { sshConfig: 'claude' },
      { events: 'x' }, { events: 5 }, { events: [null, { type: 5 }, 'a', {}] }, { events: [{ type: ['PreToolUse'] }] },
    ];
    for (const hints of odd) expect(() => planCliOf(hints as never)).not.toThrow();
  });

  it('ignores a field of the wrong type rather than reading it', () => {
    expect(planCliOf({ cliSource: 1, model: {}, sshConfig: { command: 5 } } as never)).toBeNull();
    expect(planCliOf({ cliSource: 1, model: 'claude-opus-5-5' } as never)).toBe('claude');
    expect(planCliOf({ startupCommand: ['claude'], sshCommand: 'codex' } as never)).toBe('codex');
  });
});

describe('planCliOf stays in step with the client\'s detectCli', () => {
  // The server cannot import src/lib/cliDetect.ts into its own build, so planCliOf is a copy: this
  // table is what stops the two drifting. Every row goes through BOTH and must agree.
  const ev = (...types: string[]) => types.map((type) => ({ type, timestamp: 0, detail: '' }));
  const rows: Array<[string, Record<string, unknown>]> = [
    ['explicit claude', { cliSource: 'claude' }],
    ['explicit codex', { cliSource: 'codex' }],
    ['explicit, mixed case', { cliSource: 'Claude' }],
    ['explicit beats the model', { cliSource: 'codex', model: 'claude-opus-5-5' }],
    ['explicit unknown family falls through to the model', { cliSource: 'gemini', model: 'claude-sonnet' }],
    ['explicit unknown family, nothing else', { cliSource: 'gemini' }],
    ['startup command: claude', { startupCommand: 'claude --model opus' }],
    ['startup command: path to claude', { startupCommand: '/Users/x/.local/bin/claude --resume y' }],
    ['startup command: codex', { startupCommand: 'codex --search' }],
    ['startup command: path to codex', { startupCommand: '/opt/homebrew/bin/codex -m gpt' }],
    ['ssh command', { sshCommand: 'claude' }],
    ['ssh config command', { sshConfig: { host: 'h', port: 22, command: 'codex resume x' } }],
    ['the word claude in the middle of a command line', { startupCommand: 'echo claude' }],
    ['claude-code is not the claude command', { startupCommand: 'claude-code' }],
    ['a command beats the model', { startupCommand: 'codex', model: 'claude-opus-5-5' }],
    ['model: claude', { model: 'claude-opus-5-5' }],
    ['model: opus', { model: 'opus' }],
    ['model: sonnet', { model: 'Sonnet-5' }],
    ['model: haiku', { model: 'haiku-4-5' }],
    ['model: gpt', { model: 'gpt-5.6-sol' }],
    ['model: codex', { model: 'codex-mini' }],
    ['model: o1', { model: 'o1-preview' }],
    ['model: o3', { model: 'o3-mini' }],
    ['model: o4', { model: 'o4-mini' }],
    ['the client\'s loose o1 rule: any model containing it', { model: 'tool1' }],
    ['model: another family', { model: 'gemini-pro' }],
    ['model beats events', { model: 'gpt-5', events: ev('PreToolUse') }],
    ['codex events', { events: ev('agent-turn-complete') }],
    ['an event starting with Codex', { events: ev('CodexSessionStart') }],
    ['claude events: SessionStart', { events: ev('SessionStart') }],
    ['claude events: PreToolUse', { events: ev('TerminalCreated', 'PreToolUse') }],
    ['claude events: PostToolUse', { events: ev('PostToolUse') }],
    ['claude events: UserPromptSubmit', { events: ev('UserPromptSubmit') }],
    ['codex events win over claude events', { events: ev('SessionStart', 'agent-turn-complete') }],
    ['events that say nothing', { events: ev('TerminalCreated', 'SessionDiscovered') }],
    ['no events at all', { events: [] }],
    ['nothing at all', {}],
    ['a plain shell', { startupCommand: 'zsh', model: '' }],
  ];
  it('has enough rows to mean something', () => {
    expect(rows.length).toBeGreaterThanOrEqual(25);
  });
  for (const [name, session] of rows) {
    it(name, () => {
      expect(planCliOf(session as never)).toBe(detectCli(session as never));
    });
  }
});
