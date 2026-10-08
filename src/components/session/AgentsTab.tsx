/**
 * AgentsTab — the AGENTS detail tab: a live diagram of the agents working for
 * this session (in-process subagents and agent-team teammates) and a log of
 * what each one did, newest first. Read-only.
 *
 * All shaping lives in `lib/agentFlow.ts`; this file only lays it out. The
 * connectors are CSS: a spine from the leader, a bus per row of cards and a
 * stub into each card, dashed lines that flow while that agent is working
 * (still under prefers-reduced-motion).
 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useSessionStore } from '@/stores/sessionStore';
import { formatDuration } from '@/lib/format';
import {
  buildAgentFlow, teammatesOf, columnsFor, chunkRows,
  type AgentNode, type AgentState, type FlowLogRow,
} from '@/lib/agentFlow';
import type { Session } from '@/types';
import styles from '@/styles/modules/AgentsTab.module.css';

/** Card columns the CSS has rules for (`data-cols`). */
const MAX_COLS = 6;
/** Left inset of the card rows, matching `.tree { margin-left }` in the CSS. */
const TREE_INSET_PX = 40;

const STATE_LABEL: Record<AgentState, string> = {
  working: 'working',
  attention: 'waiting on you',
  idle: 'idle',
  done: 'done',
  ended: 'ended',
};

const STATE_GLYPH: Record<AgentState, string> = {
  working: '●',
  attention: '◐',
  idle: '○',
  done: '✓',
  ended: '–',
};

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

function AgentCard({ node, now }: { node: AgentNode; now: number }) {
  const elapsed = formatDuration((node.endedAt ?? now) - node.startedAt);
  return (
    <article
      className={`${styles.card} ${KIND_CLASS[node.kind]}`}
      aria-label={`${node.name}, ${node.kind}, ${STATE_LABEL[node.state]}`}
    >
      <header className={styles.cardHead}>
        <span className={styles.cardName} title={node.name}>{node.name}</span>
        <span className={`${styles.state} ${STATE_CLASS[node.state] ?? ''}`}>
          <span aria-hidden="true">{STATE_GLYPH[node.state]}</span> {STATE_LABEL[node.state]}
        </span>
      </header>
      <div className={styles.cardRole}>
        {node.role}{elapsed ? ` · ${elapsed}` : ''}
      </div>
      {node.tool && (
        <div className={styles.cardTool}>
          <span className={styles.toolName}>{node.tool}</span>
          {node.target && <span className={styles.toolTarget} title={node.target}>{node.target}</span>}
        </div>
      )}
      {node.description && <p className={styles.cardDesc} title={node.description}>{node.description}</p>}
      <div className={styles.cardMeta}>{plural(node.toolCount, 'tool')}</div>
    </article>
  );
}

function LogTable({ rows }: { rows: FlowLogRow[] }) {
  if (rows.length === 0) return null;
  return (
    <table className={styles.log} aria-label="Agent activity">
      <thead>
        <tr><th scope="col">Time</th><th scope="col">Agent</th><th scope="col">Action</th><th scope="col">Target</th></tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.key} className={r.failed ? styles.logFailed : undefined}>
            <td className={styles.logTime}>{new Date(r.at).toLocaleTimeString([], TIME_FORMAT)}</td>
            <td className={`${styles.logAgent} ${KIND_CLASS[r.kind]}`} title={r.agent}>{r.agent}</td>
            {/* The failure mark leads the cell: a trailing "(failed)" was cut off
                at narrow widths, leaving colour alone to say it. */}
            <td className={styles.logAction}>
              {r.failed && <span className={styles.failMark} aria-label="failed" title="failed">✗ </span>}
              {r.action}
            </td>
            <td className={styles.logTarget} title={r.target}>{r.target}</td>
          </tr>
        ))}
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

  if (!flow) return null;

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
                    <AgentCard node={node} now={now} />
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

      <LogTable rows={flow.log} />
    </div>
  );
}
