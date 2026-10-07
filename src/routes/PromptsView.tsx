/**
 * PromptsView — the global prompt trace.
 *
 * Every prompt the agents ever received is already persisted at full length by
 * `db.insertFullPrompt()` on each `UserPromptSubmit`; this view is a read
 * surface over that table, not a new recording path.
 *
 * Two things shape the design:
 *  - ~10% of the rows were never typed by a human (the harness posts
 *    `<task-notification>` & friends through the same hook), so the source
 *    facet defaults to MINE rather than dumping everything.
 *  - Prompts are unbounded in length (thousands here exceed 4 KB), so rows
 *    clamp and expand on demand.
 */
import { useCallback, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { authFetch } from '@/hooks/useAuth';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect from '@/components/ui/NativeSelect';
import Pagination from '@/components/ui/Pagination';
import SearchInput from '@/components/ui/SearchInput';
import SectionHeader from '@/components/ui/SectionHeader';
import StaleNote from '@/components/ui/StaleNote';
import TextInput from '@/components/ui/TextInput';
import { showToast } from '@/components/ui/ToastContainer';
import UnfoldIcon from '@/components/ui/UnfoldIcon';
import { useSessionStore } from '@/stores/sessionStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { uniqueProjectOptions } from '@/lib/projectOptions';
import { canRetry, readJson } from '@/lib/requestJson';
import { clipToMatch, normalizeQuery, splitHighlight } from '@/lib/textHighlight';
import type { DistinctProject, PromptKind, PromptSearchResponse, PromptTraceRow } from '@/types';
import styles from '@/styles/modules/Prompts.module.css';

const PAGE_SIZE = 50;
/** Longer prompts render clamped with a "show all" toggle. */
const CLAMP_CHARS = 320;

interface Filters {
  query: string;
  project: string;
  kind: PromptKind;
  dateFrom: string;
  dateTo: string;
  page: number;
}

const INITIAL_FILTERS: Filters = {
  query: '',
  project: '',
  kind: 'mine',
  dateFrom: '',
  dateTo: '',
  page: 1,
};

const KINDS: { key: PromptKind; label: string; title: string }[] = [
  { key: 'mine', label: 'Mine', title: 'Everything you sent — prose and commands' },
  { key: 'cmd', label: '/Cmd', title: 'Slash commands and Codex $skill invocations' },
  { key: 'agent', label: 'Agent', title: 'Harness-injected turns you never typed (task notifications, reminders)' },
  { key: 'all', label: 'All', title: 'Every recorded row, unfiltered' },
];

function buildParams(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('query', filters.query);
  if (filters.project) params.set('project', filters.project);
  if (filters.kind) params.set('kind', filters.kind);
  // Both ends LOCAL time. `new Date('YYYY-MM-DD')` is UTC midnight: at GMT+13
  // "From Oct 1" silently dropped Oct 1's prompts before 13:00.
  if (filters.dateFrom) params.set('dateFrom', String(new Date(`${filters.dateFrom}T00:00:00`).getTime()));
  if (filters.dateTo) params.set('dateTo', String(new Date(`${filters.dateTo}T23:59:59`).getTime()));
  params.set('page', String(filters.page));
  params.set('pageSize', String(PAGE_SIZE));
  return params.toString();
}

/** "Wed, Oct 7" — the year is implied for the current year, named for any other. */
function formatDayKey(ts: number): string {
  const date = new Date(ts);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return date.toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', ...(sameYear ? {} : { year: 'numeric' }),
  });
}

// `hourCycle: 'h23'`, not `hour12: false`: en-US + hour12:false prints midnight
// as "24:05" on engines that still map it to h24.
function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
}

/** The seconds the minutes-only clock drops, kept for the row's hover title. */
function formatExact(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', {
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  });
}

/** Group consecutive rows by calendar day, preserving server order. */
function groupByDay(prompts: PromptTraceRow[]): { day: string; rows: PromptTraceRow[] }[] {
  const groups: { day: string; rows: PromptTraceRow[] }[] = [];
  for (const row of prompts) {
    const day = formatDayKey(row.timestamp);
    const last = groups[groups.length - 1];
    if (last && last.day === day) last.rows.push(row);
    else groups.push({ day, rows: [row] });
  }
  return groups;
}

function Highlighted({ text, query }: { text: string; query: string }) {
  if (!query) return <>{text}</>;
  return (
    <>
      {splitHighlight(text, query).map((seg, i) =>
        seg.match ? <mark key={i}>{seg.text}</mark> : <span key={i}>{seg.text}</span>,
      )}
    </>
  );
}

// ---------------------------------------------------------------------------
// Glyphs — stroked, `currentColor`; the primitives size them (14px / 12px).
// ---------------------------------------------------------------------------

function Glyph({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

const RefreshGlyph = () => (
  <Glyph>
    <polyline points="23 4 23 10 17 10" />
    <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
  </Glyph>
);

const CopyGlyph = () => (
  <Glyph>
    <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" />
  </Glyph>
);

const OpenGlyph = () => (
  <Glyph>
    <line x1="7" y1="17" x2="17" y2="7" />
    <polyline points="7 7 17 7 17 17" />
  </Glyph>
);

// ---------------------------------------------------------------------------
// Row
// ---------------------------------------------------------------------------

function PromptRow({
  row,
  query,
  isLive,
  onOpen,
}: {
  row: PromptTraceRow;
  query: string;
  isLive: boolean;
  onOpen: (sessionId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const saveSnippet = usePromptSnippetStore((s) => s.save);

  const text = row.text ?? '';
  const sessionTitle = sessionDisplayTitle({
    title: row.session_title ?? '',
    projectName: row.project_name ?? '',
  });
  // toLocale*String builds a new Intl formatter on every call; a row
  // re-renders on expand and on every highlight change, so format once per time.
  const clock = useMemo(() => formatClock(row.timestamp), [row.timestamp]);
  const clockExact = useMemo(() => formatExact(row.timestamp), [row.timestamp]);

  // Clamp around the MATCH, not the start. Head-truncating a 22 KB prompt whose
  // hit sits at character 5,000 renders a row that claims to match and shows no
  // evidence of it. The hard cap still applies afterwards, in case the client's
  // case-folding disagrees with SQLite's and finds no match at all.
  const shown = useMemo(() => {
    if (expanded) return text;
    const HARD_CAP = CLAMP_CHARS + 160;
    const windowed = query
      ? clipToMatch(text, query, { leading: 100, trailing: CLAMP_CHARS })
      : text;
    return windowed.length > HARD_CAP ? `${windowed.slice(0, HARD_CAP)}…` : windowed;
  }, [expanded, text, query]);

  const truncated = shown !== text;

  // The row's actions are described by its time, project and session, so a
  // screen reader's list of buttons is not N identical "Copy prompt"s.
  const metaId = useId();
  const describedBy = `${metaId}-time ${metaId}-project ${metaId}-session`;

  const handleCopy = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Prompt copied', 'success');
    } catch {
      showToast('Could not copy to clipboard', 'error');
    }
  }, [text]);

  const handleSaveSnippet = useCallback(async () => {
    const result = await saveSnippet(text);
    // `id: null` without `duplicate` is a save that wrote nothing (blank text,
    // or IndexedDB refused); it used to toast "Saved" anyway.
    if (result.id === null && !result.duplicate) {
      showToast('Could not save this prompt', 'error');
      return;
    }
    showToast(result.duplicate ? 'Already in your saved prompts' : 'Saved to your prompts', result.duplicate ? 'info' : 'success');
  }, [saveSnippet, text]);

  return (
    <li className={styles.row}>
      <div className={styles.rowMeta}>
        {/* Minutes only; the exact time (seconds included) is on hover. */}
        <time id={`${metaId}-time`} className={styles.rowTime} title={clockExact}>{clock}</time>
        <span id={`${metaId}-project`} className={styles.rowProject}>{row.project_name || 'unknown project'}</span>
        <span id={`${metaId}-session`} className={styles.rowSession} title={sessionTitle}>{sessionTitle}</span>
        {isLive && <Chip tone="success" title="On your dashboard — open it with the arrow button">live</Chip>}

        <div className={styles.rowActions}>
          {/* Only rendered while the session is still in memory — a dead
              "open" button that silently does nothing is worse than none.
              First in the group, so Copy and Save keep one column down the
              list whether or not a row has it. */}
          {isLive && (
            <IconButton size="sm" label="Open this session" aria-describedby={describedBy} onClick={() => onOpen(row.session_id)}>
              <OpenGlyph />
            </IconButton>
          )}
          <IconButton size="sm" label="Copy prompt" aria-describedby={describedBy} onClick={handleCopy}>
            <CopyGlyph />
          </IconButton>
          <IconButton size="sm" label="Save to your prompts" aria-describedby={describedBy} onClick={handleSaveSnippet}>
            🔖
          </IconButton>
        </div>
      </div>

      <div className={styles.rowText}>
        <Highlighted text={shown} query={query} />
      </div>

      {(truncated || expanded) && (
        <Button
          variant="quiet"
          size="sm"
          className={styles.rowExpand}
          icon={<UnfoldIcon expanded={expanded} />}
          onClick={() => setExpanded((v) => !v)}
        >
          {expanded ? 'Show less' : `Show all (${text.length.toLocaleString()} chars)`}
        </Button>
      )}
    </li>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function PromptsView() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  // The ids only, compared shallowly: reading the sessions Map re-rendered the
  // whole page of rows on every session event, though a row only asks "is my
  // session still live?".
  const liveIds = useSessionStore(useShallow((s) => Array.from(s.sessions.keys())));
  const liveSessions = useMemo(() => new Set(liveIds), [liveIds]);
  const selectSession = useSessionStore((s) => s.selectSession);
  const resultsRef = useRef<HTMLDivElement>(null);

  const { data: projects } = useQuery({
    queryKey: ['db-projects'],
    queryFn: async () =>
      readJson<DistinctProject[]>(await authFetch('/api/db/projects'), 'Failed to load projects'),
    staleTime: 60_000,
  });

  // readJson keeps the status (and the server's own reason), so a refusal
  // offers no Retry; the app QueryClient does not auto-retry it either.
  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: ['db-prompts', filters],
    queryFn: async () =>
      readJson<PromptSearchResponse>(
        await authFetch(`/api/db/prompts?${buildParams(filters)}`),
        'Failed to load prompts',
      ),
    placeholderData: keepPreviousData,
  });
  // A failed REFRESH keeps the rows on screen (StaleNote); only a load with
  // nothing to show is the error state.
  const failedEmpty = isError && !data;

  /** New rows start at the top: the results box kept its scroll offset, so
   *  Next (or Clear filters) landed mid-way down the new list. */
  const scrollToTop = useCallback(() => {
    if (resultsRef.current) resultsRef.current.scrollTop = 0;
  }, []);

  const updateFilter = useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }));
      scrollToTop();
    },
    [scrollToTop],
  );

  const clearFilters = useCallback(() => {
    setFilters(INITIAL_FILTERS);
    scrollToTop();
  }, [scrollToTop]);

  const openSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      navigate('/');
    },
    [selectSession, navigate],
  );

  const projectOptions = useMemo(
    () => [{ value: '', label: 'All' }, ...uniqueProjectOptions(projects)],
    [projects],
  );

  const prompts = useMemo(() => data?.prompts ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const groups = useMemo(() => groupByDay(prompts), [prompts]);
  const query = useMemo(() => normalizeQuery(filters.query), [filters.query]);
  const firstShown = total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(filters.page * PAGE_SIZE, total);
  const hasActiveFilters = Boolean(
    filters.query || filters.project || filters.dateFrom || filters.dateTo || filters.kind !== 'mine',
  );

  const handleExport = useCallback(() => {
    const payload = {
      schema: 'aasc-prompt-trace',
      version: 1,
      exportedAt: new Date().toISOString(),
      filters: { ...filters, pageSize: PAGE_SIZE },
      // Honest naming: this is the page on screen, not the whole result set.
      count: prompts.length,
      totalMatching: total,
      prompts,
    };
    const url = URL.createObjectURL(
      new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' }),
    );
    const a = document.createElement('a');
    a.href = url;
    a.download = `prompts-page${filters.page}.json`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filters, prompts, total]);

  return (
    <div className={styles.container} data-testid="prompts-view">
      <div className={styles.header}>
        {/* Filters */}
        <div className={styles.toolbar}>
          <SearchInput
            variant="field"
            ariaLabel="Search all prompts"
            value={filters.query}
            onChange={(v) => updateFilter('query', v)}
            placeholder="Search all prompts…"
            className={styles.search}
          />

          <Field label="Project">
            <NativeSelect
              value={filters.project}
              onChange={(val) => updateFilter('project', val)}
              options={projectOptions}
            />
          </Field>

          <Field label="From">
            <TextInput
              type="date"
              value={filters.dateFrom}
              onChange={(e) => updateFilter('dateFrom', e.target.value)}
            />
          </Field>

          <Field label="To">
            <TextInput
              type="date"
              value={filters.dateTo}
              onChange={(e) => updateFilter('dateTo', e.target.value)}
            />
          </Field>

          {/* One unit: wrapping splits the toolbar between controls, and a lone
              Export under Refresh spends a whole row on one button. */}
          <div className={styles.actions}>
            {/* Busy, never disabled: disabling the button you just pressed
                drops keyboard focus to <body>. A press while busy is ignored. */}
            <Button
              className={isFetching ? styles.refreshing : undefined}
              icon={<RefreshGlyph />}
              onClick={() => { if (!isFetching) refetch(); }}
              aria-busy={isFetching || undefined}
              title="Reload — new prompts are recorded continuously"
            >
              Refresh
            </Button>
            <Button
              onClick={handleExport}
              disabled={prompts.length === 0}
              title="Download the prompts on this page as JSON"
            >
              Export
            </Button>
          </div>
        </div>

        {/* Source facet + result summary */}
        <div className={styles.facets}>
          <div className={styles.kindGroup} role="group" aria-label="Source">
            {KINDS.map((k) => (
              <Button
                key={k.key}
                size="sm"
                pressed={filters.kind === k.key}
                title={k.title}
                onClick={() => updateFilter('kind', k.key)}
              >
                {k.label}
              </Button>
            ))}
          </div>

          {/* The summary and the action that resets it wrap as one unit. Clear
              filters stays last, so it appearing never moves the summary. */}
          <div className={styles.facetInfo}>
            <p className={styles.summary}>
              {failedEmpty
                ? ''
                : isLoading
                ? 'Loading…'
                : total === 0
                  ? 'No prompts'
                  : `${total.toLocaleString()} prompt${total === 1 ? '' : 's'} · showing ${firstShown.toLocaleString()}–${lastShown.toLocaleString()}`}
            </p>

            {hasActiveFilters && (
              <Button variant="quiet" size="sm" onClick={clearFilters}>
                Clear filters
              </Button>
            )}
          </div>
        </div>
      </div>

      {/* Results */}
      <div ref={resultsRef} className={styles.results}>
        {failedEmpty ? (
          <EmptyState
            fill
            tone="error"
            title="Could not load prompts."
            hint={error?.message}
            action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined}
          />
        ) : isLoading ? (
          <EmptyState fill busy title="Loading prompts…" />
        ) : groups.length === 0 ? (
          <EmptyState
            fill
            title={hasActiveFilters ? 'No prompts match these filters.' : 'No prompts recorded yet.'}
          />
        ) : (
          <>
          {isError && <StaleNote onRetry={canRetry(error) ? () => refetch() : undefined} />}
          {groups.map((group) => (
            <div key={group.day} className={styles.dayGroup}>
              {/* "shown", not "prompts": a day straddling a page boundary
                  only has part of its rows here, so a bare count would lie. */}
              <SectionHeader
                level={2}
                sticky
                className={styles.dayHeader}
                label={group.day}
                aside={`${group.rows.length} shown`}
              />
              <ul className={styles.rows} role="list" aria-label={`Prompts on ${group.day}`}>
                {group.rows.map((row) => (
                  <PromptRow
                    key={row.id}
                    row={row}
                    query={query}
                    isLive={liveSessions.has(row.session_id)}
                    onOpen={openSession}
                  />
                ))}
              </ul>
            </div>
          ))}
          </>
        )}
      </div>

      {/* Pagination */}
      <Pagination
        page={filters.page}
        totalPages={totalPages}
        onPageChange={(page) => updateFilter('page', page)}
        label="Prompt pages"
      />
    </div>
  );
}
