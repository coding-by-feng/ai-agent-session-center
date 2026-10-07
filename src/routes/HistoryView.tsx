/**
 * HistoryView — the HISTORY tab: SQLite-backed session search (filters, sort,
 * pagination) and a per-session detail dialog (Conversation / Activity, in
 * components/history/SessionDetailDialog).
 *
 * A row is a stretched <button> that opens the detail, with Resume and Delete
 * as sibling IconButtons: a button cannot contain a button, and a click-only
 * <div> row is out of the keyboard's reach.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetch } from '@/hooks/useAuth';
import { canRetry, readJson } from '@/lib/requestJson';
import { uniqueProjectOptions } from '@/lib/projectOptions';
import { focusSiblingAfterRemoval } from '@/lib/focusAfterRemoval';
import { formatDate, plural, sessionDuration, sessionName, statusChip } from '@/lib/historyFormat';
import { useUiStore } from '@/stores/uiStore';
import SessionDetailDialog from '@/components/history/SessionDetailDialog';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import StaleNote from '@/components/ui/StaleNote';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect from '@/components/ui/NativeSelect';
import type { NativeSelectOption } from '@/components/ui/NativeSelect';
import Pagination from '@/components/ui/Pagination';
import SearchInput from '@/components/ui/SearchInput';
import TextInput from '@/components/ui/TextInput';
import TrashIcon from '@/components/ui/TrashIcon';
import { showToast } from '@/components/ui/ToastContainer';
import type { DistinctProject, SessionSearchParams, SessionSearchResponse, DbSessionRow } from '@/types';
import styles from '@/styles/modules/History.module.css';

interface Filters {
  query: string;
  project: string;
  status: string;
  dateFrom: string;
  dateTo: string;
  sortBy: string;
  sortDir: 'asc' | 'desc';
  page: number;
}

const PAGE_SIZE = 50;
const DETAIL_MODAL_ID = 'history-session-detail';
/** The stretched open button of a row — the focus target after a delete. */
const ROW_OPEN = '[data-row-open]';

const INITIAL_FILTERS: Filters = {
  query: '',
  project: '',
  status: '',
  dateFrom: '',
  dateTo: '',
  sortBy: 'date',
  sortDir: 'desc',
  page: 1,
};

const STATUS_OPTIONS: readonly NativeSelectOption[] = [
  { value: '', label: 'All' },
  { value: 'idle', label: 'Idle' },
  { value: 'working', label: 'Working' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'ended', label: 'Ended' },
  { value: 'archived', label: 'Archived' },
];

const SORT_OPTIONS: readonly NativeSelectOption[] = [
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

function buildSearchParams(filters: Filters): string {
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
  params.set('pageSize', String(PAGE_SIZE));
  return params.toString();
}

/** "137 sessions · showing 51–100" */
function summaryLine(total: number, page: number, shown: number): string {
  const from = (page - 1) * PAGE_SIZE + 1;
  const range =
    total > PAGE_SIZE && shown > 0
      ? `showing ${from.toLocaleString('en-US')}–${(from + shown - 1).toLocaleString('en-US')}`
      : '';
  return [plural(total, 'session'), range].filter(Boolean).join(' · ');
}

export default function HistoryView() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  // The row button that opened the detail: focus goes back to it on close.
  const openerRef = useRef<HTMLElement | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<HTMLDivElement>(null);
  const activeModal = useUiStore((s) => s.activeModal);
  const openModal = useUiStore((s) => s.openModal);

  // Leaving the tab must not strand the modal id with no dialog behind it.
  useEffect(() => () => {
    const ui = useUiStore.getState();
    if (ui.activeModal === DETAIL_MODAL_ID) ui.closeModal();
  }, []);

  // Fetch projects for filter dropdown
  const { data: projects } = useQuery({
    queryKey: ['db-projects'],
    queryFn: async () =>
      readJson<DistinctProject[]>(
        await authFetch('/api/db/projects'),
        'Failed to load projects',
      ),
    staleTime: 60_000,
  });

  // Fetch sessions
  // keepPreviousData: a new page or filter keeps the old rows (and the pager)
  // up until its answer lands. Without it `total` dropped to 0, Pagination
  // unmounted the focused Next button, and keyboard focus fell to <body>.
  const { data: searchResult, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['db-sessions', filters],
    queryFn: async () =>
      readJson<SessionSearchResponse>(
        await authFetch(`/api/db/sessions?${buildSearchParams(filters)}`),
        'Failed to load sessions',
      ),
    placeholderData: keepPreviousData,
  });

  const updateFilter = useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }));
      // New rows start at the top (the previous page stays up while loading).
      if (bodyRef.current) bodyRef.current.scrollTop = 0;
    },
    [],
  );

  const clearFilters = useCallback(() => {
    setFilters((prev) => ({ ...prev, query: '', project: '', status: '', dateFrom: '', dateTo: '', page: 1 }));
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
  }, []);

  const handleOpen = useCallback(
    (sessionId: string, opener: HTMLElement) => {
      openerRef.current = opener;
      setSelectedSessionId(sessionId);
      openModal(DETAIL_MODAL_ID);
    },
    [openModal],
  );

  const handleCloseDetail = useCallback(() => {
    setSelectedSessionId(null);
    const opener = openerRef.current;
    openerRef.current = null;
    if (opener?.isConnected) opener.focus();
  }, []);

  // A failed delete used to be silent (no res.ok check), and a network error
  // an unhandled rejection; both now say so.
  const handleDelete = useCallback(
    async (sessionId: string, row: Element | null) => {
      if (!window.confirm('Delete this session from history? This cannot be undone.')) return;
      try {
        await readJson<unknown>(
          await authFetch(`/api/db/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
          'Could not delete the session',
        );
      } catch (err) {
        showToast(err instanceof Error ? err.message : String(err), 'error');
        return;
      }
      // The focused Delete leaves with its row: hand focus to a neighbouring
      // row, or to the search box when the page empties.
      focusSiblingAfterRemoval(row, ROW_OPEN, viewRef.current?.querySelector<HTMLElement>('[data-search-input]'));
      queryClient.invalidateQueries({ queryKey: ['db-sessions'] });
    },
    [queryClient],
  );

  const handleResume = useCallback(
    async (sessionId: string) => {
      try {
        const resp = await authFetch(`/api/sessions/${encodeURIComponent(sessionId)}/resume`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
        });
        const data = await resp.json();
        if (data.ok) {
          showToast('Resuming Claude session in terminal', 'success');
        } else {
          showToast(data.error || 'Resume failed', 'error');
        }
      } catch (err) {
        showToast((err as Error).message, 'error');
      }
    },
    [],
  );

  const projectOptions = useMemo<readonly NativeSelectOption[]>(
    () => [{ value: '', label: 'All' }, ...uniqueProjectOptions(projects)],
    [projects],
  );

  const sessions = searchResult?.sessions ?? [];
  const total = searchResult?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);
  const filtersActive = Boolean(
    filters.query || filters.project || filters.status || filters.dateFrom || filters.dateTo,
  );

  const renderResults = (): ReactNode => {
    if (isLoading) return <EmptyState busy fill title="Loading sessions…" />;
    // A failed BACKGROUND refetch keeps the rows on screen (see the note
    // below); only a load with nothing to show becomes the error state.
    if (isError && !searchResult) {
      return (
        <EmptyState
          tone="error"
          fill
          title="Could not load sessions"
          hint={error?.message}
          action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined}
        />
      );
    }
    if (sessions.length === 0) {
      // Rows can vanish under an open page (deleted here or on another device).
      if (total > 0) {
        return (
          <EmptyState
            fill
            title="No sessions on this page"
            action={<Button onClick={() => updateFilter('page', totalPages)}>Go to last page</Button>}
          />
        );
      }
      if (filtersActive) {
        return (
          <EmptyState
            fill
            title="No sessions match these filters"
            hint="Try a different search, or clear the filters."
            action={<Button onClick={clearFilters}>Clear filters</Button>}
          />
        );
      }
      return (
        <EmptyState fill title="No sessions recorded yet" hint="Sessions appear here once an agent session has run." />
      );
    }
    return (
      <>
        {isError && <StaleNote onRetry={canRetry(error) ? () => refetch() : undefined} />}
        {/* role="list": Safari/VoiceOver drops list semantics once list-style is none. */}
        <ul className={styles.list} role="list">
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            now={dataUpdatedAt}
            onOpen={handleOpen}
            onResume={handleResume}
            onDelete={handleDelete}
          />
        ))}
        </ul>
      </>
    );
  };

  return (
    <div ref={viewRef} className={styles.view} data-testid="history-view">
      <HistoryHeader
        filters={filters}
        projectOptions={projectOptions}
        summary={searchResult ? summaryLine(total, filters.page, sessions.length) : ''}
        onChange={updateFilter}
      />

      <div ref={bodyRef} className={styles.body}>{renderResults()}</div>

      <Pagination
        page={filters.page}
        totalPages={totalPages}
        onPageChange={(p) => updateFilter('page', p)}
        label="Session pages"
      />

      {selectedSessionId && activeModal === DETAIL_MODAL_ID && (
        <SessionDetailDialog
          key={selectedSessionId}
          modalId={DETAIL_MODAL_ID}
          sessionId={selectedSessionId}
          listed={sessions.find((s) => s.id === selectedSessionId)}
          onClose={handleCloseDetail}
        />
      )}
    </div>
  );
}

// ---- Toolbar ---------------------------------------------------------------

interface HistoryHeaderProps {
  filters: Filters;
  projectOptions: readonly NativeSelectOption[];
  summary: string;
  onChange: <K extends keyof Filters>(key: K, value: Filters[K]) => void;
}

function HistoryHeader({ filters, projectOptions, summary, onChange }: HistoryHeaderProps) {
  const descending = filters.sortDir === 'desc';
  return (
    <header className={styles.header}>
      <div className={styles.toolbar} role="search" aria-label="Filter sessions">
        <SearchInput
          variant="field"
          ariaLabel="Search prompts"
          className={styles.search}
          value={filters.query}
          onChange={(v) => onChange('query', v)}
          placeholder="Search prompts..."
        />
        <Field label="Project" className={styles.filterField}>
          <NativeSelect
            className={styles.filterControl}
            value={filters.project}
            onChange={(v) => onChange('project', v)}
            options={projectOptions}
          />
        </Field>
        <Field label="Status" className={styles.filterField}>
          <NativeSelect
            className={styles.filterControl}
            value={filters.status}
            onChange={(v) => onChange('status', v)}
            options={STATUS_OPTIONS}
          />
        </Field>
        <div className={styles.group}>
          <Field label="From" className={styles.filterField}>
            <TextInput
              type="date"
              className={styles.filterControl}
              value={filters.dateFrom}
              onChange={(e) => onChange('dateFrom', e.target.value)}
            />
          </Field>
          <Field label="To" className={styles.filterField}>
            <TextInput
              type="date"
              className={styles.filterControl}
              value={filters.dateTo}
              onChange={(e) => onChange('dateTo', e.target.value)}
            />
          </Field>
        </div>
        <div className={styles.group}>
          <Field label="Sort" className={styles.filterField}>
            <NativeSelect
              className={styles.filterControl}
              value={filters.sortBy}
              onChange={(v) => onChange('sortBy', v)}
              options={SORT_OPTIONS}
            />
          </Field>
          <Button
            icon={<SortArrowIcon descending={descending} />}
            // The name starts with the visible word (WCAG 2.5.3): "click Desc" works by voice.
            aria-label={descending ? 'Descending sort' : 'Ascending sort'}
            onClick={() => onChange('sortDir', descending ? 'asc' : 'desc')}
          >
            {descending ? 'Desc' : 'Asc'}
          </Button>
        </div>
      </div>
      <p className={styles.summary}>{summary}</p>
    </header>
  );
}

// ---------------------------------------------------------------------------
// Icons — one 24-grid stroke wrapper; the buttons size the glyph and name it
// ---------------------------------------------------------------------------

function Icon({ children, strokeWidth = 2 }: { children: ReactNode; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth}
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const ResumeIcon = () => (
  <Icon>
    <polyline points="1 4 1 10 7 10" />
    <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
  </Icon>
);

const SortArrowIcon = ({ descending }: { descending: boolean }) => (
  <Icon strokeWidth={2.5}>
    <line x1="12" y1="5" x2="12" y2="19" />
    <polyline points={descending ? '19 12 12 19 5 12' : '5 12 12 5 19 12'} />
  </Icon>
);

// ---- Session list ----------------------------------------------------------

interface SessionRowProps {
  session: DbSessionRow;
  now: number;
  onOpen: (sessionId: string, opener: HTMLElement) => void;
  onResume: (sessionId: string) => void;
  onDelete: (sessionId: string, row: Element | null) => void;
}

function SessionRow({ session, now, onOpen, onResume, onDelete }: SessionRowProps) {
  const nameId = useId();
  const name = sessionName(session);
  const chip = statusChip(session);

  return (
    <li className={styles.row}>
      <button
        type="button"
        className={styles.rowOpen}
        data-row-open=""
        onClick={(e) => onOpen(session.id, e.currentTarget)}
      >
        <span id={nameId} className={styles.rowTitle} title={name}>{name}</span>
        <span className={styles.rowProject} title={session.project_name}>{session.project_name}</span>
        <span className={styles.rowDate}>{formatDate(session.started_at, now)}</span>
        <span className={styles.rowDuration}>{sessionDuration(session, now)}</span>
        <span className={styles.rowStatus}>
          <Chip tone={chip.tone} title={chip.title}>{chip.label}</Chip>
        </span>
        <span className={styles.rowPrompts}>{plural(session.total_prompts, 'prompt')}</span>
        <span className={styles.rowTools}>{plural(session.total_tool_calls, 'tool')}</span>
      </button>
      {/* Every row repeats these two names; the description says which row. */}
      <IconButton label="Resume session" aria-describedby={nameId} onClick={() => onResume(session.id)}>
        <ResumeIcon />
      </IconButton>
      <IconButton
        label="Delete session"
        tone="danger"
        aria-describedby={nameId}
        onClick={(e) => onDelete(session.id, e.currentTarget.closest('li'))}
      >
        <TrashIcon />
      </IconButton>
    </li>
  );
}
