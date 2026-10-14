/**
 * historyQuery — the HISTORY tab's filters and the `/api/db/sessions` request
 * they build. Shared by the desktop view (routes/HistoryView) and the phone's
 * (components/mobile/views/PhoneHistory), so both ask the server the same way.
 */
import type { NativeSelectOption } from '@/components/ui/NativeSelect';
import type { SessionSearchParams } from '@/types';
import { plural } from '@/lib/historyFormat';

export interface HistoryFilters {
  query: string;
  project: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  page: number;
}

export const HISTORY_PAGE_SIZE = 50;

export const INITIAL_HISTORY_FILTERS: HistoryFilters = {
  query: '',
  project: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'date',
  sortDir: 'desc',
  page: 1,
};

export const HISTORY_STATUS_OPTIONS: readonly NativeSelectOption[] = [
  { value: '', label: 'All' },
  { value: 'idle', label: 'Idle' },
  { value: 'working', label: 'Working' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'ended', label: 'Ended' },
  { value: 'archived', label: 'Archived' },
];

export const HISTORY_SORT_OPTIONS: readonly NativeSelectOption[] = [
  { value: 'date', label: 'Date' },
  { value: 'duration', label: 'Activity' },
  { value: 'prompts', label: 'Prompts' },
  { value: 'tools', label: 'Tools' },
];

// "Prompts" and "Tools" mapped to started_at until Oct 2026 — the server's
// sort whitelist (db.searchSessions) had no prompt/tool columns, so both
// options silently sorted by date.
const SORT_COLUMNS: Record<string, NonNullable<SessionSearchParams['sortBy']>> = {
  date: 'started_at',
  duration: 'last_activity_at',
  prompts: 'total_prompts',
  tools: 'total_tool_calls',
};

export function buildHistorySearchParams(filters: HistoryFilters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('query', filters.query);
  if (filters.project) params.set('project', filters.project);
  if (filters.status === 'archived') {
    params.set('archived', 'true');
  } else if (filters.status) {
    params.set('status', filters.status);
  }
  // Both ends in LOCAL time. `new Date('YYYY-MM-DD')` parses as UTC midnight,
  // so at GMT+13 a From date dropped every session before 13:00 that day while
  // To (already local) did not — the range was lopsided by the UTC offset.
  if (filters.dateFrom) {
    params.set('dateFrom', String(new Date(`${filters.dateFrom}T00:00:00`).getTime()));
  }
  if (filters.dateTo) {
    params.set('dateTo', String(new Date(`${filters.dateTo}T23:59:59`).getTime()));
  }
  params.set('sortBy', SORT_COLUMNS[filters.sortBy] ?? 'started_at');
  params.set('sortDir', filters.sortDir);
  params.set('page', String(filters.page));
  params.set('pageSize', String(HISTORY_PAGE_SIZE));
  return params.toString();
}

/** "137 sessions · showing 51–100" */
export function historySummaryLine(total: number, page: number, shown: number): string {
  const from = (page - 1) * HISTORY_PAGE_SIZE + 1;
  const range =
    total > HISTORY_PAGE_SIZE && shown > 0
      ? `showing ${from.toLocaleString('en-US')}–${(from + shown - 1).toLocaleString('en-US')}`
      : '';
  return [plural(total, 'session'), range].filter(Boolean).join(' · ');
}

/** Filters beyond search and sort: what a "Filters (n)" button counts. */
export function activeHistoryFilterCount(filters: HistoryFilters): number {
  return [filters.project, filters.status, filters.dateFrom, filters.dateTo].filter(Boolean).length;
}
