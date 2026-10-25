/**
 * PhoneHistory — the HISTORY tab on a phone (AASC-20, feature 3): one column,
 * search and Filters at the top, a row opens the session's history full
 * screen (Conversation / Activity) with its actions at the bottom.
 *
 * Which history depends on where the phone is (hostAccess.ts):
 *
 *  - On the Mac itself: the whole history, exactly what the desktop asks the
 *    server for (lib/historyQuery.ts), with Resume and Delete.
 *  - A remote device: the sessions shared with it, from the live list it
 *    already has. The session list, full-text search and the project list
 *    answer the host only, so they are never called; a line says so. Each
 *    shared session's own history (`GET /api/db/sessions/:id`) is open to it.
 *    No Delete: a phone may not delete history.
 */
import { useCallback, useMemo, useRef, useState, type CSSProperties } from 'react';
import { keepPreviousData, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { authFetch } from '@/hooks/useAuth';
import { RequestError, canRetry, readJson } from '@/lib/requestJson';
import { uniqueProjectOptions } from '@/lib/projectOptions';
import { formatDate, plural, sessionDuration, sessionName, statusChip } from '@/lib/historyFormat';
import {
  HISTORY_PAGE_SIZE,
  HISTORY_SORT_OPTIONS,
  HISTORY_STATUS_OPTIONS,
  INITIAL_HISTORY_FILTERS,
  activeHistoryFilterCount,
  buildHistorySearchParams,
  historySummaryLine,
  type HistoryFilters,
} from '@/lib/historyQuery';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { isCompacting, phoneStatus } from '@/lib/chat/phoneStatus';
import { requestSessionResume } from '@/lib/sessionActions';
import { useSessionStore } from '@/stores/sessionStore';
import { SessionDetailBody } from '@/components/history/SessionDetailDialog';
import BottomSheet, { ConfirmSheet } from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import Pagination from '@/components/ui/Pagination';
import StaleNote from '@/components/ui/StaleNote';
import { showToast } from '@/components/ui/ToastContainer';
import type { DbSessionRow, DistinctProject, SessionDetailResponse, SessionSearchResponse } from '@/types';
import { useIsHostDevice } from './hostAccess';
import PhoneViewBar, { HostOnlyNote } from './PhoneViewBar';
import PhoneDateInput from './PhoneDateInput';
import styles from '@/styles/modules/PhoneViews.module.css';

const SORT_DIR_OPTIONS: readonly NativeSelectOption<'asc' | 'desc'>[] = [
  { value: 'desc', label: 'Descending' },
  { value: 'asc', label: 'Ascending' },
];

export default function PhoneHistory() {
  return useIsHostDevice() ? <HostHistory /> : <SharedHistory />;
}

// ---------------------------------------------------------------------------
// On the Mac: the whole history
// ---------------------------------------------------------------------------

function HostHistory() {
  const queryClient = useQueryClient();
  const [filters, setFilters] = useState<HistoryFilters>(INITIAL_HISTORY_FILTERS);
  const [openId, setOpenId] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const { data: projects } = useQuery({
    queryKey: ['db-projects'],
    queryFn: async () =>
      readJson<DistinctProject[]>(await authFetch('/api/db/projects'), 'Failed to load projects'),
    staleTime: 60_000,
  });

  const { data, isLoading, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['db-sessions', filters],
    queryFn: async () =>
      readJson<SessionSearchResponse>(
        await authFetch(`/api/db/sessions?${buildHistorySearchParams(filters)}`),
        'Failed to load sessions',
      ),
    placeholderData: keepPreviousData,
  });

  const update = useCallback(<K extends keyof HistoryFilters>(key: K, value: HistoryFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }));
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);

  const clearFilters = useCallback(() => {
    setFilters((prev) => ({ ...prev, project: '', status: '', dateFrom: '', dateTo: '', page: 1 }));
  }, []);

  const projectOptions = useMemo<readonly NativeSelectOption[]>(
    () => [{ value: '', label: 'All' }, ...uniqueProjectOptions(projects)],
    [projects],
  );

  const sessions = data?.sessions ?? [];
  const total = data?.total ?? 0;
  const totalPages = Math.ceil(total / HISTORY_PAGE_SIZE);
  const active = activeHistoryFilterCount(filters);
  const closeDetail = useCallback(() => setOpenId(null), []);
  const onDeleted = useCallback(() => {
    setOpenId(null);
    void queryClient.invalidateQueries({ queryKey: ['db-sessions'] });
  }, [queryClient]);

  const body = () => {
    if (isLoading) return <EmptyState busy fill title="Loading sessions…" />;
    if (isError && !data) {
      return (
        <EmptyState
          fill
          tone="error"
          title="Could not load sessions"
          hint={error?.message}
          action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined}
        />
      );
    }
    if (sessions.length === 0) {
      return active > 0 || filters.query
        ? <EmptyState fill title="No sessions match" hint="Try another search, or clear the filters." />
        : <EmptyState fill title="No sessions recorded yet" hint="Sessions appear here once an agent session has run." />;
    }
    return (
      <>
        {isError && <StaleNote onRetry={canRetry(error) ? () => refetch() : undefined} />}
        <ul className={styles.list} role="list">
          {sessions.map((s) => (
            <HostRow key={s.id} session={s} now={dataUpdatedAt} onOpen={setOpenId} />
          ))}
        </ul>
      </>
    );
  };

  return (
    <div className={styles.view} data-testid="phone-history">
      <PhoneViewBar
        searchLabel="Search prompts"
        searchPlaceholder="Search…"
        search={filters.query}
        onSearch={(v) => update('query', v)}
        activeFilters={active}
        onClearFilters={clearFilters}
        summary={data ? historySummaryLine(total, filters.page, sessions.length) : ''}
        filters={(
          <>
            <Field label="Project" className={styles.sheetField}>
              <NativeSelect value={filters.project} onChange={(v) => update('project', v)} options={projectOptions} />
            </Field>
            <Field label="Status" className={styles.sheetField}>
              <NativeSelect value={filters.status} onChange={(v) => update('status', v)} options={HISTORY_STATUS_OPTIONS} />
            </Field>
            <div className={styles.sheetPair}>
              <Field label="From" className={styles.sheetField}>
                <PhoneDateInput value={filters.dateFrom} onChange={(v) => update('dateFrom', v)} />
              </Field>
              <Field label="To" className={styles.sheetField}>
                <PhoneDateInput value={filters.dateTo} onChange={(v) => update('dateTo', v)} />
              </Field>
            </div>
            <div className={styles.sheetPair}>
              <Field label="Sort by" className={styles.sheetField}>
                <NativeSelect value={filters.sortBy} onChange={(v) => update('sortBy', v)} options={HISTORY_SORT_OPTIONS} />
              </Field>
              <Field label="Order" className={styles.sheetField}>
                <NativeSelect value={filters.sortDir} onChange={(v) => update('sortDir', v)} options={SORT_DIR_OPTIONS} />
              </Field>
            </div>
          </>
        )}
      />
      <div ref={listRef} className={styles.scroll}>
        {body()}
        <Pagination
          page={filters.page}
          totalPages={totalPages}
          onPageChange={(p) => update('page', p)}
          label="Session pages"
          className={styles.pager}
        />
      </div>
      {openId && (
        <HistoryDetailSheet
          sessionId={openId}
          listed={sessions.find((s) => s.id === openId)}
          canDelete
          onClose={closeDetail}
          onDeleted={onDeleted}
        />
      )}
    </div>
  );
}

function HostRow({ session, now, onOpen }: { session: DbSessionRow; now: number; onOpen: (id: string) => void }) {
  const name = sessionName(session);
  const chip = statusChip(session);
  // The phone's own status words (phoneStatus), as on its Sessions list; the chip keeps its tone.
  const label = session.status === 'ended' ? 'Ended' : phoneStatus(session.status).label;
  const project = session.title && session.project_name ? session.project_name : '';
  return (
    <li className={styles.row}>
      <button type="button" className={styles.rowButton} onClick={() => onOpen(session.id)}>
        <span className={styles.rowTop}>
          <span className={styles.rowTitle}>{name}</span>
          <Chip tone={chip.tone}>{chip.title ? `${label} · ${chip.title}` : label}</Chip>
        </span>
        <span className={styles.rowMeta}>
          {[project, formatDate(session.started_at, now), sessionDuration(session, now)].filter(Boolean).join(' · ')}
        </span>
        <span className={styles.rowMeta}>
          {plural(session.total_prompts, 'prompt')} · {plural(session.total_tool_calls, 'tool')}
        </span>
      </button>
    </li>
  );
}

// ---------------------------------------------------------------------------
// A remote device: the sessions shared with it
// ---------------------------------------------------------------------------

type SharedStatus = 'all' | 'active' | 'ended';
const SHARED_STATUS_OPTIONS: readonly NativeSelectOption<SharedStatus>[] = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Running' },
  { value: 'ended', label: 'Ended' },
];

function SharedHistory() {
  const sessions = useSessionStore((s) => s.sessions);
  const [search, setSearch] = useState('');
  const [status, setStatus] = useState<SharedStatus>('all');
  const [openId, setOpenId] = useState<string | null>(null);
  // The clock is read once per visit, not on every render.
  const [now] = useState(() => Date.now());

  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return [...sessions.values()]
      .filter((s) => {
        if (status === 'active' && s.status === 'ended') return false;
        if (status === 'ended' && s.status !== 'ended') return false;
        if (!q) return true;
        return [s.title, s.projectName, s.remark].some((t) => t?.toLowerCase().includes(q));
      })
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0));
  }, [sessions, search, status]);

  const closeDetail = useCallback(() => setOpenId(null), []);
  const summary = `${plural(rows.length, 'shared session')}`;

  return (
    <div className={styles.view} data-testid="phone-history">
      <PhoneViewBar
        searchLabel="Search shared sessions"
        searchPlaceholder="Search…"
        search={search}
        onSearch={setSearch}
        searchDebounceMs={150}
        activeFilters={status === 'all' ? 0 : 1}
        onClearFilters={() => setStatus('all')}
        summary={summary}
        filters={(
          <Field label="Status" className={styles.sheetField}>
            <NativeSelect value={status} onChange={setStatus} options={SHARED_STATUS_OPTIONS} />
          </Field>
        )}
      >
        <HostOnlyNote>
          Your Mac keeps the full history: every past session, search across all of them, and
          sessions not shared with this phone. Here: each shared session's own history.
        </HostOnlyNote>
      </PhoneViewBar>
      <div className={styles.scroll}>
        {rows.length === 0 ? (
          sessions.size === 0
            ? <EmptyState fill title="No sessions shared with this phone" hint="Share a session from your Mac to see its history here." />
            : <EmptyState fill title="No sessions match" />
        ) : (
          <ul className={styles.list} role="list">
            {rows.map((s) => {
              const title = sessionDisplayTitle(s);
              const project = s.projectName && s.projectName !== title ? s.projectName : '';
              const status = phoneStatus(s.status, !!s.interruption, isCompacting(s, now));
              return (
                <li key={s.sessionId} className={styles.row} style={{ '--row-accent': `var(--ph-status-${status.tone})` } as CSSProperties}>
                  <button type="button" className={`${styles.rowButton} ${styles.rowAccent}`} onClick={() => setOpenId(s.sessionId)}>
                    <span className={styles.rowTop}>
                      <span className={styles.rowTitle}>{title}</span>
                      <span className={styles.rowStatus}>{status.label}</span>
                    </span>
                    <span className={styles.rowMeta}>
                      {[project, s.lastActivityAt ? `active ${formatDate(s.lastActivityAt, now)}` : ''].filter(Boolean).join(' · ')}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
      {openId && <HistoryDetailSheet sessionId={openId} canDelete={false} onClose={closeDetail} />}
    </div>
  );
}

// ---------------------------------------------------------------------------
// One session's history, full screen
// ---------------------------------------------------------------------------

interface HistoryDetailSheetProps {
  sessionId: string;
  /** The row it was opened from: names the sheet before the detail lands. */
  listed?: DbSessionRow;
  /** A phone may not delete history; the Mac may. */
  canDelete: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}

function HistoryDetailSheet({ sessionId, listed, canDelete, onClose, onDeleted }: HistoryDetailSheetProps) {
  const navigate = useNavigate();
  const live = useSessionStore((s) => s.sessions.get(sessionId));
  const selectSession = useSessionStore((s) => s.selectSession);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState<'resume' | 'delete' | null>(null);
  // Stable: BottomSheet re-runs its focus handling whenever onClose changes,
  // and this re-renders on every update of the live session.
  const cancelDelete = useCallback(() => setConfirmDelete(false), []);

  const { data: detail, isError, error, refetch, dataUpdatedAt } = useQuery({
    queryKey: ['db-session-detail', sessionId],
    queryFn: async () =>
      readJson<SessionDetailResponse>(
        await authFetch(`/api/db/sessions/${encodeURIComponent(sessionId)}`),
        'Failed to load session detail',
      ),
  });

  const row = detail?.session ?? listed;
  const title = live ? sessionDisplayTitle(live) : row ? sessionName(row) : 'Session history';
  // In the live list: it can be opened. Not running (ended, or only in the
  // history): it can be resumed, as the desktop's rows can.
  const canResume = !live || live.status === 'ended';
  const missing = error instanceof RequestError && error.status === 404;

  const open = () => {
    selectSession(sessionId);
    onClose();
    navigate('/');
  };

  const resume = async () => {
    setBusy('resume');
    try {
      const result = await requestSessionResume(sessionId);
      showToast(result.message, result.ok ? 'success' : 'error');
    } catch (err) {
      showToast(err instanceof Error ? err.message : 'Resume failed', 'error');
    } finally {
      setBusy(null);
    }
  };

  const remove = async () => {
    setBusy('delete');
    try {
      await readJson<unknown>(
        await authFetch(`/api/db/sessions/${encodeURIComponent(sessionId)}`, { method: 'DELETE' }),
        'Could not delete the session',
      );
      showToast('Deleted from history', 'success');
      onDeleted?.();
    } catch (err) {
      showToast(err instanceof Error ? err.message : String(err), 'error');
    } finally {
      setBusy(null);
      setConfirmDelete(false);
    }
  };

  let content;
  if (detail) {
    content = <SessionDetailBody detail={detail} now={dataUpdatedAt} />;
  } else if (isError) {
    content = missing ? (
      <EmptyState compact title="No history recorded yet" hint="This session has nothing saved on your Mac yet." />
    ) : (
      <EmptyState
        compact
        tone="error"
        title="Could not load this session"
        hint={error?.message}
        action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined}
      />
    );
  } else {
    content = <EmptyState busy compact title="Loading session…" />;
  }

  return (
    <>
      <BottomSheet open onClose={onClose} title={title} fullHeight className={styles.dress}>
        <div className={styles.detail} data-testid="history-detail">
          <div className={`${styles.detailScroll} ${styles.historyDetail}`}>{content}</div>
          <div className={styles.detailActions}>
            {live && <Button variant={canResume ? 'default' : 'primary'} onClick={open}>Open session</Button>}
            {canResume && (
              <Button variant="primary" onClick={() => void resume()} disabled={busy !== null} aria-busy={busy === 'resume' || undefined}>
                {busy === 'resume' ? 'Resuming…' : 'Resume'}
              </Button>
            )}
            {canDelete && (
              <Button variant="danger" onClick={() => setConfirmDelete(true)} disabled={busy !== null}>Delete</Button>
            )}
          </div>
        </div>
      </BottomSheet>
      <ConfirmSheet
        open={confirmDelete}
        title="Delete this session from history?"
        message={`"${title}" and everything recorded for it are removed. This cannot be undone.`}
        confirmLabel="Delete"
        danger
        busy={busy === 'delete'}
        onConfirm={() => void remove()}
        onCancel={cancelDelete}
      />
    </>
  );
}
