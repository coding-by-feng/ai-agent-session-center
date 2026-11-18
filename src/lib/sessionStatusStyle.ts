/**
 * @module sessionStatusStyle
 * One colour and one name per session status, shared by the session panel's
 * rail (SessionSwitcher) and the LIVE board, so a status reads the same on
 * both. Import-free; the colours are theme variables, so they follow the
 * active theme (`body[data-theme]`).
 */

export const STATUS_COLORS: Readonly<Record<string, string>> = {
  idle: 'var(--accent-green)',
  prompting: 'var(--accent-cyan)',
  working: 'var(--accent-orange)',
  waiting: 'var(--accent-cyan)',
  approval: 'var(--accent-yellow)',
  input: 'var(--accent-purple)',
  ended: 'var(--accent-red)',
  connecting: 'var(--text-dim)',
};

/** Ordered status → human label. Order follows STATUS_ORDER (lib/sessionSort.ts). */
export const STATUS_LEGEND: ReadonlyArray<{ status: string; label: string }> = [
  { status: 'working', label: 'Working' },
  { status: 'prompting', label: 'Prompting' },
  { status: 'approval', label: 'Approval needed' },
  { status: 'input', label: 'Waiting for input' },
  { status: 'waiting', label: 'Waiting' },
  { status: 'idle', label: 'Idle' },
  { status: 'connecting', label: 'Connecting' },
  { status: 'ended', label: 'Disconnected' },
];

/**
 * "Asks you to proceed" (Oct 23 2026): a finished session whose last answer asks the user to
 * reply "proceed" (`Session.pendingProceedAt`, server/proceedRequest.ts). Not a status, so it is
 * not in the legend or the sort: the rail, the LIVE board and the phone's rows show it in place of
 * a finished or idle status, so the session reads as owing a review instead of one more idle
 * card. Anything that blocks the session (approval, a question) or means it is busy or gone wins.
 */
export const PROCEED = 'proceed';
const PROCEED_LABEL = 'Asks you to proceed';
const PROCEED_COLOR = 'var(--accent-yellow)';

/**
 * "Asleep" (Oct 28 2026): AASC stopped this idle session's CLI to free memory (`Session.asleepAt`,
 * server/sessionSleep.ts). Its status is `ended`, but it is resting, not gone: opening it resumes it.
 */
export const ASLEEP = 'asleep';
const ASLEEP_LABEL = 'Asleep';
const ASLEEP_COLOR = 'var(--text-dim)';

/**
 * "Compacting" (Nov 3 2026): the CLI is compacting its context (`Session.compacting`,
 * server/compactingState.ts). Display only: the status itself stays, because an idle compaction
 * is still idle to the queue. It reads like work, in the working colour and with the working glyph.
 */
export const COMPACTING = 'compacting';
const COMPACTING_LABEL = 'Compacting';
/** `Session.compacting`, spelled out because this module stays import-free. */
interface CompactingMark { since: number; trigger?: string | null }
/** A compaction never shows over these: a blocked session still needs you, an ended one is gone. */
export const OUTRANK_COMPACTING: ReadonlySet<string> = new Set(['approval', 'input', 'ended']);
/** How long a compaction may show without its end hook: a lost hook must not leave it up for good. */
export const COMPACTING_STALE_MS = 10 * 60_000;

/** Is the session compacting its context right now (PreCompact seen, no end yet, not stale)? */
export function isCompacting(session: { compacting?: CompactingMark | null }, now = Date.now()): boolean {
  const c = session.compacting;
  return !!c && now - c.since < COMPACTING_STALE_MS;
}

/**
 * "Finishing up" (Nov 6 2026): the turn's answer is in, but Claude is still running its Stop
 * hooks (`Session.stopHooksSince`, server/stopHooksState.ts), and a prompt sent now waits
 * unseen until they finish. Display only, like a compaction; shown on a finished turn only.
 */
export const FINISHING_UP_LABEL = 'Finishing up';
/** How long it may show without the server seeing the hooks end (the slowest seen took 124 s). */
export const STOP_HOOKS_STALE_MS = 3 * 60_000;

/** Is Claude still running this finished turn's Stop hooks (and not for implausibly long)? */
export function isFinishingUp(session: { status: string; stopHooksSince?: number | null }, now = Date.now()): boolean {
  const since = session.stopHooksSince;
  return !!since && session.status === 'waiting' && now - since < STOP_HOOKS_STALE_MS;
}

/**
 * "Working in the background" (Nov 17 2026): the turn ended, but Claude still has background shells
 * or monitors running (`Session.backgroundTaskCount`, set from each Stop's background list). A card
 * with the finished ✓ while a 26-minute bake runs reads as done when it is not. Display only, like a
 * compaction: the status stays `waiting`/`idle`, and the queue's own hold (`queueHoldReason`) is
 * what keeps prompts back. Drawn as work: the working colour and glyph.
 */
export const BACKGROUND = 'background';
const BACKGROUND_LABEL = 'Working in the background';
/**
 * How old the report may be. The count changes only at a Stop: a shell that ends wakes Claude,
 * whose next Stop lists it finished. If that Stop is lost, the mark must not stay for good. Much
 * longer than the queue's 15-minute hold, because the shells this is for run for an hour.
 */
export const BACKGROUND_WORK_STALE_MS = 2 * 60 * 60_000;
/**
 * "Limit reached" (Nov 18 2026): the turn stopped on the plan's usage limit (`Session.interruption` of
 * kind `usage_limit`, server/interruptionDetector.ts), and nothing will run until its reset. Shown over
 * working, finished and idle (a limited turn can be left "working" with no Stop), over the busy marks and
 * the P; never over what still needs you (an approval, a question), the end, or sleep.
 */
export const LIMIT = 'limit';
const LIMIT_LABEL = 'Limit reached';
const LIMIT_COLOR = 'var(--accent-red)';
/** `Session.interruption`, spelled out because this module stays import-free. */
interface InterruptionMark { kind: string; line: string; detectedAt: number }
const LIMIT_NEVER_OVER: ReadonlySet<string> = new Set(['approval', 'input', 'ended']);

export function isUsageLimited(session: { status: string; interruption?: InterruptionMark | null }): boolean {
  return session.interruption?.kind === 'usage_limit' && !LIMIT_NEVER_OVER.has(session.status);
}

/**
 * When the limit lifts, in the CLI's own words (it already wrote them in the user's time zone):
 * Claude "resets 1:30pm" / "resets Nov 21 at 7pm", Codex "try again in 2 days 3 hours"; null when unsaid.
 */
export function usageLimitReset(line: string): string | null {
  const claude = /\bresets ([^(·|\n]+?)\s*(?:\(|·|$)/i.exec(line);
  if (claude) return `resets ${claude[1].trim()}`;
  const codex = /\btry again ((?:in|at) [^.\n]+)/i.exec(line);
  return codex ? `try again ${codex[1].trim()}` : null;
}

/** "Limit reached · resets 1:30pm", or just "Limit reached" when the banner gave no time. */
export function limitLabel(interruption: InterruptionMark | null | undefined): string {
  const reset = interruption ? usageLimitReset(interruption.line) : null;
  return reset ? `${LIMIT_LABEL} · ${reset}` : LIMIT_LABEL;
}

/** The fields the rule reads, spelled out because this module stays import-free. */
interface BackgroundWorkFields {
  status: string;
  backgroundTaskCount?: number;
  /** `Session.backgroundTasks`: `at` is when the Stop that listed the shells arrived. */
  backgroundTasks?: { at: number } | null;
  lastActivityAt?: number;
}

/** Did this finished or idle session's last Stop report background shells still running, recently enough to trust? */
export function showsBackgroundWork(session: BackgroundWorkFields, now = Date.now()): boolean {
  if (session.status !== 'waiting' && session.status !== 'idle') return false;
  if ((session.backgroundTaskCount ?? 0) <= 0) return false;
  const reportedAt = session.backgroundTasks?.at ?? session.lastActivityAt ?? 0;
  return now - reportedAt < BACKGROUND_WORK_STALE_MS;
}

/**
 * The display status of a session that is busy whatever its status says: `COMPACTING`, or
 * `BACKGROUND` while its shells run; null when its own status stands. Outranks the proceed
 * reminder and the rail's ✓, which come back after.
 */
export function busyMark(
  session: BackgroundWorkFields & { compacting?: CompactingMark | null },
  now = Date.now(),
): typeof COMPACTING | typeof BACKGROUND | null {
  if (showsCompacting(session, now)) return COMPACTING;
  return showsBackgroundWork(session, now) ? BACKGROUND : null;
}

/** Should the session's status mark say so? Outranks the proceed reminder and the rail's ✓, which come back after. */
export function showsCompacting(session: { status: string; compacting?: CompactingMark | null }, now = Date.now()): boolean {
  return isCompacting(session, now) && !OUTRANK_COMPACTING.has(session.status);
}

/** The status with only the busy marks swapped in (a compaction, background shells), for a mark that shows neither the P nor asleep. */
export function statusOrCompacting(session: BackgroundWorkFields & { compacting?: CompactingMark | null }): string {
  return busyMark(session) ?? session.status;
}

export function owesProceed(session: { status: string; pendingProceedAt?: number | null }): boolean {
  return !!session.pendingProceedAt && (session.status === 'waiting' || session.status === 'idle');
}

/**
 * The status to draw: `ASLEEP` while asleep, `LIMIT` while stopped on the usage limit, `COMPACTING`
 * while compacting, `BACKGROUND` while its shells still run, `PROCEED` while a reply is owed, else the
 * session's own.
 */
export function displayStatus(session: BackgroundWorkFields & {
  pendingProceedAt?: number | null;
  asleepAt?: number;
  compacting?: CompactingMark | null;
  interruption?: InterruptionMark | null;
}): string {
  if (session.asleepAt) return ASLEEP;
  if (isUsageLimited(session)) return LIMIT;
  return busyMark(session) ?? (owesProceed(session) ? PROCEED : session.status);
}

/** The status in words; an unknown status is shown as it is. */
export function statusLabel(status: string): string {
  if (status === PROCEED) return PROCEED_LABEL;
  if (status === ASLEEP) return ASLEEP_LABEL;
  if (status === LIMIT) return LIMIT_LABEL;
  if (status === COMPACTING) return COMPACTING_LABEL;
  if (status === BACKGROUND) return BACKGROUND_LABEL;
  return STATUS_LEGEND.find((s) => s.status === status)?.label ?? status;
}

/** The status colour; an unknown status gets the dim text colour. */
export function statusColor(status: string): string {
  if (status === PROCEED) return PROCEED_COLOR;
  if (status === ASLEEP) return ASLEEP_COLOR;
  if (status === LIMIT) return LIMIT_COLOR;
  if (status === COMPACTING || status === BACKGROUND) return STATUS_COLORS.working;
  return STATUS_COLORS[status] ?? 'var(--text-dim)';
}
