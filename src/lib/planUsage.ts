/**
 * @module planUsage
 * What the session header's plan-usage chip says, worked out from a
 * `PlanUsage` and the clock. Nothing here touches React or the DOM; `now` is
 * always passed in, so every rule can be pinned by a test.
 *
 * Three rules shape the output, and each exists because the obvious thing is
 * wrong:
 * - A window whose `resetsAt` has passed is DROPPED, not shown. The stored
 *   percentage belongs to the window that ended; the new one starts near zero.
 * - Severity is judged on the number the user reads (the rounded percentage),
 *   so a chip that says "85%" is never drawn as a mere warning.
 * - A report older than ten minutes is STALE: it is still shown (the last known
 *   figure beats a blank) but marked, and its age is stated.
 *
 * Dependency-free (type imports only), like sessionSort / recentSessions.
 */
import type { PlanCli, PlanUsage, PlanUsageWindow } from '@/types/session';

/** A report older than this is shown as "as of …". */
export const STALE_AFTER_MS = 10 * 60_000;
/** From this (rounded) percentage the chip is a warning. */
export const WARN_AT_PERCENT = 60;
/** From this (rounded) percentage it is an alert, with a glyph as well as a colour. */
export const HIGH_AT_PERCENT = 85;
/** A reset this far away (or further) is a date, not a countdown. */
const COUNTDOWN_LIMIT_MS = 48 * 60 * 60_000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

export type PlanUsageSeverity = 'ok' | 'warn' | 'high';

/** Locale and zone for date text. Left unset in the app (the user's own); set by tests. */
export interface TimeFormatOptions {
  locale?: string;
  timeZone?: string;
}

/** One window, ready to draw. */
export interface PlanUsageRow {
  minutes: number;
  /** "5h" / "wk" */
  label: string;
  /** "5-hour" / "weekly" */
  name: string;
  /** Clamped to 0–100. */
  usedPercent: number;
  percentText: string;
  severity: PlanUsageSeverity;
  resetsAt: number | null;
  /** When it resets: "14:20", "Mon 09:00" or "Oct 12". Null when the CLI did not say. */
  resetAtText: string | null;
  /** How long until then: "1h 12m", or a short date from 48 h out. Null when unknown. */
  resetInText: string | null;
  /** `resetInText` is a countdown (false: a date, or nothing) — the tooltip prints a countdown beside the time, never a date twice. */
  resetIsCountdown: boolean;
}

export interface PlanUsageView {
  cli: PlanCli;
  /** "Claude Code" / "Codex" */
  cliName: string;
  /** `ready` has numbers; `empty` has never reported; `expired` only has windows that have since reset. */
  state: 'ready' | 'empty' | 'expired';
  /** The window the chip shows: the most-used one still running. */
  headline: PlanUsageRow | null;
  /** Every running window, shortest first. */
  rows: PlanUsageRow[];
  /** The headline's severity (always `high` when the CLI says a limit was hit); `ok` with no headline. */
  severity: PlanUsageSeverity;
  stale: boolean;
  limitReached: boolean;
  plan: string | null;
  /** When the figures were reported, as text. Null with no report. */
  asOf: string | null;
  /** The tooltip's first line. */
  tooltipTitle: string;
  /** Why there is no number; null when there is one. */
  reason: string | null;
  /** One full sentence for a screen reader. */
  ariaLabel: string;
}

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

const validMinutes = (m: number): boolean => Number.isFinite(m) && m > 0;

/** "5h", "wk", otherwise the length in minutes, hours or days. */
export function windowLabel(minutes: number): string {
  if (!validMinutes(minutes)) return '?';
  if (minutes === 300) return '5h';
  if (minutes === 10080) return 'wk';
  if (minutes < 60) return `${Math.round(minutes)}m`;
  if (minutes < 1440) return `${Math.round(minutes / 60)}h`;
  return `${Math.round(minutes / 1440)}d`;
}

/** "5-hour", "weekly", otherwise the same as the label. */
export function windowName(minutes: number): string {
  if (!validMinutes(minutes)) return '?';
  if (minutes === 300) return '5-hour';
  if (minutes === 10080) return 'weekly';
  return windowLabel(minutes);
}

const clampPercent = (percent: number): number =>
  Number.isFinite(percent) ? Math.min(100, Math.max(0, percent)) : 0;

/** "63%", or "<1%" for a sliver — a 0% there would say the account is untouched. */
export function formatPercent(percent: number): string {
  const p = clampPercent(percent);
  if (p > 0 && p < 1) return '<1%';
  return `${Math.round(p)}%`;
}

/** ok / warn / high, judged on the rounded percentage the chip prints. */
export function severityFor(percent: number, limitReached = false): PlanUsageSeverity {
  if (limitReached) return 'high';
  const shown = Math.round(clampPercent(percent));
  if (shown >= HIGH_AT_PERCENT) return 'high';
  if (shown >= WARN_AT_PERCENT) return 'warn';
  return 'ok';
}

/**
 * The windows still running at `now`, shortest first. A window with no reset
 * time is kept (nothing says it ended); one that cannot give a percentage is not.
 */
export function activeWindows(usage: PlanUsage, now: number): PlanUsageWindow[] {
  return usage.windows
    .filter((w) => Number.isFinite(w.usedPercent) && (w.resetsAt == null || w.resetsAt > now))
    .slice()
    .sort((a, b) => a.minutes - b.minutes);
}

/** The most-used window; a tie goes to the shorter one, which runs out first. */
export function pickWindow(windows: readonly PlanUsageWindow[]): PlanUsageWindow | null {
  let best: PlanUsageWindow | null = null;
  for (const w of windows) {
    if (
      best === null
      || w.usedPercent > best.usedPercent
      || (w.usedPercent === best.usedPercent && w.minutes < best.minutes)
    ) {
      best = w;
    }
  }
  return best;
}

export function isStale(usage: PlanUsage, now: number): boolean {
  return now - usage.asOf > STALE_AFTER_MS;
}

// ---------------------------------------------------------------------------
// Time text
// ---------------------------------------------------------------------------

const dayKey = (ts: number, timeZone: string | undefined): string =>
  new Intl.DateTimeFormat('en-CA', { year: 'numeric', month: '2-digit', day: '2-digit', timeZone }).format(ts);

const sameDay = (a: number, b: number, timeZone: string | undefined): boolean =>
  dayKey(a, timeZone) === dayKey(b, timeZone);

const clock = (ts: number, { locale, timeZone }: TimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale, { hour: '2-digit', minute: '2-digit', timeZone }).format(ts);

const shortDate = (ts: number, { locale, timeZone }: TimeFormatOptions): string =>
  new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone }).format(ts);

/** Whole minutes until `resetsAt`, floored; never negative. */
const minutesUntil = (resetsAt: number, now: number): number => Math.max(0, Math.floor((resetsAt - now) / 60_000));

/** "<1m", "59m", "1h 12m", "2h"; from 48 h out a short date. */
export function formatResetIn(resetsAt: number, now: number, opts: TimeFormatOptions = {}): string {
  if (resetsAt - now >= COUNTDOWN_LIMIT_MS) return shortDate(resetsAt, opts);
  const total = minutesUntil(resetsAt, now);
  if (total < 1) return '<1m';
  if (total < 60) return `${total}m`;
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

/** When a window resets: the time today, weekday + time within a week, else a date. */
export function formatResetAt(ts: number, now: number, opts: TimeFormatOptions = {}): string {
  const { locale, timeZone } = opts;
  if (sameDay(ts, now, timeZone)) return clock(ts, opts);
  if (ts > now && ts - now < WEEK_MS) {
    return new Intl.DateTimeFormat(locale, { weekday: 'short', hour: '2-digit', minute: '2-digit', timeZone }).format(ts);
  }
  return shortDate(ts, opts);
}

/** When figures were reported: the time today, otherwise the date and time. */
export function formatAsOf(ts: number, now: number, opts: TimeFormatOptions = {}): string {
  if (sameDay(ts, now, opts.timeZone)) return clock(ts, opts);
  return `${shortDate(ts, opts)} ${clock(ts, opts)}`;
}

const plural = (n: number, unit: string): string => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "in 1 hour 12 minutes", "in less than a minute", or "on Oct 12" from 48 h out. */
function resetPhrase(resetsAt: number, now: number, opts: TimeFormatOptions): string {
  if (resetsAt - now >= COUNTDOWN_LIMIT_MS) return `on ${shortDate(resetsAt, opts)}`;
  const total = minutesUntil(resetsAt, now);
  if (total < 1) return 'in less than a minute';
  const hours = Math.floor(total / 60);
  const minutes = total % 60;
  const parts = [hours > 0 ? plural(hours, 'hour') : '', minutes > 0 ? plural(minutes, 'minute') : ''].filter(Boolean);
  return `in ${parts.join(' ')}`;
}

// ---------------------------------------------------------------------------
// The view
// ---------------------------------------------------------------------------

const CLI_NAME: Record<PlanCli, string> = { claude: 'Claude Code', codex: 'Codex' };
const CLI_SHORT: Record<PlanCli, string> = { claude: 'Claude', codex: 'Codex' };

const EMPTY_REASON: Record<PlanCli, string> = {
  claude: 'Plan usage is read from Claude sessions started in this dashboard — none has reported yet.',
  codex: 'Plan usage appears once Codex has made a request.',
};
const EXPIRED_REASON = 'The usage window has reset since the last report.';

function toRow(w: PlanUsageWindow, now: number, opts: TimeFormatOptions): PlanUsageRow {
  const usedPercent = clampPercent(w.usedPercent);
  return {
    minutes: w.minutes,
    label: windowLabel(w.minutes),
    name: windowName(w.minutes),
    usedPercent,
    percentText: formatPercent(usedPercent),
    severity: severityFor(usedPercent),
    resetsAt: w.resetsAt,
    resetAtText: w.resetsAt == null ? null : formatResetAt(w.resetsAt, now, opts),
    resetInText: w.resetsAt == null ? null : formatResetIn(w.resetsAt, now, opts),
    resetIsCountdown: w.resetsAt != null && w.resetsAt - now < COUNTDOWN_LIMIT_MS,
  };
}

function spokenPercent(percentText: string): string {
  return percentText === '<1%' ? 'under 1%' : percentText;
}

/** Everything the chip and its tooltip print, for `cli`, from the latest report (if any). */
export function describePlanUsage(
  cli: PlanCli,
  usage: PlanUsage | null | undefined,
  now: number,
  opts: TimeFormatOptions = {},
): PlanUsageView {
  const cliName = CLI_NAME[cli];
  const plan = usage?.plan ?? null;
  const tooltipTitle = `${cliName} · ${plan ?? 'plan usage'}`;
  const base = {
    cli,
    cliName,
    plan,
    tooltipTitle,
    limitReached: usage?.limitReached === true,
    stale: usage ? isStale(usage, now) : false,
    asOf: usage ? formatAsOf(usage.asOf, now, opts) : null,
  };

  const live = usage ? activeWindows(usage, now) : [];
  const picked = pickWindow(live);

  if (!usage || !picked) {
    // Windows that are all in the past are a different story from none at all:
    // the CLI did report, and the numbers have since gone out of date.
    const hadWindows = !!usage && usage.windows.some((w) => Number.isFinite(w.usedPercent));
    const state = hadWindows ? 'expired' : 'empty';
    const reason = state === 'expired' ? EXPIRED_REASON : EMPTY_REASON[cli];
    return {
      ...base,
      state,
      headline: null,
      rows: [],
      severity: 'ok',
      reason,
      ariaLabel: `${CLI_SHORT[cli]} plan usage unavailable: ${reason}`,
    };
  }

  const rows = live.map((w) => toRow(w, now, opts));
  const headline = rows.find((r) => r.minutes === picked.minutes && r.usedPercent === clampPercent(picked.usedPercent)) ?? rows[0];
  const severity = severityFor(headline.usedPercent, base.limitReached);

  const parts = [
    `${CLI_SHORT[cli]} plan usage: ${spokenPercent(headline.percentText)} of the ${headline.name} limit used`,
  ];
  if (headline.resetsAt != null) parts.push(`resets ${resetPhrase(headline.resetsAt, now, opts)}`);
  if (base.limitReached) parts.push('limit reached');
  if (base.stale && base.asOf) parts.push(`as of ${base.asOf}`);

  return {
    ...base,
    state: 'ready',
    headline,
    rows,
    severity,
    reason: null,
    ariaLabel: parts.join(', '),
  };
}
