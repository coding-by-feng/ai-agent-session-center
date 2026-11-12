/**
 * What `aasc` prints. Status is always a glyph plus a word, never colour alone (plan §9.4),
 * and anything that came from a server is stripped of control characters first: a session
 * title is whatever someone typed, and an escape sequence in it would rewrite the screen.
 */
import { sessionDisplayTitle } from '../../src/lib/sessionDisplayTitle.js';
import type { RemoteSession } from './sessions.js';
import { cleanText } from './sanitize.js';

const GLYPHS: Record<string, string> = {
  working: '●',
  prompting: '◐',
  approval: '!',
  input: '?',
  waiting: '✓',
  idle: '○',
  connecting: '…',
  ended: '✕',
};

/** Statuses that need a person: `ls` marks them and `watch` rings for them. */
export function needsYou(status: string): boolean {
  return status === 'approval' || status === 'input';
}

/** = sanitize.ts cleanText: every server string goes through it before it's printed. */
export const cleanCell = cleanText;

export function statusLabel(status: string): string {
  return `${GLYPHS[status] ?? '·'} ${cleanCell(status)}`;
}

export function relativeAge(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} h`;
  return `${Math.floor(h / 24)} d`;
}

/** Cut to `width` display cells (roughly: one per code point), with an ellipsis. */
function fit(text: string, width: number): string {
  const chars = [...text];
  return chars.length <= width ? text : `${chars.slice(0, width - 1).join('')}…`;
}

function pad(text: string, width: number): string {
  const len = [...text].length;
  return len >= width ? text : text + ' '.repeat(width - len);
}

const TITLE_WIDTH = 40;

/** The `ls` table for one server's sessions, numbered from 1 in the order given. */
export function renderSessionTable(sessions: RemoteSession[], now: number): string {
  const rows = sessions.map((s, i) => ({
    n: String(i + 1),
    status: statusLabel(s.status),
    cli: cleanCell(s.cliSource || s.source || '—'),
    title: fit(cleanCell(sessionDisplayTitle(s)), TITLE_WIDTH),
    active: s.lastActivityAt ? relativeAge(now - s.lastActivityAt) : '—',
    note: needsYou(s.status) ? '← needs you' : '',
  }));
  const w = {
    n: Math.max(1, ...rows.map((r) => r.n.length)),
    status: Math.max(6, ...rows.map((r) => [...r.status].length)),
    cli: Math.max(3, ...rows.map((r) => [...r.cli].length)),
    title: Math.max(5, ...rows.map((r) => [...r.title].length)),
    active: Math.max(6, ...rows.map((r) => r.active.length)),
  };
  const line = (n: string, status: string, cli: string, title: string, active: string, note: string): string =>
    `  ${n.padStart(w.n)}  ${pad(status, w.status)}  ${pad(cli, w.cli)}  ${pad(title, w.title)}  ${pad(active, w.active)}${note ? `  ${note}` : ''}`.trimEnd();
  return [
    line('#', 'STATUS', 'CLI', 'TITLE', 'ACTIVE', ''),
    ...rows.map((r) => line(r.n, r.status, r.cli, r.title, r.active, r.note)),
  ].join('\n');
}

/** "1 session", "2 sessions": never "1 sessions". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export function clock(at: number): string {
  const d = new Date(at);
  return [d.getHours(), d.getMinutes(), d.getSeconds()].map((v) => String(v).padStart(2, '0')).join(':');
}
