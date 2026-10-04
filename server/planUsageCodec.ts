/**
 * @module planUsageCodec
 * Pure parsing and merging of plan-limit observations (what `/usage` and
 * `/status` show). No fs, no clock, no imports beyond types — see
 * planUsageSources.ts for where the text comes from and planUsageService.ts for
 * what happens to the result.
 *
 * Everything read here is untrusted input from a file another process wrote, and
 * it ends up in a session object sent to every client: numbers are clamped, the
 * one free-text field (the plan name) is held to a short plain-ASCII shape, and
 * anything that does not parse is dropped rather than guessed at.
 */
import type { PlanCli, PlanUsage, PlanUsageWindow } from '../src/types/session.js';

export const FIVE_HOUR_MINUTES = 300;
export const WEEK_MINUTES = 10_080;

/**
 * When Claude readings are compared to find which window is CURRENT, only those
 * written within this of the newest count (see `mergeObservations`). Wide enough
 * for a busy session and a quiet one to disagree about a window, narrow enough
 * that another login's numbers stop being compared once it goes quiet. It bounds
 * the comparison of DIFFERENT windows only: a reading of the same window never
 * expires, because usage only grows inside one.
 */
export const MERGE_HORIZON_MS = 6 * 60 * 60 * 1000;

/**
 * Two readings belong to the SAME window — one stretch of an account's allowance —
 * when their reset times are this close. `resets_at` is not stable inside a
 * window: Codex's moves by a second back and forth (992 changes in 7,092 real
 * readings, 299 of them backwards), while a rollover moves it by hours or days.
 */
export const SAME_WINDOW_TOLERANCE_MS = 5 * 60 * 1000;

/** An observation dated further ahead of the clock than this is not believed: clock skew, a copied file, a forged one. */
export const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000;
/** No limit window is longer than a week; one that resets further ahead than this is not believed. */
export const MAX_RESET_AHEAD_MS = 14 * 24 * 60 * 60 * 1000;

/** Epoch SECONDS stay below this (year 33658); epoch MILLISECONDS are above it. */
const MS_THRESHOLD = 1e12;
/** Below this a number is not a plausible time (2001-09-09 in seconds). */
const SECONDS_FLOOR = 1e9;

const PLAN_NAME_RE = /^[A-Za-z0-9 _.-]{1,32}$/;

/** Epoch seconds, epoch ms, a numeric string or an ISO date → epoch ms; null otherwise. */
export function toEpochMs(value: unknown): number | null {
  let n: number;
  if (typeof value === 'number') {
    n = value;
  } else if (typeof value === 'string' && value.trim() !== '') {
    n = Number(value);
    if (Number.isNaN(n)) {
      const parsed = Date.parse(value);
      return Number.isFinite(parsed) ? parsed : null;
    }
  } else {
    return null;
  }
  if (!Number.isFinite(n)) return null;
  if (n >= MS_THRESHOLD) return n;
  if (n >= SECONDS_FLOOR) return n * 1000;
  return null;
}

/** A finite number clamped to 0–100 with one decimal; null for anything else (a string percent is not trusted). */
export function toPercent(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  return Math.round(Math.min(100, Math.max(0, value)) * 10) / 10;
}

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Codex — `event_msg` / `token_count` lines in a rollout file
// ---------------------------------------------------------------------------

function codexWindow(raw: unknown): PlanUsageWindow | null {
  if (!isObj(raw)) return null;
  const usedPercent = toPercent(raw.used_percent);
  const minutes = typeof raw.window_minutes === 'number' && Number.isFinite(raw.window_minutes)
    ? Math.round(raw.window_minutes)
    : 0;
  if (usedPercent === null || minutes <= 0) return null;
  return { minutes, usedPercent, resetsAt: toEpochMs(raw.resets_at) };
}

/**
 * One rollout line → plan usage, or null when it is not a `token_count` event
 * that carries limits. `fallbackAsOf` dates a line that has no timestamp of its
 * own (the file's mtime, say); without either the line is unusable.
 */
export function parseCodexLine(line: string, fallbackAsOf?: number): PlanUsage | null {
  // Rollout lines can be very large (tool output): do not parse what cannot match.
  if (!line.includes('token_count')) return null;
  const root = parseJson(line);
  if (!isObj(root) || root.type !== 'event_msg' || !isObj(root.payload)) return null;
  const payload = root.payload;
  if (payload.type !== 'token_count' || !isObj(payload.rate_limits)) return null;
  const limits = payload.rate_limits;
  // A rollout interleaves more than one meter — `codex` is the account's own, others
  // (`codex_bengalfox`, seen on a real install) are separate families with their own
  // resets — and the later reset would win a merge. Only the main meter, or a line that
  // names none, describes the account's allowance.
  if (limits.limit_id != null && limits.limit_id !== 'codex') return null;

  const windows = [limits.primary, limits.secondary]
    .map(codexWindow)
    .filter((w): w is PlanUsageWindow => w !== null);
  if (windows.length === 0) return null;

  const asOf = toEpochMs(root.timestamp) ?? fallbackAsOf ?? null;
  if (asOf === null) return null;

  const plan = typeof limits.plan_type === 'string' && PLAN_NAME_RE.test(limits.plan_type)
    ? limits.plan_type
    : undefined;
  return {
    cli: 'codex',
    windows,
    ...(plan ? { plan } : {}),
    ...(limits.rate_limit_reached_type != null ? { limitReached: true } : {}),
    asOf,
  };
}

/**
 * The newest usable `token_count` in a chunk of rollout text. Scans from the end
 * because the newest event is the one that matters, and tolerates a first line
 * that a tail read cut in half (it simply fails to parse).
 */
export function latestCodexUsage(text: string, fallbackAsOf?: number): PlanUsage | null {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const usage = parseCodexLine(lines[i], fallbackAsOf);
    if (usage) return usage;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Claude — the snapshot hooks/dashboard-statusline.sh writes
// ---------------------------------------------------------------------------

/** `rate_limits` keys Claude Code documents → the window each one measures. */
const CLAUDE_WINDOWS: ReadonlyArray<readonly [string, number]> = [
  ['five_hour', FIVE_HOUR_MINUTES],
  ['seven_day', WEEK_MINUTES],
];

/** `{ session_id, ts, rate_limits }` as one JSON line → plan usage. */
export function parseClaudeSnapshot(raw: string): PlanUsage | null {
  const root = parseJson(raw);
  if (!isObj(root) || !isObj(root.rate_limits)) return null;
  const asOf = toEpochMs(root.ts);
  if (asOf === null) return null;
  const limits = root.rate_limits;

  const windows: PlanUsageWindow[] = [];
  for (const [key, minutes] of CLAUDE_WINDOWS) {
    const w = limits[key];
    if (!isObj(w)) continue;
    const usedPercent = toPercent(w.used_percentage);
    if (usedPercent === null) continue;
    windows.push({ minutes, usedPercent, resetsAt: toEpochMs(w.resets_at) });
  }
  if (windows.length === 0) return null;

  return {
    cli: 'claude',
    windows,
    ...(windows.some((w) => w.usedPercent >= 100) ? { limitReached: true } : {}),
    asOf,
  };
}

// ---------------------------------------------------------------------------
// Merging
// ---------------------------------------------------------------------------

/**
 * Are two readings of the same window instance? Windows of one length whose reset
 * times are within `SAME_WINDOW_TOLERANCE_MS` are; two unknown reset times match each
 * other and never a known one.
 */
export function sameInstance(a: PlanUsageWindow, b: PlanUsageWindow): boolean {
  if (a.minutes !== b.minutes) return false;
  if (a.resetsAt === null || b.resetsAt === null) return a.resetsAt === b.resetsAt;
  return Math.abs(a.resetsAt - b.resetsAt) <= SAME_WINDOW_TOLERANCE_MS;
}

/** The reading with more usage in it; at equal usage, the later reset. Within one window usage only grows. */
const fuller = (candidate: PlanUsageWindow, best: PlanUsageWindow): boolean =>
  candidate.usedPercent > best.usedPercent
  || (candidate.usedPercent === best.usedPercent && (candidate.resetsAt ?? -1) > (best.resetsAt ?? -1));

const newestPlan = (observations: readonly PlanUsage[]): string | undefined =>
  [...observations].sort((a, b) => b.asOf - a.asOf).find((o) => o.plan)?.plan;

/**
 * Codex stamps each reading with the time of the event that carried it, so the
 * newest reading IS the latest truth — nothing to correct, and mixing windows of
 * different readings could only invent a state that never was.
 */
function newestWins(winner: PlanUsage, peers: readonly PlanUsage[]): PlanUsage {
  const plan = winner.plan ?? newestPlan(peers);
  return {
    cli: winner.cli,
    windows: winner.windows.map((w) => ({ ...w })),
    ...(plan ? { plan } : {}),
    ...(winner.limitReached ? { limitReached: true } : {}),
    asOf: winner.asOf,
  };
}

/**
 * Claude's `asOf` is when a session WROTE its snapshot, not when it learned the
 * numbers: a session that merely re-rendered its status line (a mode toggle, say)
 * stamps the numbers of its last reply with a new time. So the newest write decides
 * WHICH windows exist and the time, but each window is worked out by instance:
 *
 *  - the current instance is the one with the latest reset among readings written
 *    within `MERGE_HORIZON_MS` of the newest (so another login's numbers stop being
 *    compared once it goes quiet);
 *  - its percent is the fullest reading of that instance whatever the reading's age —
 *    usage only grows inside one window, so an old reading can only raise it, and
 *    that is what stops a stale re-render after a quiet night from undercutting what
 *    was already known.
 *
 * `known`, the previous merged value, is NOT a reading: it never picks the winner,
 * the time or the windows, and counts only toward the percent of the same instance.
 * A window that has rolled over, or belongs to another login, simply does not match
 * it — which is how those numbers expire by themselves (feeding the merged value
 * back in as an observation stamped it with the newest time every poll, so they never did).
 */
function reconcileByInstance(winner: PlanUsage, peers: readonly PlanUsage[], known: PlanUsage | null | undefined): PlanUsage {
  const recent = peers.filter((o) => o.asOf >= winner.asOf - MERGE_HORIZON_MS);
  const knownWindows = known && known.cli === winner.cli ? known.windows : [];

  const windows = winner.windows.map((w) => {
    let anchor = w;
    for (const o of recent) {
      for (const c of o.windows) {
        if (c.minutes === w.minutes && (c.resetsAt ?? -1) > (anchor.resetsAt ?? -1)) anchor = c;
      }
    }
    let best = anchor;
    const consider = (c: PlanUsageWindow): void => {
      if (sameInstance(c, anchor) && fuller(c, best)) best = c;
    };
    for (const o of peers) for (const c of o.windows) consider(c);
    for (const c of knownWindows) consider(c);
    return { ...best };
  });

  const plan = winner.plan ?? newestPlan(recent);
  return {
    cli: winner.cli,
    windows,
    ...(plan ? { plan } : {}),
    // Derived from what is shown: copying the newest reading's flag put "limit reached" beside a 2% that had rolled over.
    ...(windows.some((w) => w.usedPercent >= 100) ? { limitReached: true } : {}),
    asOf: winner.asOf,
  };
}

/**
 * Combine the observations of ONE CLI into the freshest view of it. The newest
 * decides which CLI that is (others are ignored); how it is combined with the rest
 * depends on whether the CLI's timestamps can be trusted — see `newestWins` and
 * `reconcileByInstance`. Inputs are never modified.
 */
export function mergeObservations(observations: readonly PlanUsage[], known?: PlanUsage | null): PlanUsage | null {
  if (observations.length === 0) return null;
  const winner = observations.reduce((best, o) => (o.asOf >= best.asOf ? o : best));
  const peers = observations.filter((o) => o.cli === winner.cli);
  return winner.cli === 'codex' ? newestWins(winner, peers) : reconcileByInstance(winner, peers, known);
}

/**
 * Drop what cannot be right about the present: an observation dated further ahead
 * of `now` than any clock skew explains (one such value would win every merge
 * forever), and a window that resets further ahead than any limit window lasts. An
 * observation left with no window is dropped. Returns the input itself when nothing
 * had to go; never modifies it.
 */
export function sanitizeObservation(usage: PlanUsage, now: number): PlanUsage | null {
  if (usage.asOf > now + MAX_FUTURE_SKEW_MS) return null;
  const windows = usage.windows.filter((w) => w.resetsAt === null || w.resetsAt <= now + MAX_RESET_AHEAD_MS);
  if (windows.length === 0) return null;
  return windows.length === usage.windows.length ? usage : { ...usage, windows };
}

/**
 * Do two observations say the same thing to a person looking at the chip? The
 * time is ignored, percent is compared whole — the chip rounds it too — and reset
 * times within `SAME_WINDOW_TOLERANCE_MS` are the same: a one-second flip in
 * `resets_at` is not worth a broadcast of every session to every client.
 */
export function sameNumbers(a: PlanUsage | null | undefined, b: PlanUsage | null | undefined): boolean {
  if (!a || !b) return !a && !b;
  if (a.cli !== b.cli || a.plan !== b.plan || !!a.limitReached !== !!b.limitReached) return false;
  if (a.windows.length !== b.windows.length) return false;
  return a.windows.every((w, i) => {
    const o = b.windows[i];
    return sameInstance(w, o) && Math.round(w.usedPercent) === Math.round(o.usedPercent);
  });
}

// ---------------------------------------------------------------------------
// Which CLI is a session?
// ---------------------------------------------------------------------------

/**
 * What `planCliOf` reads. Every field is `unknown` on purpose: the values come from
 * hook payloads and snapshots that nothing validates for these keys, and a hint of
 * the wrong type is ignored, never allowed to throw.
 */
export interface CliHints {
  cliSource?: unknown;
  startupCommand?: unknown;
  sshCommand?: unknown;
  model?: unknown;
  sshConfig?: unknown;
  events?: unknown;
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/**
 * The CLI a session runs, for deciding whose plan limits it carries. A copy of
 * `detectCli` in src/lib/cliDetect.ts — the server build cannot import it — and
 * test/planUsageCodec.test.ts runs a table of sessions through both so the two
 * cannot drift: an explicit `cliSource`, then the launch command, then the model's
 * name (including the client's loose `o1`/`o3`/`o4` rule), then the event types.
 */
export function planCliOf(session: CliHints): PlanCli | null {
  const explicit = text(session.cliSource).toLowerCase();
  if (explicit === 'claude' || explicit === 'codex') return explicit;

  const sshConfig = isObj(session.sshConfig) ? session.sshConfig : undefined;
  const command = [session.startupCommand, session.sshCommand, sshConfig?.command]
    .map(text)
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  if (/(^|\s|\/)claude(\s|$)/.test(command)) return 'claude';
  if (/(^|\s|\/)codex(\s|$)/.test(command)) return 'codex';

  const model = text(session.model).toLowerCase();
  if (model.includes('claude') || model.includes('opus') || model.includes('sonnet') || model.includes('haiku')) {
    return 'claude';
  }
  if (model.includes('gpt') || model.includes('codex') || model.includes('o1') || model.includes('o3') || model.includes('o4')) {
    return 'codex';
  }

  const types = Array.isArray(session.events)
    ? session.events.map((e: unknown) => (isObj(e) ? e.type : undefined)).filter((t): t is string => typeof t === 'string')
    : [];
  if (types.some((t) => t === 'agent-turn-complete' || t.startsWith('Codex'))) return 'codex';
  if (types.some((t) => t === 'SessionStart' || t === 'PreToolUse' || t === 'PostToolUse' || t === 'UserPromptSubmit')) {
    return 'claude';
  }
  return null;
}
