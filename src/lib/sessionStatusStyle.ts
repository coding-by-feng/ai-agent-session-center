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

/** The status in words; an unknown status is shown as it is. */
export function statusLabel(status: string): string {
  return STATUS_LEGEND.find((s) => s.status === status)?.label ?? status;
}

/** The status colour; an unknown status gets the dim text colour. */
export function statusColor(status: string): string {
  return STATUS_COLORS[status] ?? 'var(--text-dim)';
}
