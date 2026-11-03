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

/** Should the session's status mark say so? Outranks the proceed reminder and the rail's ✓, which come back after. */
export function showsCompacting(session: { status: string; compacting?: CompactingMark | null }, now = Date.now()): boolean {
  return isCompacting(session, now) && !OUTRANK_COMPACTING.has(session.status);
}

/** The status with only the compaction swapped in, for a mark that shows neither the P nor asleep. */
export function statusOrCompacting(session: { status: string; compacting?: CompactingMark | null }): string {
  return showsCompacting(session) ? COMPACTING : session.status;
}

export function owesProceed(session: { status: string; pendingProceedAt?: number | null }): boolean {
  return !!session.pendingProceedAt && (session.status === 'waiting' || session.status === 'idle');
}

/** The status to draw: `ASLEEP` while asleep, `COMPACTING` while compacting, `PROCEED` while a reply is owed, else the session's own. */
export function displayStatus(session: {
  status: string;
  pendingProceedAt?: number | null;
  asleepAt?: number;
  compacting?: CompactingMark | null;
}): string {
  if (session.asleepAt) return ASLEEP;
  if (showsCompacting(session)) return COMPACTING;
  return owesProceed(session) ? PROCEED : session.status;
}

/** The status in words; an unknown status is shown as it is. */
export function statusLabel(status: string): string {
  if (status === PROCEED) return PROCEED_LABEL;
  if (status === ASLEEP) return ASLEEP_LABEL;
  if (status === COMPACTING) return COMPACTING_LABEL;
  return STATUS_LEGEND.find((s) => s.status === status)?.label ?? status;
}

/** The status colour; an unknown status gets the dim text colour. */
export function statusColor(status: string): string {
  if (status === PROCEED) return PROCEED_COLOR;
  if (status === ASLEEP) return ASLEEP_COLOR;
  if (status === COMPACTING) return STATUS_COLORS.working;
  return STATUS_COLORS[status] ?? 'var(--text-dim)';
}
