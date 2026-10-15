/**
 * chatFormat.ts — the small words and numbers of the phone chat and Changes
 * (AASC-41 / AASC-44): durations ("0:42"), "Thought for 12 s", "2nd", "+42 −7",
 * "5 min ago", a path's name and folder. Pure.
 */

const MINUS = '−';

/** "0:42", "12:05", "1:02:09"; '' under a second (not worth a number). */
export function formatDuration(ms: number | undefined | null): string {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 1000) return '';
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = String(total % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${s}` : `${m}:${s}`;
}

/** "Thought for 12 s", "Thought for 2 min 5 s", or "Thought" when the CLI didn't say how long. */
export function thoughtLabel(durationMs?: number): string {
  if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 1000) return 'Thought';
  const secs = Math.round(durationMs / 1000);
  if (secs < 60) return `Thought for ${secs} s`;
  const mins = Math.floor(secs / 60);
  const rest = secs % 60;
  return rest ? `Thought for ${mins} min ${rest} s` : `Thought for ${mins} min`;
}

/** 1st, 2nd, 3rd, 4th, 11th, 12th, 13th, 21st. */
export function ordinal(n: number): string {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  switch (n % 10) {
    case 1: return `${n}st`;
    case 2: return `${n}nd`;
    case 3: return `${n}rd`;
    default: return `${n}th`;
  }
}

/** "+42 −7", "+3", "−2"; '' for nothing. A real minus sign, as the design draws it. */
export function formatCounts(counts: { added: number; removed: number } | null | undefined): string {
  if (!counts) return '';
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`+${counts.added}`);
  if (counts.removed > 0) parts.push(`${MINUS}${counts.removed}`);
  return parts.join(' ');
}

/** The same counts in words, for a screen reader ("42 lines added, 7 removed"). */
export function countsLabel(counts: { added: number; removed: number }): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} ${counts.added === 1 ? 'line' : 'lines'} added`);
  if (counts.removed > 0) parts.push(`${counts.removed} removed`);
  return parts.join(', ') || 'no lines changed';
}

/** The last segment of a path (either slash). */
export function basename(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at >= 0 ? trimmed.slice(at + 1) : trimmed;
}

/** Everything before the last segment, with its trailing slash; '' for a bare name. */
export function dirname(path: string): string {
  const trimmed = path.replace(/[\\/]+$/, '');
  const at = Math.max(trimmed.lastIndexOf('/'), trimmed.lastIndexOf('\\'));
  return at >= 0 ? trimmed.slice(0, at + 1) : '';
}

/** The first line of `text`, trimmed. */
export function firstLine(text: string): string {
  const line = text.trimStart().split('\n', 1)[0] ?? '';
  return line.trim();
}

/** "just now", "5 min ago", "3 h ago", "Oct 14". */
export function relativeTime(at: number, now: number = Date.now()): string {
  const diff = Math.max(0, now - at);
  if (diff < 60_000) return 'just now';
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} min ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} h ago`;
  return new Date(at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** "1 file" / "3 files". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}
