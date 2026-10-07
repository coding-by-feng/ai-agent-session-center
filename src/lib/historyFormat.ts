/**
 * Formatting for the HISTORY tab's rows and detail dialog: names, plurals,
 * durations, dates and the status chip. Pure; `now` is passed in (the query's
 * `dataUpdatedAt`) so render never reads the clock. REVIEW reuses `formatDate`,
 * so the two tabs print a date the same way.
 */
import type { ChipTone } from '@/components/ui/Chip';
import { statusLabel } from '@/lib/sessionStatusStyle';
import type { DbSessionRow } from '@/types';

/**
 * Chip tone per status, by meaning. The hues follow STATUS_COLORS
 * (lib/sessionStatusStyle.ts), so a status reads the same here as on LIVE —
 * except `ended`: in a history a finished session is the normal case, not an
 * error, so it is neutral rather than red.
 */
const STATUS_TONE: Readonly<Record<string, ChipTone>> = {
  idle: 'success',
  working: 'warning',
  prompting: 'info',
  waiting: 'info',
  approval: 'warning',
  input: 'accent',
};

export function statusChip(session: DbSessionRow): { label: string; tone: ChipTone; title?: string } {
  const ended = session.status === 'ended';
  const archived = Boolean(session.archived);
  return {
    // statusLabel() calls `ended` "Disconnected" (a live terminal that went
    // away); the Status filter calls it "Ended", and so does this.
    label: (ended ? 'Ended' : statusLabel(session.status)) || 'Unknown',
    tone: ended || archived ? 'neutral' : (STATUS_TONE[session.status] ?? 'neutral'),
    title: archived ? 'Archived' : undefined,
  };
}

export function sessionName(session: Pick<DbSessionRow, 'title' | 'project_name' | 'id'>): string {
  return session.title || session.project_name || session.id;
}

/** "1 prompt", "2 prompts" — never "1 prompts". */
export function plural(n: number, noun: string): string {
  return `${n.toLocaleString('en-US')} ${noun}${n === 1 ? '' : 's'}`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

/** A session that has not ended is measured up to `now`. */
export function sessionDuration(session: DbSessionRow, now: number): string {
  if (!session.started_at) return '--';
  return formatDuration((session.ended_at || now) - session.started_at);
}

/** "Oct 7, 21:04" — the year only when it is not `now`'s; never seconds. */
export function formatDate(ts: number | null, now: number): string {
  if (!ts) return '--';
  const date = new Date(ts);
  const thisYear = date.getFullYear() === new Date(now).getFullYear();
  return date.toLocaleString('en-US', {
    ...(thisYear ? {} : { year: 'numeric' }),
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    // h23, not hour12:false — Chrome renders midnight as "24:05" with the latter.
    hourCycle: 'h23',
  });
}

export function formatClock(ts: number, withSeconds: boolean): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    ...(withSeconds ? { second: '2-digit' } : {}),
    hourCycle: 'h23',
  });
}
