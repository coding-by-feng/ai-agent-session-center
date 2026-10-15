/**
 * SubagentDetail — one subagent of the AGENTS tab, opened from its card: the
 * task the leader gave it, what it said and every tool call it made (each
 * opens to its input and output), and its result once it is done.
 *
 * Read from the subagent's own transcript, a page at a time from the end
 * (lib/subagentTranscript.ts). It refetches when the run changes, which is
 * every call it makes and its finish (`version`), so a working agent's view
 * keeps up without a timer. Lazy with the rest of the AGENTS tab.
 */
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import Button from '@/components/ui/Button';
import SectionHeader from '@/components/ui/SectionHeader';
import { showToast } from '@/components/ui/ToastContainer';
import { formatDuration } from '@/lib/format';
import { AGENT_STATE_GLYPH, AGENT_STATE_LABEL, type AgentNode } from '@/lib/agentFlow';
import {
  buildMessageRows, earlierCursor, fetchSubagentTranscript, finalReply, formatToolInput, hasEarlier,
  mergeLatest, prependOlder, refreshQuery, viewEntries, viewOf,
  type MessageRow, type TranscriptView,
} from '@/lib/subagentTranscript';
import CopyTextButton from './CopyTextButton';
import styles from '@/styles/modules/SubagentDetail.module.css';

/** Quiet time after the run's last change before refetching (calls come in bursts). */
export const REFRESH_DEBOUNCE_MS = 600;
/** A task longer than this is clamped until "Show all". */
const TASK_CLAMP_CHARS = 400;
const TASK_CLAMP_LINES = 6;

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };
const timeOf = (at: number) => new Date(at).toLocaleTimeString([], TIME_FORMAT);

type Load =
  | { state: 'loading' }
  | { state: 'ready' }
  | { state: 'missing' }
  | { state: 'error'; message: string };

type Filter = 'all' | 'replies';

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

const oneLine = (text: string) => text.replace(/\s+/g, ' ').trim();

/** `mcp__krt__item_get` reads as `item_get` (the full name is its title), as Claude Code shows it. */
const shortToolName = (tool: string) => (tool.startsWith('mcp__') ? tool.split('__').slice(2).join('__') || tool : tool);

/** A row that opens: a tool call, a result on its own, or text the harness injected. */
function OpenableItem({ row, open, onToggle, agentWorking }: {
  row: Exclude<MessageRow, { kind: 'reply' }>;
  open: boolean;
  onToggle: () => void;
  agentWorking: boolean;
}) {
  const panelId = useId();
  const failed = (row.kind === 'tool' || row.kind === 'result') && row.failed;
  const label = row.kind === 'tool' ? shortToolName(row.tool) : row.kind === 'result' ? 'result' : 'system';
  const summary = row.kind === 'tool' ? row.summary : oneLine(row.kind === 'result' ? row.output : row.text);
  return (
    <li className={`${styles.item}${failed ? ` ${styles.failed}` : ''}`}>
      <span className={styles.time}>{timeOf(row.at)}</span>
      <div className={styles.main}>
        <button
          type="button"
          className={styles.toggle}
          aria-expanded={open}
          aria-controls={open ? panelId : undefined}
          onClick={onToggle}
        >
          <span className={styles.label} title={row.kind === 'tool' ? row.tool : undefined}>
            {/* The failure mark leads, as in the log: colour never says it alone. */}
            {failed && <><span className={styles.failMark} aria-label="failed" title="failed">✗</span>{' '}</>}
            <span className={styles.chevron} aria-hidden="true">{open ? '▾' : '▸'}</span>
            {label}
          </span>
          {/* The space keeps the button's name "Read /x/a.ts", not "Read/x/a.ts". */}
          {' '}
          <span className={styles.summary}>{summary}</span>
        </button>
        {open && (
          <div id={panelId} className={styles.body}>
            {row.kind === 'tool' && (
              <>
                <div className={styles.bodyHead}>
                  <span>Input</span>
                  <CopyTextButton text={row.input} ariaLabel="Copy the input" />
                </div>
                <pre className={styles.pre}>{formatToolInput(row.input)}</pre>
                {row.output !== null ? (
                  <>
                    <div className={styles.bodyHead}>
                      <span>{row.failed ? 'Error' : 'Output'}</span>
                      <CopyTextButton text={row.output} ariaLabel="Copy the output" />
                    </div>
                    <pre className={styles.pre}>{row.output}</pre>
                  </>
                ) : (
                  <p className={styles.note}>{agentWorking ? 'No output yet: still running.' : 'No output was recorded.'}</p>
                )}
              </>
            )}
            {row.kind === 'result' && (
              <>
                <p className={styles.note}>Its call is further up: load earlier messages to see it.</p>
                <pre className={styles.pre}>{row.output}</pre>
              </>
            )}
            {row.kind === 'message' && <pre className={styles.pre}>{row.text}</pre>}
          </div>
        )}
      </div>
    </li>
  );
}

function TextItem({ row }: { row: Extract<MessageRow, { kind: 'reply' | 'message' }> }) {
  return (
    <li className={styles.item}>
      <span className={styles.time}>{timeOf(row.at)}</span>
      <div className={`${styles.main} ${styles.textRow}`}>
        <span className={styles.label}>{row.kind === 'reply' ? 'reply' : 'message'}</span>
        <p className={styles.text}>{row.text}</p>
      </div>
    </li>
  );
}

interface SubagentDetailProps {
  sessionId: string;
  node: AgentNode;
  /** Changes whenever the run does (a call, its finish): the cue to fetch again. */
  version: string;
  now: number;
  onBack: () => void;
  /** Shown when the run has no transcript: its rows from the activity log (null when it has none). */
  fallback: ReactNode;
}

export default function SubagentDetail({ sessionId, node, version, now, onBack, fallback }: SubagentDetailProps) {
  const titleId = useId();
  const taskId = useId();
  const rootRef = useRef<HTMLElement>(null);
  const backRef = useRef<HTMLButtonElement>(null);
  const [view, setView] = useState<TranscriptView | null>(null);
  // The fetches read and extend what is loaded; the ref keeps that current between renders.
  const viewRef = useRef<TranscriptView | null>(null);
  const [load, setLoad] = useState<Load>({ state: 'loading' });
  const [attempt, setAttempt] = useState(0);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  const earlierAbort = useRef<AbortController | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const [taskOpen, setTaskOpen] = useState(false);

  const show = useCallback((next: TranscriptView | null) => {
    viewRef.current = next;
    setView(next);
  }, []);

  useEffect(() => { backRef.current?.focus(); }, []);
  useEffect(() => () => earlierAbort.current?.abort(), []);

  // First load at once; after that, once the run has been quiet for a moment.
  useEffect(() => {
    const ctrl = new AbortController();
    const timer = setTimeout(async () => {
      const query = refreshQuery(viewRef.current);
      const res = await fetchSubagentTranscript(sessionId, node.id, query, ctrl.signal);
      if (ctrl.signal.aborted) return;
      // "Load earlier" landed while this newest page was on its way: put in, it
      // would sit above a gap. Ask again, from the start of what is loaded.
      if (query.from === undefined && viewRef.current?.olderStart != null) {
        setAttempt((n) => n + 1);
        return;
      }
      if (!res.ok) {
        // A failed refresh keeps what is on screen; only a first load shows the error.
        if (!viewRef.current) setLoad({ state: 'error', message: res.error });
        return;
      }
      if (!res.page) {
        show(null);
        setLoad({ state: 'missing' });
        return;
      }
      show(viewRef.current ? mergeLatest(viewRef.current, res.page) : viewOf(res.page));
      setLoad({ state: 'ready' });
    }, viewRef.current ? REFRESH_DEBOUNCE_MS : 0);
    return () => {
      ctrl.abort();
      clearTimeout(timer);
    };
  }, [sessionId, node.id, version, attempt, show]);

  const retry = () => {
    setLoad({ state: 'loading' });
    setAttempt((n) => n + 1);
  };

  const loadEarlier = async (retried = false) => {
    const current = viewRef.current;
    if (!current || (loadingEarlier && !retried)) return;
    const cursor = earlierCursor(current);
    const ctrl = new AbortController();
    earlierAbort.current = ctrl;
    setLoadingEarlier(true);
    const res = await fetchSubagentTranscript(sessionId, node.id, { before: cursor }, ctrl.signal);
    if (ctrl.signal.aborted) return;
    setLoadingEarlier(false);
    if (!res.ok || !res.page) {
      showToast('Could not load earlier messages', 'error');
      return;
    }
    // A refresh that landed meanwhile moved the top: this page no longer joins it. Ask
    // once more from the new top rather than dropping the click.
    const latest = viewRef.current;
    if (!latest) return;
    if (earlierCursor(latest) !== cursor) {
      if (!retried) void loadEarlier(true);
      return;
    }
    show(prependOlder(latest, res.page));
    // The first page has no "Load earlier": focus it had would fall to <body>, out of
    // reach of Esc. It stays in the view instead.
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) rootRef.current?.focus({ preventScroll: true });
    });
  };

  const onKeyDown = (e: KeyboardEvent<HTMLElement>) => {
    if (e.key !== 'Escape') return;
    // Back to the diagram, and no further: the panel's own Escape would act on the same key.
    e.stopPropagation();
    onBack();
  };

  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });

  const entries = useMemo(() => (view ? viewEntries(view) : []), [view]);
  const result = node.state === 'done' ? finalReply(entries) : null;
  const rows = useMemo(() => {
    const all = buildMessageRows(entries);
    // The result has its own section below; the list does not say it twice.
    let resultRow = -1;
    if (result !== null) for (let i = all.length - 1; i >= 0 && resultRow < 0; i--) if (all[i].kind === 'reply') resultRow = i;
    return all.filter((row, i) => i !== resultRow
      && (filter === 'all' || row.kind === 'reply' || (row.kind === 'message' && !row.injected)));
  }, [entries, result, filter]);

  const task = view?.latest.task ?? node.description;
  const longTask = !!task && (task.length > TASK_CLAMP_CHARS || task.split('\n').length > TASK_CLAMP_LINES);
  const elapsed = formatDuration((node.endedAt ?? now) - node.startedAt);
  const working = node.state === 'working';

  return (
    <section ref={rootRef} tabIndex={-1} className={styles.root} aria-labelledby={titleId} onKeyDown={onKeyDown}>
      <div className={styles.topBar}>
        <Button ref={backRef} size="sm" icon="←" onClick={onBack} aria-label="Back to all agents">Agents</Button>
      </div>

      <header className={styles.head}>
        <div className={styles.titleRow}>
          <h3 id={titleId} className={styles.name}>{node.name}</h3>
          <span className={styles.state} data-state={node.state}>
            <span aria-hidden="true">{AGENT_STATE_GLYPH[node.state]}</span> {AGENT_STATE_LABEL[node.state]}
          </span>
        </div>
        <p className={styles.meta}>
          {[node.role, elapsed, plural(node.toolCount, 'tool'), `started ${timeOf(node.startedAt)}`].filter(Boolean).join(' · ')}
        </p>
        {/* Without a transcript the Task below is this same description: say it once. */}
        {node.description && node.description !== task && <p className={styles.description}>{node.description}</p>}
      </header>

      <section className={styles.section} aria-label="Task">
        <SectionHeader level={4} label="Task" aside={task ? <CopyTextButton text={task} ariaLabel="Copy the task" /> : undefined} />
        {task ? (
          <>
            {/* The clamp is on the inner text: on the padded box, overflow would show in the padding. */}
            <div className={styles.task}>
              <p id={taskId} className={`${styles.taskText}${longTask && !taskOpen ? ` ${styles.clamped}` : ''}`}>{task}</p>
            </div>
            {longTask && (
              <Button size="sm" className={styles.inlineButton} aria-expanded={taskOpen} aria-controls={taskId} onClick={() => setTaskOpen((v) => !v)}>
                {taskOpen ? 'Show less' : 'Show all'}
              </Button>
            )}
          </>
        ) : (
          <p className={styles.note}>Not recorded.</p>
        )}
      </section>

      {load.state === 'loading' && <p className={styles.note} role="status">Loading messages…</p>}

      {load.state === 'error' && (
        <div className={styles.errorBox} role="alert">
          <p className={styles.errorText}>Couldn’t load this agent’s messages: {load.message}</p>
          <Button size="sm" onClick={retry}>Try again</Button>
        </div>
      )}

      {load.state === 'missing' && (
        <>
          <p className={styles.note}>
            No transcript for this agent{working ? ' yet' : ''}.{fallback ? ' Its calls from the activity log:' : ''}
          </p>
          {fallback}
        </>
      )}

      {load.state === 'ready' && view && (
        <section className={styles.section} aria-label="Messages">
          <SectionHeader
            level={4}
            label="Messages"
            count={rows.length}
            countLabel={plural(rows.length, 'message')}
            aside={(
              <span className={styles.filters} role="group" aria-label="Show">
                <Button size="sm" pressed={filter === 'all'} onClick={() => setFilter('all')}>All</Button>
                <Button size="sm" pressed={filter === 'replies'} onClick={() => setFilter('replies')}>Replies</Button>
              </span>
            )}
          />
          {hasEarlier(view) && (
            <Button size="sm" className={styles.inlineButton} onClick={() => loadEarlier()} disabled={loadingEarlier}>
              {loadingEarlier ? 'Loading…' : 'Load earlier'}
            </Button>
          )}
          {rows.length > 0 ? (
            <ol className={styles.messages}>
              {rows.map((row) => (row.kind === 'reply' || (row.kind === 'message' && !row.injected)
                ? <TextItem key={row.key} row={row} />
                : <OpenableItem key={row.key} row={row} open={open.has(row.key)} onToggle={() => toggle(row.key)} agentWorking={working} />))}
            </ol>
          ) : (
            <p className={styles.note}>{filter === 'replies' ? 'No replies here yet.' : 'Nothing here yet.'}</p>
          )}
          {working && (
            <p className={styles.live}><span aria-hidden="true">●</span> working: new messages appear as it runs</p>
          )}
        </section>
      )}

      {result !== null && (
        <section className={styles.section} aria-label="Result">
          <SectionHeader level={4} label="Result" aside={<CopyTextButton text={result} ariaLabel="Copy the result" />} />
          <p className={styles.result}>{result}</p>
        </section>
      )}
    </section>
  );
}
