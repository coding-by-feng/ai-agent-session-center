// sessionStatusStyle.test.ts — one name and one colour per session status,
// shared by the panel's rail and the LIVE board so a status reads the same on
// both (they list the same sessions side by side in a user's head).
import { describe, it, expect } from 'vitest';
import { BACKGROUND, BACKGROUND_WORK_STALE_MS, COMPACTING, COMPACTING_STALE_MS, LIMIT, PROCEED, isUsageLimited, limitLabel, usageLimitReset, STATUS_COLORS, STATUS_LEGEND, busyMark, displayStatus, owesProceed, showsBackgroundWork, showsCompacting, statusColor, statusLabel, statusOrCompacting } from './sessionStatusStyle';
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

// Nov 3 2026: an idle session compacting its context drew idle's pause bars beside a terminal
// that said "Compacting conversation…".
describe('the "compacting" display status', () => {
  const compacting = { since: Date.now() - 5_000 };

  it('shows over an idle, finished, working or starting status', () => {
    for (const status of ['idle', 'waiting', 'working', 'prompting']) {
      expect(displayStatus({ status, compacting })).toBe(COMPACTING);
      expect(showsCompacting({ status, compacting })).toBe(true);
    }
  });

  it('never hides a status that blocks the session, or the end', () => {
    for (const status of ['approval', 'input', 'ended']) {
      expect(displayStatus({ status, compacting })).toBe(status);
      expect(showsCompacting({ status, compacting })).toBe(false);
    }
  });

  it('outranks the proceed reminder, which comes back when the compaction ends', () => {
    expect(displayStatus({ status: 'idle', pendingProceedAt: 1, compacting })).toBe(COMPACTING);
    expect(displayStatus({ status: 'idle', pendingProceedAt: 1, compacting: null })).toBe(PROCEED);
  });

  it('stays out of the way of a sleeping session', () => {
    expect(displayStatus({ status: 'ended', asleepAt: 1, compacting })).toBe('asleep');
  });

  it('does not outlive a lost end hook', () => {
    const stale = { since: Date.now() - COMPACTING_STALE_MS };
    expect(displayStatus({ status: 'idle', compacting: stale })).toBe('idle');
  });

  it('statusOrCompacting swaps in the compaction and nothing else: no P, no asleep', () => {
    expect(statusOrCompacting({ status: 'idle', compacting })).toBe(COMPACTING);
    expect(statusOrCompacting({ status: 'approval', compacting })).toBe('approval');
    expect(statusOrCompacting({ status: 'idle', compacting: null })).toBe('idle');
  });

  it('reads like work, in its own words, and stays out of the status legend', () => {
    expect(statusLabel(COMPACTING)).toBe('Compacting');
    expect(statusColor(COMPACTING)).toBe(statusColor('working'));
    expect(STATUS_LEGEND.some((e) => e.status === COMPACTING)).toBe(false);
  });
});

// Nov 17 2026: a turn that ended with background shells still running is not finished work.
describe('background shells still running', () => {
  const NOW = 10_000_000_000;
  const stopped = (over: Record<string, unknown> = {}) => ({
    status: 'waiting',
    backgroundTaskCount: 2,
    backgroundTasks: { at: NOW - 26 * 60_000 },
    lastActivityAt: NOW - 26 * 60_000,
    ...over,
  });

  it('shows a finished or idle session as working in the background', () => {
    expect(showsBackgroundWork(stopped(), NOW)).toBe(true);
    expect(showsBackgroundWork(stopped({ status: 'idle' }), NOW)).toBe(true);
    expect(busyMark(stopped(), NOW)).toBe(BACKGROUND);
  });

  it('draws it in the working colour, with words that say why', () => {
    expect(statusColor(BACKGROUND)).toBe(STATUS_COLORS.working);
    expect(statusLabel(BACKGROUND)).toBe('Working in the background');
  });

  it('is the status every mark draws', () => {
    const live = stopped({ backgroundTasks: { at: Date.now() }, lastActivityAt: Date.now() });
    expect(displayStatus(live)).toBe(BACKGROUND);
    expect(statusOrCompacting(live)).toBe(BACKGROUND);
  });

  it.each(['working', 'prompting', 'approval', 'input', 'ended', 'connecting'])('leaves a %s session alone', (status) => {
    expect(showsBackgroundWork(stopped({ status }), NOW)).toBe(false);
    expect(busyMark(stopped({ status }), NOW)).toBeNull();
  });

  it('needs a shell that is still running', () => {
    expect(showsBackgroundWork(stopped({ backgroundTaskCount: 0 }), NOW)).toBe(false);
    expect(showsBackgroundWork(stopped({ backgroundTaskCount: undefined }), NOW)).toBe(false);
  });

  it('gives up on a report older than BACKGROUND_WORK_STALE_MS: a lost Stop must not leave it working for good', () => {
    const at = NOW - BACKGROUND_WORK_STALE_MS;
    expect(showsBackgroundWork(stopped({ backgroundTasks: { at: at + 1 } }), NOW)).toBe(true);
    expect(showsBackgroundWork(stopped({ backgroundTasks: { at } }), NOW)).toBe(false);
    // The queue stops holding after 15 idle minutes; the mark must outlast a long bake.
    expect(BACKGROUND_WORK_STALE_MS).toBeGreaterThan(60 * 60_000);
  });

  it('times the report from the last activity when the list itself was not kept', () => {
    expect(showsBackgroundWork(stopped({ backgroundTasks: null }), NOW)).toBe(true);
    expect(showsBackgroundWork(stopped({ backgroundTasks: null, lastActivityAt: NOW - BACKGROUND_WORK_STALE_MS }), NOW)).toBe(false);
  });

  it('ranks under asleep and a compaction, and over the proceed reminder', () => {
    const live = stopped({ backgroundTasks: { at: Date.now() }, lastActivityAt: Date.now() });
    expect(displayStatus({ ...live, asleepAt: 1 })).toBe('asleep');
    expect(displayStatus({ ...live, compacting: { since: Date.now() } })).toBe(COMPACTING);
    expect(displayStatus({ ...live, pendingProceedAt: 5 })).toBe(BACKGROUND);
    expect(displayStatus({ ...live, backgroundTaskCount: 0, pendingProceedAt: 5 })).toBe(PROCEED);
  });
});

describe('a plan usage limit (Nov 18 2026)', () => {
  const limited = (status: string, line = "You've hit your 5-hour limit · resets 1:30pm (Pacific/Auckland)") => ({
    status,
    interruption: { kind: 'usage_limit', line, detectedAt: 1 },
  });

  it('shows over a working, starting, finished or idle status, and over the busy marks and the P', () => {
    for (const status of ['working', 'prompting', 'waiting', 'idle']) expect(displayStatus(limited(status))).toBe(LIMIT);
    expect(displayStatus({ ...limited('waiting'), compacting: { since: Date.now() }, pendingProceedAt: 5 })).toBe(LIMIT);
  });

  it('never hides an approval, a question, the end or sleep', () => {
    for (const status of ['approval', 'input', 'ended']) expect(displayStatus(limited(status))).toBe(status);
    expect(displayStatus({ ...limited('ended'), asleepAt: 5 })).toBe('asleep');
  });

  it('is only the usage limit: other faults keep the status', () => {
    expect(isUsageLimited({ status: 'waiting', interruption: { kind: 'rate_limit', line: '429', detectedAt: 1 } })).toBe(false);
    expect(displayStatus({ status: 'waiting', interruption: { kind: 'api_error', line: '529', detectedAt: 1 } })).toBe('waiting');
  });

  it('has its own words and the red of a stopped turn, and stays out of the legend', () => {
    expect(statusLabel(LIMIT)).toBe('Limit reached');
    expect(statusColor(LIMIT)).toBe('var(--accent-red)');
    expect(STATUS_LEGEND.some((s) => s.status === LIMIT)).toBe(false);
  });

  it('reads the reset time off the banner, in the words the CLI used', () => {
    expect(usageLimitReset("You've hit your 5-hour limit · resets 1:30pm (Pacific/Auckland)")).toBe('resets 1:30pm');
    expect(usageLimitReset("You've hit your weekly limit · resets Nov 21 at 7pm (Pacific/Auckland)")).toBe('resets Nov 21 at 7pm');
    expect(usageLimitReset("You've hit your usage limit. Visit https://chatgpt.com/settings/usage to purchase more credits or try again in 2 days 3 hours.")).toBe('try again in 2 days 3 hours');
    expect(usageLimitReset('Claude AI usage limit reached|1794920000')).toBeNull();
  });

  it('says the limit and, when it is known, the reset', () => {
    expect(limitLabel(limited('waiting').interruption)).toBe('Limit reached · resets 1:30pm');
    expect(limitLabel({ kind: 'usage_limit', line: 'Claude AI usage limit reached|1', detectedAt: 1 })).toBe('Limit reached');
    expect(limitLabel(null)).toBe('Limit reached');
  });
});
