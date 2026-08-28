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
import { useCallback, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { authFetch } from '@/hooks/useAuth';
import SearchInput from '@/components/ui/SearchInput';
import Select from '@/components/ui/Select';
import Tooltip from '@/components/ui/Tooltip';
import { showToast } from '@/components/ui/ToastContainer';
import { useSessionStore } from '@/stores/sessionStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
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
  if (filters.dateFrom) params.set('dateFrom', String(new Date(filters.dateFrom).getTime()));
  if (filters.dateTo) params.set('dateTo', String(new Date(`${filters.dateTo}T23:59:59`).getTime()));
  params.set('page', String(filters.page));
  params.set('pageSize', String(PAGE_SIZE));
  return params.toString();
}

function formatDayKey(ts: number): string {
  return new Date(ts).toLocaleDateString('en-US', {
    weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  });
}

function formatClock(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
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
    showToast(result.duplicate ? 'Already in your saved prompts' : 'Saved to your prompts', result.duplicate ? 'info' : 'success');
  }, [saveSnippet, text]);

  return (
    <div className={styles.row}>
      <div className={styles.rowMeta}>
        <span className={styles.rowTime}>{formatClock(row.timestamp)}</span>
        <span className={styles.rowProject}>{row.project_name || 'unknown project'}</span>
        <span className={styles.rowSession}>
          {sessionDisplayTitle({ title: row.session_title ?? '', projectName: row.project_name ?? '' })}
        </span>
        {isLive && <span className={styles.rowLive}>live</span>}

        <div className={styles.rowActions}>
          <Tooltip label="Copy prompt">
            <button className={styles.rowAction} onClick={handleCopy} aria-label="Copy prompt">⧉</button>
          </Tooltip>
          <Tooltip label="Save to your prompts">
            <button className={styles.rowAction} onClick={handleSaveSnippet} aria-label="Save to your prompts">🔖</button>
          </Tooltip>
          {/* Only rendered while the session is still in memory — a dead
              "open" button that silently does nothing is worse than none. */}
          {isLive && (
            <Tooltip label="Open this session">
              <button
                className={styles.rowAction}
                onClick={() => onOpen(row.session_id)}
                aria-label="Open this session"
              >
                ↗
              </button>
            </Tooltip>
          )}
        </div>
      </div>

      <div className={styles.rowText}>
        <Highlighted text={shown} query={query} />
      </div>

      {(truncated || expanded) && (
        <button className={styles.rowExpand} onClick={() => setExpanded((v) => !v)}>
          {expanded ? '⌃ show less' : `⌄ show all (${text.length.toLocaleString()} chars)`}
        </button>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export default function PromptsView() {
  const navigate = useNavigate();
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const sessions = useSessionStore((s) => s.sessions);
  const selectSession = useSessionStore((s) => s.selectSession);

  const { data: projects } = useQuery({
    queryKey: ['db-projects'],
    queryFn: async () => {
      const res = await authFetch('/api/db/projects');
      if (!res.ok) throw new Error('Failed to load projects');
      return res.json() as Promise<DistinctProject[]>;
    },
    staleTime: 60_000,
  });

  const { data, isLoading, isError, refetch, isFetching } = useQuery({
    queryKey: ['db-prompts', filters],
    queryFn: async () => {
      const res = await authFetch(`/api/db/prompts?${buildParams(filters)}`);
      if (!res.ok) throw new Error(`Failed to load prompts (${res.status})`);
      return res.json() as Promise<PromptSearchResponse>;
    },
    placeholderData: (prev) => prev,
  });

  const updateFilter = useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }));
    },
    [],
  );

  const openSession = useCallback(
    (sessionId: string) => {
      selectSession(sessionId);
      navigate('/');
    },
    [selectSession, navigate],
  );

  const prompts = useMemo(() => data?.prompts ?? [], [data]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PAGE_SIZE));
  const groups = useMemo(() => groupByDay(prompts), [prompts]);
  const query = useMemo(() => normalizeQuery(filters.query), [filters.query]);
  const firstShown = total === 0 ? 0 : (filters.page - 1) * PAGE_SIZE + 1;
  const lastShown = Math.min(filters.page * PAGE_SIZE, total);

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
      {/* Filters */}
      <div className={styles.filters}>
        <SearchInput
          value={filters.query}
          onChange={(v) => updateFilter('query', v)}
          placeholder="Search all prompts…"
          className={styles.search}
        />

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Project</span>
          <Select
            value={filters.project}
            onChange={(val) => updateFilter('project', val)}
            options={[
              { value: '', label: 'All' },
              ...(projects?.map((p) => ({ value: p.project_path, label: p.project_name })) ?? []),
            ]}
          />
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>From</span>
          <input
            type="date"
            className={styles.filterInput}
            value={filters.dateFrom}
            onChange={(e) => updateFilter('dateFrom', e.target.value)}
          />
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>To</span>
          <input
            type="date"
            className={styles.filterInput}
            value={filters.dateTo}
            onChange={(e) => updateFilter('dateTo', e.target.value)}
          />
        </div>

        <div className={styles.spacer} />

        <button
          className={styles.toolBtn}
          onClick={() => refetch()}
          disabled={isFetching}
          title="Reload — new prompts are recorded continuously"
        >
          {isFetching ? '↻ …' : '↻ Refresh'}
        </button>
        <button
          className={styles.toolBtn}
          onClick={handleExport}
          disabled={prompts.length === 0}
          title="Download the prompts on this page as JSON"
        >
          Export
        </button>
      </div>

      {/* Source facet + result summary */}
      <div className={styles.subBar}>
        <div className={styles.kindPills}>
          {KINDS.map((k) => (
            <button
              key={k.key}
              className={`${styles.kindPill}${filters.kind === k.key ? ` ${styles.kindPillActive}` : ''}`}
              onClick={() => updateFilter('kind', k.key)}
              title={k.title}
              aria-pressed={filters.kind === k.key}
            >
              {k.label}
            </button>
          ))}
        </div>

        <span className={styles.summary}>
          {isLoading
            ? 'Loading…'
            : total === 0
              ? 'No prompts'
              : `${total.toLocaleString()} prompt${total === 1 ? '' : 's'} · showing ${firstShown.toLocaleString()}–${lastShown.toLocaleString()}`}
        </span>

        {(filters.query || filters.project || filters.dateFrom || filters.dateTo || filters.kind !== 'mine') && (
          <button className={styles.clearFilters} onClick={() => setFilters(INITIAL_FILTERS)}>
            Clear filters
          </button>
        )}
      </div>

      {/* Results */}
      <div className={styles.results}>
        {isError ? (
          <div className={styles.empty}>
            Could not load prompts.{' '}
            <button className={styles.inlineAction} onClick={() => refetch()}>retry</button>
          </div>
        ) : isLoading ? (
          <div className={styles.empty}>Loading prompts…</div>
        ) : groups.length === 0 ? (
          <div className={styles.empty}>
            {filters.kind === 'mine' && !filters.query && !filters.project
              ? 'No prompts recorded yet.'
              : 'No prompts match these filters.'}
          </div>
        ) : (
          groups.map((group) => (
            <div key={group.day} className={styles.dayGroup}>
              <div className={styles.dayHeader}>
                <span className={styles.dayLabel}>{group.day}</span>
                <span className={styles.dayRule} />
                {/* "shown", not "prompts": a day straddling a page boundary
                    only has part of its rows here, so a bare count would lie. */}
                <span className={styles.dayCount}>{group.rows.length} shown</span>
              </div>
              {group.rows.map((row) => (
                <PromptRow
                  key={row.id}
                  row={row}
                  query={query}
                  isLive={sessions.has(row.session_id)}
                  onOpen={openSession}
                />
              ))}
            </div>
          ))
        )}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <div className={styles.pagination}>
          <button
            className={styles.pageBtn}
            onClick={() => updateFilter('page', filters.page - 1)}
            disabled={filters.page <= 1}
          >
            ‹ Prev
          </button>
          <span className={styles.pageInfo}>
            Page {filters.page.toLocaleString()} / {totalPages.toLocaleString()}
          </span>
          <button
            className={styles.pageBtn}
            onClick={() => updateFilter('page', filters.page + 1)}
            disabled={filters.page >= totalPages}
          >
            Next ›
          </button>
        </div>
      )}
    </div>
  );
}
