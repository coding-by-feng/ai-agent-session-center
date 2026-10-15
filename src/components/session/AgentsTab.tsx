/**
 * AgentsTab — the AGENTS detail tab: a live diagram of the agents working for
 * this session (in-process subagents and agent-team teammates) and a log of
 * what each one did, newest first. Read-only. A subagent card opens that
 * agent's own messages in place of the diagram (SubagentDetail); a teammate
 * card switches to the teammate's session.
 *
 * All shaping lives in `lib/agentFlow.ts`; this file only lays it out. The
 * connectors are CSS: a spine from the leader, a bus per row of cards and a
 * stub into each card, dashed lines that flow while that agent is working
 * (still under prefers-reduced-motion).
 */
import { Fragment, useCallback, useEffect, useId, useMemo, useRef, useState, type MouseEvent } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '@/stores/sessionStore';
import { formatDuration } from '@/lib/format';
import {
  buildAgentFlow, teammatesOf, columnsFor, chunkRows, subagentNode, subagentLog,
  AGENT_STATE_GLYPH, AGENT_STATE_LABEL,
  type AgentNode, type AgentState, type FlowLogRow,
} from '@/lib/agentFlow';
import type { Session } from '@/types';
import CopyTextButton from './CopyTextButton';
import SubagentDetail from './SubagentDetail';
import styles from '@/styles/modules/AgentsTab.module.css';

/** Card columns the CSS has rules for (`data-cols`). */
const MAX_COLS = 6;
/** Left inset of the card rows, matching `.tree { margin-left }` in the CSS. */
const TREE_INSET_PX = 40;

const STATE_CLASS: Record<AgentState, string | undefined> = {
  working: styles.stateWorking,
  attention: styles.stateAttention,
  idle: styles.stateIdle,
  done: styles.stateDone,
  ended: styles.stateEnded,
};

const KIND_CLASS = {
  leader: styles.kindLeader,
  subagent: styles.kindSubagent,
  teammate: styles.kindTeammate,
} as const;

const NO_TEAMMATES: Session[] = [];

const TIME_FORMAT: Intl.DateTimeFormatOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false };

/** Elapsed-time clock: every second while something runs, every 15 s otherwise. */
const TICK_ACTIVE_MS = 1000;
const TICK_IDLE_MS = 15_000;

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), active ? TICK_ACTIVE_MS : TICK_IDLE_MS);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

/**
 * The element's width. Measured in the ref callback (commit time, before
 * paint) so the first frame already has its real column count, then kept up
 * to date by a ResizeObserver.
 */
function useWidth(): [number, (el: HTMLElement | null) => void] {
  const [width, setWidth] = useState(0);
  const [el, setEl] = useState<HTMLElement | null>(null);
  const attach = useCallback((node: HTMLElement | null) => {
    setEl(node);
    if (node) setWidth(node.getBoundingClientRect().width);
  }, []);
  useEffect(() => {
    if (!el || typeof ResizeObserver === 'undefined') return undefined;
    const ro = new ResizeObserver(([entry]) => setWidth(entry.contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return [width, attach];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

interface AgentCardProps {
  node: AgentNode;
  now: number;
  /** Makes the card a button (subagents and teammates; the leader is the session itself). */
  onOpen?: (node: AgentNode) => void;
  buttonRef?: (el: HTMLButtonElement | null) => void;
}

function AgentCard({ node, now, onOpen, buttonRef }: AgentCardProps) {
  const elapsed = formatDuration((node.endedAt ?? now) - node.startedAt);
  const label = `${node.name}, ${node.kind}, ${AGENT_STATE_LABEL[node.state]}`;
  // Spans only: the same content sits inside a <button> for an openable card.
  const content = (
    <>
      <span className={styles.cardHead}>
        <span className={styles.cardName} title={node.name}>{node.name}</span>
        <span className={`${styles.state} ${STATE_CLASS[node.state] ?? ''}`}>
          <span aria-hidden="true">{AGENT_STATE_GLYPH[node.state]}</span> {AGENT_STATE_LABEL[node.state]}
        </span>
      </span>
      <span className={styles.cardRole}>
        {node.role}{elapsed ? ` · ${elapsed}` : ''}
      </span>
      {node.tool && (
        <span className={styles.cardTool}>
          <span className={styles.toolName}>{node.tool}</span>
          {node.target && <span className={styles.toolTarget} title={node.target}>{node.target}</span>}
        </span>
      )}
      {node.description && <span className={styles.cardDesc} title={node.description}>{node.description}</span>}
      <span className={styles.cardMeta}>{plural(node.toolCount, 'tool')}</span>
    </>
  );
  if (!onOpen) {
    return <article className={`${styles.card} ${KIND_CLASS[node.kind]}`} aria-label={label}>{content}</article>;
  }
  return (
    <button
      type="button"
      ref={buttonRef}
      className={`${styles.card} ${styles.cardButton} ${KIND_CLASS[node.kind]}`}
      aria-label={label}
      title={node.kind === 'teammate' ? 'Open this teammate’s session' : 'Open this agent’s messages'}
      onClick={() => onOpen(node)}
    >
      {content}
      <span className={styles.cardOpen} aria-hidden="true">›</span>
    </button>
  );
}

/** The detail row names the call's time in full: the cell shows only HH:MM:SS. */
const FULL_TIME_FORMAT: Intl.DateTimeFormatOptions = {
  weekday: 'short', day: 'numeric', month: 'short', year: 'numeric',
  hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
};

/** The server ends a `detail` it had to cut with this (`toolInputDetail` in server/sessionTrim.ts). */
const CUT_MARK = '…';

function LogDetail({ row }: { row: FlowLogRow }) {
  // `detail` is the fuller text the server kept for the newest calls; agents'
  // start/finish rows show the target itself.
  const shown = row.detail ?? row.target;
  const cut = row.detail !== undefined && row.detail.endsWith(CUT_MARK);
  // The marker is for the eye; what is copied is the command.
  const text = cut ? shown.slice(0, -CUT_MARK.length) : shown;
  return (
    <div className={styles.logDetail}>
      <div className={styles.logDetailHead}>
        <span className={styles.logDetailMeta}>
          {row.action} · {row.agent} · {new Date(row.at).toLocaleString([], FULL_TIME_FORMAT)}
        </span>
        <CopyTextButton text={text} />
      </div>
      <pre className={styles.logDetailText}>{shown}</pre>
      {cut && <p className={styles.logDetailNote}>Showing the first {text.length.toLocaleString('en-US')} characters.</p>}
      {row.failed && <p className={styles.logDetailError}>✗ failed{row.error ? ` — ${row.error}` : ''}</p>}
    </div>
  );
}

function LogTable({ rows }: { rows: FlowLogRow[] }) {
  const idBase = useId();
  // Opened rows by key. Rows are keyed by the call, not by their place in the
  // capped tool log (agentFlow.toolKeys), so a row stays open as the log rolls.
  const [open, setOpen] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (key: string) => setOpen((prev) => {
    const next = new Set(prev);
    if (!next.delete(key)) next.add(key);
    return next;
  });
  // A drag-select ends in a click on the row; it must not fold away what the
  // user is selecting. Only a selection INSIDE this row counts: one left in an
  // opened detail must not make every other row ignore its clicks, and a click a
  // keyboard sends (Enter or Space on the button: `detail` 0) never does.
  const onRowClick = (e: MouseEvent<HTMLTableRowElement>, key: string) => {
    const selection = window.getSelection();
    const selectedHere = !!selection && !selection.isCollapsed && !!selection.anchorNode
      && e.currentTarget.contains(selection.anchorNode);
    if (e.detail !== 0 && selectedHere) return;
    toggle(key);
  };
  if (rows.length === 0) return null;
  return (
    <table className={styles.log} aria-label="Agent activity">
      <thead>
        <tr><th scope="col">Time</th><th scope="col">Agent</th><th scope="col">Action</th><th scope="col">Target</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => {
          const openable = r.target !== '';
          const isOpen = openable && open.has(r.key);
          const detailId = `${idBase}-${r.key.replace(/\s/g, '_')}`;
          const classes = [r.failed && styles.logFailed, openable && styles.logOpenable, isOpen && styles.logOpen]
            .filter(Boolean).join(' ');
          return (
            <Fragment key={r.key}>
              {/* One click handler, on the row: the button inside is the keyboard and
                  screen-reader way in, and its click bubbles here exactly once. */}
              <tr className={classes || undefined} onClick={openable ? (e) => onRowClick(e, r.key) : undefined}>
                <td className={styles.logTime}>{new Date(r.at).toLocaleTimeString([], TIME_FORMAT)}</td>
                <td className={`${styles.logAgent} ${KIND_CLASS[r.kind]}`} title={r.agent}>{r.agent}</td>
                {/* The failure mark leads the cell: a trailing "(failed)" was cut off
                    at narrow widths, leaving colour alone to say it. */}
                <td className={styles.logAction}>
                  {r.failed && <span className={styles.failMark} aria-label="failed" title="failed">✗ </span>}
                  {r.action}
                </td>
                <td className={styles.logTarget} title={r.target}>
                  {openable ? (
                    <button type="button" className={styles.logToggle} aria-expanded={isOpen} aria-controls={isOpen ? detailId : undefined}>
                      <span className={styles.chevron} aria-hidden="true">{isOpen ? '▾' : '▸'}</span>
                      <span className={styles.logTargetText}>{r.target}</span>
                    </button>
                  ) : r.target}
                </td>
              </tr>
              {isOpen && (
                <tr id={detailId} className={styles.logDetailRow}>
                  <td colSpan={4} className={styles.logDetailCell}><LogDetail row={r} /></td>
                </tr>
              )}
            </Fragment>
          );
        })}
      </tbody>
    </table>
  );
}

export default function AgentsTab({ sessionId }: { sessionId: string }) {
  const leader = useSessionStore((s) => s.sessions.get(sessionId));
  // Shallow-compared, so another session's update doesn't rebuild the flow.
  const teammates = useSessionStore(useShallow((s) => {
    const self = s.sessions.get(sessionId);
    return self ? teammatesOf(self, s.sessions) : NO_TEAMMATES;
  }));
  const flow = useMemo(
    () => (leader ? buildAgentFlow(leader, teammates) : null),
    [leader, teammates],
  );
  const running = !!flow && (flow.live > 0 || flow.leader.state === 'working');
  const now = useNow(running);
  const [width, setDiagramEl] = useWidth();

  // The subagent whose messages are open, for the session it was opened in:
  // showing another session closes it without an effect.
  const [opened, setOpened] = useState<{ sessionId: string; agentId: string } | null>(null);
  const openId = opened?.sessionId === sessionId ? opened.agentId : null;
  const openNode = useMemo(() => (leader && openId ? subagentNode(leader, openId) : null), [leader, openId]);
  const openRun = openId ? leader?.subagents?.find((r) => r.agentId === openId) : undefined;
  // Every call and the finish change the run: the detail refetches on that.
  const openVersion = openRun ? `${openRun.status}:${openRun.toolCount}:${openRun.lastActivityAt}:${openRun.endedAt ?? ''}` : '';
  const fallbackRows = useMemo(() => (leader && openId ? subagentLog(leader, openId) : []), [leader, openId]);
  // Back puts focus on the card the detail was opened from. Only in that commit:
  // a card no longer drawn must not take focus when it reappears later.
  const returnFocusTo = useRef<string | null>(null);
  useEffect(() => { returnFocusTo.current = null; }, [openId]);

  const openCard = useCallback((node: AgentNode) => {
    if (node.kind === 'teammate') useSessionStore.getState().selectSession(node.id);
    else if (node.kind === 'subagent') setOpened({ sessionId, agentId: node.id });
  }, [sessionId]);
  const closeDetail = useCallback(() => {
    returnFocusTo.current = openId;
    setOpened(null);
  }, [openId]);
  const cardRef = (id: string) => (el: HTMLButtonElement | null) => {
    if (el && returnFocusTo.current === id) {
      returnFocusTo.current = null;
      el.focus();
    }
  };

  if (!flow) return null;

  if (openNode) {
    return (
      <div className={styles.root}>
        <SubagentDetail
          key={`${sessionId}:${openNode.id}`}
          sessionId={sessionId}
          node={openNode}
          version={openVersion}
          now={now}
          onBack={closeDetail}
          fallback={fallbackRows.length > 0 ? <LogTable rows={fallbackRows} /> : null}
        />
      </div>
    );
  }

  const cols = Math.min(MAX_COLS, columnsFor(width - TREE_INSET_PX));
  const rows = chunkRows(flow.agents, cols);
  const isWorking = (n: AgentNode) => n.state === 'working';
  const anyWorking = flow.live > 0;

  return (
    <div className={styles.root}>
      <div className={styles.legend}>
        <span className={`${styles.legendItem} ${styles.kindLeader}`}><span className={styles.swatch} aria-hidden="true" />leader</span>
        <span className={`${styles.legendItem} ${styles.kindSubagent}`}><span className={styles.swatch} aria-hidden="true" />subagent</span>
        <span className={`${styles.legendItem} ${styles.kindTeammate}`}><span className={styles.swatch} aria-hidden="true" />teammate</span>
        <span className={styles.counts}>
          {flow.live} working{flow.waiting > 0 ? ` · ${flow.waiting} waiting on you` : ''} · {flow.finished} finished
        </span>
      </div>

      <section className={styles.diagram} aria-label="Agent diagram" ref={setDiagramEl}>
        <AgentCard node={flow.leader} now={now} />
        {rows.length > 0 && (
          <div className={styles.tree}>
            <span className={styles.trunk} data-link="trunk" data-active={anyWorking} aria-hidden="true" />
            {rows.map((row, i) => (
              <div className={styles.row} data-cols={cols} key={row[0].id}>
                {/* A line flows when a working agent lies beyond it: the spine
                    to any later row, a bus to any card further along its row. */}
                {i < rows.length - 1 && (
                  <span
                    className={styles.spine}
                    data-link="spine"
                    data-active={rows.slice(i + 1).some((r) => r.some(isWorking))}
                    aria-hidden="true"
                  />
                )}
                {row.map((node, j) => (
                  <div className={styles.slot} key={node.id}>
                    <span
                      className={j === 0 ? styles.busFirst : styles.bus}
                      data-link={node.id}
                      data-active={row.slice(j).some(isWorking)}
                      aria-hidden="true"
                    />
                    <span className={styles.stub} data-stub={node.id} data-active={isWorking(node)} aria-hidden="true" />
                    <AgentCard node={node} now={now} onOpen={openCard} buttonRef={cardRef(node.id)} />
                  </div>
                ))}
              </div>
            ))}
          </div>
        )}
        {flow.hiddenFinished > 0 && (
          <p className={styles.note}>{plural(flow.hiddenFinished, 'earlier finished agent')} — see the log below.</p>
        )}
        {flow.agents.length === 0 && (
          <p className={styles.note}>
            {flow.reportsSubagents
              ? 'No subagents or teammates yet. When this session spawns one, it appears here.'
              : 'Codex doesn’t report subagents to AASC, so this session shows as one agent.'}
          </p>
        )}
      </section>

      {/* Keyed by session: opened rows belong to the session they were opened in. */}
      <LogTable key={sessionId} rows={flow.log} />
    </div>
  );
}
