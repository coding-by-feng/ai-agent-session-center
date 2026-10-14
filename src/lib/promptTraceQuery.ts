/**
 * promptTraceQuery — the PROMPTS tab's filters, the `/api/db/prompts` request
 * they build, and how rows are grouped and timed. Shared by the desktop view
 * (routes/PromptsView) and the phone's (components/mobile/views/PhonePrompts).
 */
import type { PromptKind, PromptTraceRow } from '@/types';

export const PROMPTS_PAGE_SIZE = 50;
/** Longer prompts render clamped with a "show all" toggle. */
export const PROMPT_CLAMP_CHARS = 320;

export interface PromptFilters {
  query: string;
  project: string;
  kind: PromptKind;
  dateFrom: string;
  dateTo: string;
  page: number;
}

export const INITIAL_PROMPT_FILTERS: PromptFilters = {
  query: '',
  project: '',
  kind: 'mine',
  dateFrom: '',
  dateTo: '',
  page: 1,
};

export const PROMPT_KINDS: { key: PromptKind; label: string; title: string }[] = [
  { key: 'mine', label: 'Mine', title: 'Everything you sent — prose and commands' },
  { key: 'cmd', label: '/Cmd', title: 'Slash commands and Codex $skill invocations' },
  { key: 'agent', label: 'Agent', title: 'Harness-injected turns you never typed (task notifications, reminders)' },
  { key: 'all', label: 'All', title: 'Every recorded row, unfiltered' },
];

/**
 * The query string. `session` narrows the trace to one session: a remote
 * device may read the trace only that way (the server's AASC-29 gate), and
 * only for a session shared with it.
 */
export function buildPromptParams(filters: PromptFilters, session?: string): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('query', filters.query);
  if (filters.project) params.set('project', filters.project);
  if (session) params.set('session', session);
  if (filters.kind) params.set('kind', filters.kind);
  // Both ends LOCAL time. `new Date('YYYY-MM-DD')` is UTC midnight: at GMT+13
  // "From Oct 1" silently dropped Oct 1's prompts before 13:00.
  if (filters.dateFrom) params.set('dateFrom', String(new Date(`${filters.dateFrom}T00:00:00`).getTime()));
  if (filters.dateTo) params.set('dateTo', String(new Date(`${filters.dateTo}T23:59:59`).getTime()));
  params.set('page', String(filters.page));
  params.set('pageSize', String(PROMPTS_PAGE_SIZE));
  return params.toString();
}

/** "Wed, Oct 7" — the year is implied for the current year, named for any other. */
export function formatDayKey(ts: number): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// `hourCycle: 'h23'`, not `hour12: false`: en-US + hour12:false prints midnight
// as "24:05" on engines that still map it to h24.
export function formatPromptClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The seconds the minutes-only clock drops. */
export function formatPromptExact(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

/** Group consecutive rows by calendar day, preserving server order. */
export function groupPromptsByDay(prompts: PromptTraceRow[]): { day: string; rows: PromptTraceRow[] }[] {
  const groups: { day: string; rows: PromptTraceRow[] }[] = [];
  for (const row of prompts) {
    const day = formatDayKey(row.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}
