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

export function owesProceed(session: { status: string; pendingProceedAt?: number | null }): boolean {
  return !!session.pendingProceedAt && (session.status === 'waiting' || session.status === 'idle');
}

/** The status to draw: `ASLEEP` while asleep, `PROCEED` while a reply is owed, else the session's own. */
export function displayStatus(session: { status: string; pendingProceedAt?: number | null; asleepAt?: number }): string {
  if (session.asleepAt) return ASLEEP;
  return owesProceed(session) ? PROCEED : session.status;
}

/** The status in words; an unknown status is shown as it is. */
export function statusLabel(status: string): string {
  if (status === PROCEED) return PROCEED_LABEL;
  if (status === ASLEEP) return ASLEEP_LABEL;
  return STATUS_LEGEND.find((s) => s.status === status)?.label ?? status;
}

/** The status colour; an unknown status gets the dim text colour. */
export function statusColor(status: string): string {
  if (status === PROCEED) return PROCEED_COLOR;
  if (status === ASLEEP) return ASLEEP_COLOR;
  return STATUS_COLORS[status] ?? 'var(--text-dim)';
}
