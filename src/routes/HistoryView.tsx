import { useState, useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { authFetch } from '@/hooks/useAuth';
import SearchInput from '@/components/ui/SearchInput';
import Tabs from '@/components/ui/Tabs';
import type {
  SessionSearchResponse,
  SessionDetailResponse,
  DbSessionRow,
} from '@/types';
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

function formatDuration(ms: number): string {
  if (ms < 1000) return '<1s';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function formatDate(ts: number | null): string {
  if (!ts) return '--';
  return new Date(ts).toLocaleString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

function formatTime(ts: number): string {
  return new Date(ts).toLocaleTimeString('en-US', { hour12: false });
}

function buildSearchParams(filters: Filters): string {
  const params = new URLSearchParams();
  if (filters.query) params.set('query', filters.query);
  if (filters.project) params.set('project', filters.project);
  if (filters.status === 'archived') {
    params.set('archived', 'true');
  } else if (filters.status) {
    params.set('status', filters.status);
  }
  if (filters.dateFrom) {
    params.set('dateFrom', String(new Date(filters.dateFrom).getTime()));
  }
  if (filters.dateTo) {
    params.set('dateTo', String(new Date(filters.dateTo + 'T23:59:59').getTime()));
  }
  const sortMap: Record<string, string> = {
    date: 'started_at',
    duration: 'last_activity_at',
    prompts: 'started_at',
    tools: 'started_at',
  };
  params.set('sortBy', sortMap[filters.sortBy] || 'started_at');
  params.set('sortDir', filters.sortDir);
  params.set('page', String(filters.page));
  params.set('pageSize', String(PAGE_SIZE));
  return params.toString();
}

export default function HistoryView() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<Filters>({
    query: '',
    project: '',
    status: '',
    dateFrom: '',
    dateTo: '',
    sortBy: 'date',
    sortDir: 'desc',
    page: 1,
  });
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);

  // Fetch projects for filter dropdown
  const { data: projects } = useQuery({
    queryKey: ['db-projects'],
    queryFn: async () => {
      const res = await authFetch('/api/db/projects');
      if (!res.ok) throw new Error('Failed to load projects');
      return res.json() as Promise<Array<{ project_path: string; project_name: string }>>;
    },
    staleTime: 60_000,
  });

  // Fetch sessions
  const { data: searchResult, isLoading } = useQuery({
    queryKey: ['db-sessions', filters],
    queryFn: async () => {
      const res = await authFetch(`/api/db/sessions?${buildSearchParams(filters)}`);
      if (!res.ok) throw new Error('Failed to load sessions');
      return res.json() as Promise<SessionSearchResponse>;
    },
  });

  // Fetch session detail when selected
  const { data: detail } = useQuery({
    queryKey: ['db-session-detail', selectedSessionId],
    queryFn: async () => {
      if (!selectedSessionId) return null;
      const res = await authFetch(
        `/api/db/sessions/${encodeURIComponent(selectedSessionId)}`,
      );
      if (!res.ok) throw new Error('Failed to load session detail');
      return res.json() as Promise<SessionDetailResponse>;
    },
    enabled: !!selectedSessionId,
  });

  const updateFilter = useCallback(
    <K extends keyof Filters>(key: K, value: Filters[K]) => {
      setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }));
    },
    [],
  );

  const handleDelete = useCallback(
    async (e: React.MouseEvent, sessionId: string) => {
      e.stopPropagation();
      if (!window.confirm('Delete this session from history? This cannot be undone.')) return;
      await authFetch(`/api/db/sessions/${encodeURIComponent(sessionId)}`, {
        method: 'DELETE',
      });
      queryClient.invalidateQueries({ queryKey: ['db-sessions'] });
    },
    [queryClient],
  );

  const sessions = searchResult?.sessions ?? [];
  const total = searchResult?.total ?? 0;
  const totalPages = Math.ceil(total / PAGE_SIZE);

  return (
    <div className={styles.container} data-testid="history-view">
      {/* Filters */}
      <div className={styles.filters}>
        <SearchInput
          value={filters.query}
          onChange={(v) => updateFilter('query', v)}
          placeholder="Search prompts..."
        />

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Project</span>
          <select
            className={styles.filterSelect}
            value={filters.project}
            onChange={(e) => updateFilter('project', e.target.value)}
          >
            <option value="">All</option>
            {projects?.map((p) => (
              <option key={p.project_path} value={p.project_path}>
                {p.project_name}
              </option>
            ))}
          </select>
        </div>

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Status</span>
          <select
            className={styles.filterSelect}
            value={filters.status}
            onChange={(e) => updateFilter('status', e.target.value)}
          >
            <option value="">All</option>
            <option value="idle">Idle</option>
            <option value="working">Working</option>
            <option value="waiting">Waiting</option>
            <option value="ended">Ended</option>
            <option value="archived">Archived</option>
          </select>
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

        <div className={styles.filterGroup}>
          <span className={styles.filterLabel}>Sort</span>
          <select
            className={styles.filterSelect}
            value={filters.sortBy}
            onChange={(e) => updateFilter('sortBy', e.target.value)}
          >
            <option value="date">Date</option>
            <option value="duration">Activity</option>
            <option value="prompts">Prompts</option>
            <option value="tools">Tools</option>
          </select>
          <button
            className={styles.sortToggle}
            onClick={() =>
              updateFilter('sortDir', filters.sortDir === 'desc' ? 'asc' : 'desc')
            }
          >
            {filters.sortDir.toUpperCase()}
          </button>
        </div>
      </div>

      {/* Results */}
      <div className={styles.results}>
        {isLoading && <div className={styles.emptyState}>Loading...</div>}
        {!isLoading && sessions.length === 0 && (
          <div className={styles.emptyState}>No sessions found</div>
        )}
        {sessions.map((s) => (
          <SessionRow
            key={s.id}
            session={s}
            onClick={() => setSelectedSessionId(s.id)}
            onDelete={(e) => handleDelete(e, s.id)}
          />
        ))}
      </div>

      {/* Pagination */}
      {totalPages > 1 && (
        <Pagination
          currentPage={filters.page}
          totalPages={totalPages}
          onPageChange={(p) => updateFilter('page', p)}
        />
      )}

      {/* Session Detail Overlay */}
      {selectedSessionId && detail && (
        <SessionDetail detail={detail} onClose={() => setSelectedSessionId(null)} />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function SessionRow({
  session,
  onClick,
  onDelete,
}: {
  session: DbSessionRow;
  onClick: () => void;
  onDelete: (e: React.MouseEvent) => void;
}) {
  const duration =
    session.ended_at && session.started_at
      ? formatDuration(session.ended_at - session.started_at)
      : session.started_at
        ? formatDuration(Date.now() - session.started_at)
        : '--';

  return (
    <div className={styles.row} onClick={onClick}>
      <span className={styles.rowTitle}>{session.title || session.project_name || session.id}</span>
      <span className={styles.rowProject}>{session.project_name}</span>
      <span className={styles.rowDate}>{formatDate(session.started_at)}</span>
      <span className={styles.rowDuration}>{duration}</span>
      <span className={styles.rowStatus} data-status={session.status}>
        {session.status.toUpperCase()}
      </span>
      <span className={styles.rowMeta}>{session.total_prompts} prompts</span>
      <span className={styles.rowMeta}>{session.total_tool_calls} tools</span>
      <button
        className={styles.deleteBtn}
        onClick={onDelete}
        title="Delete session"
        aria-label="Delete session"
      >
        x
      </button>
    </div>
  );
}

function Pagination({
  currentPage,
  totalPages,
  onPageChange,
}: {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
}) {
  const pages: (number | 'ellipsis')[] = [];
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
      pages.push(i);
    }
  }

  // Insert ellipses
  const withEllipsis: (number | 'ellipsis')[] = [];
  let lastShown = 0;
  for (const p of pages) {
    if (typeof p === 'number') {
      if (lastShown && p - lastShown > 1) {
        withEllipsis.push('ellipsis');
      }
      withEllipsis.push(p);
      lastShown = p;
    }
  }

  return (
    <div className={styles.pagination}>
      <button
        className={styles.pageBtn}
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
      >
        Prev
      </button>
      {withEllipsis.map((item, idx) =>
        item === 'ellipsis' ? (
          <span key={`e-${idx}`} className={styles.pageEllipsis}>
            ...
          </span>
        ) : (
          <button
            key={item}
            className={`${styles.pageBtn} ${item === currentPage ? styles.pageBtnActive : ''}`}
            onClick={() => onPageChange(item)}
          >
            {item}
          </button>
        ),
      )}
      <button
        className={styles.pageBtn}
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
      >
        Next
      </button>
    </div>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  const handleCopy = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <button
      className={styles.copyBtn}
      onClick={handleCopy}
      aria-label="Copy to clipboard"
      title="Copy to clipboard"
    >
      {copied ? '\u2713' : '\u2398'}
    </button>
  );
}

function SessionDetail({
  detail,
  onClose,
}: {
  detail: SessionDetailResponse;
  onClose: () => void;
}) {
  const [activeTab, setActiveTab] = useState('conversation');
  const { session: sess, prompts, responses, tool_calls, events } = detail;

  // Interleaved conversation
  const convoEntries = [
    ...prompts.map((p) => ({ type: 'prompt' as const, timestamp: p.timestamp, text: p.text })),
    ...responses.map((r) => ({
      type: 'response' as const,
      timestamp: r.timestamp,
      text: r.text_excerpt,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp);

  // Merged activity
  const activityEntries = [
    ...tool_calls.map((t) => ({
      kind: 'tool' as const,
      label: t.tool_name,
      detail: t.tool_input_summary,
      timestamp: t.timestamp,
    })),
    ...events.map((e) => ({
      kind: 'event' as const,
      label: e.event_type,
      detail: e.detail,
      timestamp: e.timestamp,
    })),
  ].sort((a, b) => b.timestamp - a.timestamp);

  const duration =
    sess.ended_at && sess.started_at
      ? formatDuration(sess.ended_at - sess.started_at)
      : sess.started_at
        ? formatDuration(Date.now() - sess.started_at)
        : '--';

  const tabs = [
    {
      id: 'conversation',
      label: `Conversation (${convoEntries.length})`,
      content: (
        <div className={styles.detailBody}>
          {convoEntries.length === 0 && (
            <div className={styles.emptyState}>No conversation recorded</div>
          )}
          {convoEntries.map((entry, idx) => (
            <div
              key={idx}
              className={`${styles.convoEntry} ${
                entry.type === 'prompt' ? styles.convoPrompt : styles.convoResponse
              }`}
            >
              <div className={styles.convoEntryHeader}>
                <div className={styles.convoTime}>{formatTime(entry.timestamp)}</div>
                <CopyButton text={entry.text} />
              </div>
              <div className={styles.convoText}>{entry.text}</div>
            </div>
          ))}
        </div>
      ),
    },
    {
      id: 'activity',
      label: `Activity (${activityEntries.length})`,
      content: (
        <div className={styles.detailBody}>
          {activityEntries.length === 0 && (
            <div className={styles.emptyState}>No activity recorded</div>
          )}
          {activityEntries.map((entry, idx) => (
            <div key={idx} className={styles.activityEntry}>
              <span className={styles.activityTime}>{formatTime(entry.timestamp)}</span>
              <span
                className={`${styles.activityBadge} ${
                  entry.kind === 'tool'
                    ? styles.activityBadgeTool
                    : styles.activityBadgeEvent
                }`}
              >
                {entry.label}
              </span>
              <span className={styles.activityDetail}>{entry.detail}</span>
            </div>
          ))}
        </div>
      ),
    },
  ];

  return (
    <div className={styles.detailOverlay} onClick={onClose}>
      <div className={styles.detailCard} onClick={(e) => e.stopPropagation()}>
        <div className={styles.detailHeader}>
          <div>
            <h2 className={styles.detailTitle}>{sess.project_name || sess.id}</h2>
            <div className={styles.detailMeta}>
              <span>Status: {sess.status.toUpperCase()}</span>
              <span>Model: {sess.model || '--'}</span>
              <span>Duration: {duration}</span>
              <span>
                {sess.total_prompts} prompts / {sess.total_tool_calls} tools
              </span>
            </div>
          </div>
          <button className={styles.detailCloseBtn} onClick={onClose} aria-label="Close">
            x
          </button>
        </div>
        <Tabs
          tabs={tabs}
          activeTab={activeTab}
          onTabChange={setActiveTab}
          containerClassName={styles.detailTabs}
          panelClassName={styles.detailTabPanel}
        />
      </div>
    </div>
  );
}
