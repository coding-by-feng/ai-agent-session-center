/**
 * PhonePrompts — the PROMPTS tab (prompt trace) on a phone (AASC-20, feature
 * 4): one column grouped by day, search and Filters at the top, a row opens
 * the whole prompt full screen with Copy, Save and Open session.
 *
 * Which prompts depends on where the phone is (hostAccess.ts):
 *
 *  - On the Mac itself: the whole trace, with the desktop's filters.
 *  - A remote device: one shared session's prompts at a time. The server
 *    answers a remote device's trace only with `?session=<shared id>`, and its
 *    project list not at all, so the view always names a session and never
 *    asks for projects; a line says what stays on the Mac.
 *
 * Export (a JSON download) stays on the desktop.
 *
 * With `sessionId` it is one session's **Prompts** tab (Oct 19 2026): only that
 * session, wherever the phone is, with no picker, no per-row session name, and
 * "Use again" (`onUseAgain`: back into the composer, never sent) in place of
 * Open session.
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { keepPreviousData, useQuery } from '@tanstack/react-query';
import { useNavigate } from 'react-router';
import { authFetch } from '@/hooks/useAuth';
import { canRetry, readJson } from '@/lib/requestJson';
import { uniqueProjectOptions } from '@/lib/projectOptions';
import { sessionDisplayTitle } from '@/lib/sessionDisplayTitle';
import { clipToMatch, normalizeQuery, splitHighlight } from '@/lib/textHighlight';
import {
  INITIAL_PROMPT_FILTERS,
  PROMPTS_PAGE_SIZE,
  PROMPT_CLAMP_CHARS,
  PROMPT_KINDS,
  buildPromptParams,
  formatDayKey,
  formatPromptClock,
  formatPromptExact,
  groupPromptsByDay,
  type PromptFilters,
} from '@/lib/promptTraceQuery';
import { useSessionStore } from '@/stores/sessionStore';
import { usePromptSnippetStore } from '@/stores/promptSnippetStore';
import BottomSheet from '@/components/ui/BottomSheet';
import Button from '@/components/ui/Button';
import Chip from '@/components/ui/Chip';
import EmptyState from '@/components/ui/EmptyState';
import Field from '@/components/ui/Field';
import IconButton from '@/components/ui/IconButton';
import NativeSelect, { type NativeSelectOption } from '@/components/ui/NativeSelect';
import Pagination from '@/components/ui/Pagination';
import StaleNote from '@/components/ui/StaleNote';
import { showToast } from '@/components/ui/ToastContainer';
import { RefreshListIcon } from '@/components/ui/icons';
import type { DistinctProject, PromptSearchResponse, PromptTraceRow } from '@/types';
import { useIsHostDevice } from './hostAccess';
import PhoneDateInput from './PhoneDateInput';
import PhoneViewBar, { HostOnlyNote } from './PhoneViewBar';
import styles from '@/styles/modules/PhoneViews.module.css';

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

/** A row's preview: around the match when there is one, never the whole prompt. */
function preview(text: string, query: string): string {
  const windowed = query ? clipToMatch(text, query, { leading: 60, trailing: PROMPT_CLAMP_CHARS }) : text;
  return windowed.length > PROMPT_CLAMP_CHARS ? `${windowed.slice(0, PROMPT_CLAMP_CHARS)}…` : windowed;
}

export interface PhonePromptsProps {
  /** One session's Prompts tab: only its prompts, no picker. */
  sessionId?: string;
  /** "Use again" on a prompt (the tab only): put its text back in the composer. */
  onUseAgain?: (text: string) => void;
  /** Open this prompt once its row is on the page (the tab only; from the session title's
   *  recent list, Oct 23 2026). Matched by time: the full row and the session's history
   *  entry are written with the same timestamp. A new object opens it again. */
  openAt?: { at: number } | null;
  /** The `openAt` prompt was shown and closed, so its owner can drop the request (this view
   *  remounts with each visit to the tab; without it the prompt would open again). */
  onOpenAtDone?: () => void;
}

export default function PhonePrompts({ sessionId, onUseAgain, openAt, onOpenAtDone }: PhonePromptsProps = {}) {
  const host = useIsHostDevice();
  if (sessionId) return <PromptTrace key={`session:${sessionId}`} host={false} fixedSession={sessionId} onUseAgain={onUseAgain} openAt={openAt} onOpenAtDone={onOpenAtDone} />;
  // Keyed: crossing from remote to host (presence landing) starts clean.
  return <PromptTrace key={host ? 'host' : 'shared'} host={host} />;
}

function PromptTrace({ host, fixedSession, onUseAgain, openAt, onOpenAtDone }: { host: boolean; fixedSession?: string; onUseAgain?: (text: string) => void; openAt?: { at: number } | null; onOpenAtDone?: () => void }) {
  const navigate = useNavigate();
  const sessions = useSessionStore((s) => s.sessions);
  const selectedSessionId = useSessionStore((s) => s.selectedSessionId);
  const selectSession = useSessionStore((s) => s.selectSession);
  const [filters, setFilters] = useState<PromptFilters>(INITIAL_PROMPT_FILTERS);
  const [picked, setPicked] = useState('');
  const [openRow, setOpenRow] = useState<PromptTraceRow | null>(null);
  // The `openAt` request already shown and closed: it is not opened again.
  const [doneWith, setDoneWith] = useState<{ at: number } | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // A remote device reads one shared session's trace: the one picked, else the
  // one open, else the most recently active.
  const sessionOptions = useMemo<readonly NativeSelectOption[]>(
    () => [...sessions.values()]
      .sort((a, b) => (b.lastActivityAt ?? 0) - (a.lastActivityAt ?? 0))
      .map((s) => ({ value: s.sessionId, label: sessionDisplayTitle(s) })),
    [sessions],
  );
  const listed = (id: string | null) => (id && sessionOptions.some((o) => o.value === id) ? id : undefined);
  const session = fixedSession ?? (host ? undefined : listed(picked) ?? listed(selectedSessionId) ?? sessionOptions[0]?.value);

  const { data: projects } = useQuery({
    queryKey: ['db-projects'],
    queryFn: async () =>
      readJson<DistinctProject[]>(await authFetch('/api/db/projects'), 'Failed to load projects'),
    staleTime: 60_000,
    enabled: host,
  });

  const { data, isLoading, isError, error, refetch, isFetching } = useQuery({
    queryKey: host ? ['db-prompts', filters] : ['db-prompts', filters, session ?? null],
    queryFn: async () =>
      readJson<PromptSearchResponse>(
        await authFetch(`/api/db/prompts?${buildPromptParams(filters, session)}`),
        'Failed to load prompts',
      ),
    placeholderData: keepPreviousData,
    enabled: host || !!session,
  });

  const update = useCallback(<K extends keyof PromptFilters>(key: K, value: PromptFilters[K]) => {
    setFilters((prev) => ({ ...prev, [key]: value, page: key === 'page' ? (value as number) : 1 }));
    if (listRef.current) listRef.current.scrollTop = 0;
  }, []);
  const clearFilters = useCallback(() => {
    setFilters((prev) => ({ ...INITIAL_PROMPT_FILTERS, query: prev.query }));
  }, []);
  const pickSession = useCallback((id: string) => {
    setPicked(id);
    setFilters((prev) => ({ ...prev, page: 1 }));
  }, []);

  const projectOptions = useMemo(
    () => [{ value: '', label: 'All' }, ...uniqueProjectOptions(projects)],
    [projects],
  );
  const prompts = useMemo(() => data?.prompts ?? [], [data]);
  const groups = useMemo(() => groupPromptsByDay(prompts), [prompts]);
  const query = useMemo(() => normalizeQuery(filters.query), [filters.query]);
  const total = data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / PROMPTS_PAGE_SIZE));
  const active = [filters.project, filters.dateFrom, filters.dateTo, filters.kind !== 'mine' ? 'kind' : '']
    .filter(Boolean).length;
  const first = total === 0 ? 0 : (filters.page - 1) * PROMPTS_PAGE_SIZE + 1;
  const last = Math.min(filters.page * PROMPTS_PAGE_SIZE, total);
  // No count when there are none: the empty state below says so (Oct 20 2026: it said it twice).
  const summary = isLoading || (!host && !session) || total === 0
    ? ''
    : `${total.toLocaleString()} prompt${total === 1 ? '' : 's'} · ${first}–${last}`;

  // A requested prompt shows once its row is on the page (worked out here, not set by an effect).
  const asked = openAt && openAt !== doneWith ? prompts.find((r) => r.timestamp === openAt.at) ?? null : null;
  const shownRow = openRow ?? asked;
  const closeRow = useCallback(() => {
    setOpenRow(null);
    if (openAt) {
      setDoneWith(openAt);
      onOpenAtDone?.();
    }
  }, [openAt, onOpenAtDone]);
  const openSession = useCallback((id: string) => {
    selectSession(id);
    closeRow();
    navigate('/');
  }, [selectSession, navigate, closeRow]);

  const body = () => {
    if (!host && !session) {
      return <EmptyState fill title="No sessions shared with this phone" hint="Share a session from your Mac to read its prompts here." />;
    }
    if (isError && !data) {
      return (
        <EmptyState
          fill
          tone="error"
          title="Could not load prompts"
          hint={error?.message}
          action={canRetry(error) ? <Button onClick={() => refetch()}>Retry</Button> : undefined}
        />
      );
    }
    if (isLoading) return <EmptyState fill busy title="Loading prompts…" />;
    if (groups.length === 0) {
      return <EmptyState fill title={active > 0 || query ? 'No prompts match' : 'No prompts recorded yet'} />;
    }
    return (
      <>
        {isError && <StaleNote onRetry={canRetry(error) ? () => refetch() : undefined} />}
        {groups.map((group) => (
          <section key={group.day} aria-label={`Prompts on ${group.day}`}>
            <h2 className={styles.groupHeading}>{group.day}</h2>
            <ul className={styles.list} role="list">
              {group.rows.map((row) => (
                <PromptRow
                  key={row.id}
                  row={row}
                  query={query}
                  live={!fixedSession && sessions.has(row.session_id)}
                  showSession={!fixedSession}
                  onOpen={setOpenRow}
                />
              ))}
            </ul>
          </section>
        ))}
      </>
    );
  };

  return (
    <div className={styles.view} data-testid="phone-prompts">
      <PhoneViewBar
        searchLabel={host ? 'Search all prompts' : 'Search this session’s prompts'}
        searchPlaceholder="Search…"
        search={filters.query}
        onSearch={(v) => update('query', v)}
        activeFilters={active}
        onClearFilters={clearFilters}
        summary={summary}
        action={(
          <IconButton
            label="Refresh"
            tooltip={false}
            aria-busy={isFetching || undefined}
            onClick={() => { if (!isFetching) void refetch(); }}
            disabled={!host && !session}
          >
            <RefreshListIcon />
          </IconButton>
        )}
        filters={(
          <>
            {host && (
              <Field label="Project" className={styles.sheetField}>
                <NativeSelect value={filters.project} onChange={(v) => update('project', v)} options={projectOptions} />
              </Field>
            )}
            <fieldset className={styles.sheetFieldset}>
              <legend>Source</legend>
              <div className={styles.choiceRow}>
                {PROMPT_KINDS.map((k) => (
                  <Button key={k.key} pressed={filters.kind === k.key} onClick={() => update('kind', k.key)}>
                    {k.label}
                  </Button>
                ))}
              </div>
              <p className={styles.fieldHint}>{PROMPT_KINDS.find((k) => k.key === filters.kind)?.title}</p>
            </fieldset>
            <div className={styles.sheetPair}>
              <Field label="From" className={styles.sheetField}>
                <PhoneDateInput value={filters.dateFrom} onChange={(v) => update('dateFrom', v)} />
              </Field>
              <Field label="To" className={styles.sheetField}>
                <PhoneDateInput value={filters.dateTo} onChange={(v) => update('dateTo', v)} />
              </Field>
            </div>
          </>
        )}
      >
        {!host && session && !fixedSession && (
          <>
            <Field label="Session" className={styles.inlineField}>
              <NativeSelect value={session} onChange={pickSession} options={sessionOptions} />
            </Field>
            <HostOnlyNote>
              Search across every session&rsquo;s prompts is on your Mac. Here: one shared session at a time.
            </HostOnlyNote>
          </>
        )}
      </PhoneViewBar>
      <div ref={listRef} className={styles.scroll}>
        {body()}
        <Pagination
          page={filters.page}
          totalPages={totalPages}
          onPageChange={(p) => update('page', p)}
          label="Prompt pages"
          className={styles.pager}
        />
      </div>
      {shownRow && (
        <PromptSheet
          row={shownRow}
          query={query}
          live={!fixedSession && sessions.has(shownRow.session_id)}
          onOpenSession={openSession}
          onUseAgain={onUseAgain ? (text) => { closeRow(); onUseAgain(text); } : undefined}
          onClose={closeRow}
        />
      )}
    </div>
  );
}

function PromptRow({ row, query, live, showSession, onOpen }: {
  row: PromptTraceRow;
  query: string;
  live: boolean;
  /** Name the session on the row (not in one session's own tab). */
  showSession: boolean;
  onOpen: (row: PromptTraceRow) => void;
}) {
  const text = row.text ?? '';
  const session = sessionDisplayTitle({ title: row.session_title ?? '', projectName: row.project_name ?? '' });
  const shown = useMemo(() => preview(text, query), [text, query]);
  return (
    <li className={styles.row}>
      <button type="button" className={styles.rowButton} onClick={() => onOpen(row)}>
        <span className={styles.rowTop}>
          <span className={styles.rowMeta}>
            {showSession ? `${formatPromptClock(row.timestamp)} · ${session}` : formatPromptClock(row.timestamp)}
          </span>
          {live && <Chip tone="success">live</Chip>}
        </span>
        <span className={styles.rowText}><Highlighted text={shown} query={query} /></span>
      </button>
    </li>
  );
}

function PromptSheet({ row, query, live, onOpenSession, onUseAgain, onClose }: {
  row: PromptTraceRow;
  query: string;
  live: boolean;
  onOpenSession: (id: string) => void;
  /** Put the prompt back in the composer (one session's tab). */
  onUseAgain?: (text: string) => void;
  onClose: () => void;
}) {
  const saveSnippet = usePromptSnippetStore((s) => s.save);
  const text = row.text ?? '';
  const session = sessionDisplayTitle({ title: row.session_title ?? '', projectName: row.project_name ?? '' });

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      showToast('Prompt copied', 'success');
    } catch {
      showToast('Could not copy to clipboard', 'error');
    }
  };

  const save = async () => {
    const result = await saveSnippet(text);
    if (result.id === null && !result.duplicate) {
      showToast('Could not save this prompt', 'error');
      return;
    }
    showToast(result.duplicate ? 'Already in your saved prompts' : 'Saved to your prompts', result.duplicate ? 'info' : 'success');
  };

  return (
    <BottomSheet open onClose={onClose} title={`Prompt · ${formatPromptClock(row.timestamp)}`} fullHeight className={styles.dress}>
      <div className={styles.detail} data-testid="prompt-detail">
        <div className={styles.detailScroll}>
          <p className={styles.detailMeta}>
            {[
              `${formatDayKey(row.timestamp)}, ${formatPromptExact(row.timestamp)}`,
              row.project_name || 'unknown project',
              session,
              `${text.length.toLocaleString()} chars`,
            ].join(' · ')}
          </p>
          <pre className={styles.fullText}><Highlighted text={text} query={query} /></pre>
        </div>
        <div className={styles.detailActions}>
          <Button onClick={() => void copy()}>Copy</Button>
          <Button onClick={() => void save()}>Save to prompts</Button>
          {live && <Button variant="primary" onClick={() => onOpenSession(row.session_id)}>Open session</Button>}
          {onUseAgain && <Button variant="primary" onClick={() => onUseAgain(text)}>Use again</Button>}
        </div>
      </div>
    </BottomSheet>
  );
}
