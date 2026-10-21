/**
 * agentFlow — turns one session and the agents working for it into the
 * AGENTS tab's diagram: a leader card, one card per agent, and an activity log.
 *
 * Two kinds of agent reach AASC, by different roads:
 * - in-process subagents (Claude Code's Agent tool) report through the
 *   leader's own hooks; the server keeps them as `session.subagents`
 *   (server/subagentTracker.ts) and tags their tool calls with `agentId`;
 * - agent-team teammates are sessions of their own, linked to the leader by
 *   team (server/teamManager.ts).
 *
 * Pure and import-free apart from types and two pure helpers, so it can be
 * unit-tested and shared without pulling in a store or React.
 */
import type { Session, SessionStatus, SubagentRun, ToolLogEntry } from '@/types';
import { sessionDisplayTitle } from './sessionDisplayTitle';
import { detectCli } from './cliDetect';

export type AgentKind = 'leader' | 'subagent' | 'teammate';
/** `attention` = waiting on the user (approval / a question). */
export type AgentState = 'working' | 'attention' | 'idle' | 'done' | 'ended';

export interface AgentNode {
  id: string;
  kind: AgentKind;
  name: string;
  role: string;
  state: AgentState;
  tool: string | null;
  target: string | null;
  /** A subagent's task, when known. */
  description: string | null;
  toolCount: number;
  startedAt: number;
  endedAt: number | null;
}

export interface FlowLogRow {
  key: string;
  at: number;
  agent: string;
  kind: AgentKind;
  action: string;
  target: string;
  /** The longer text behind `target` (`ToolLogEntry.detail`), when the server kept one. */
  detail?: string;
  /** What went wrong, for a failed call that recorded it. */
  error?: string;
  failed?: boolean;
  /** The leader's subagent run this row belongs to (its calls, its start and finish). */
  agentId?: string;
}

export interface AgentFlow {
  leader: AgentNode;
  agents: AgentNode[];
  log: FlowLogRow[];
  /** Agents working now (not counting the leader). */
  live: number;
  /** Agents waiting on the user (approval / a question). */
  waiting: number;
  /** Agents that have finished (done or ended), shown or not. */
  finished: number;
  /** Finished agents left off the diagram to keep it readable. */
  hiddenFinished: number;
  /** False for a CLI that never reports subagents to AASC (Codex). */
  reportsSubagents: boolean;
}

/** Narrowest an agent card may get before the row wraps. */
export const AGENT_CARD_MIN_PX = 168;
export const AGENT_GAP_PX = 16;
export const LOG_LIMIT = 60;
/** Finished agents kept on the diagram; the log still has all of them. */
export const MAX_FINISHED_CARDS = 6;

/** How each state reads on a card and in the detail view; the glyph carries the colour. */
export const AGENT_STATE_LABEL: Record<AgentState, string> = {
  working: 'working',
  attention: 'waiting on you',
  idle: 'idle',
  done: 'done',
  ended: 'ended',
};

export const AGENT_STATE_GLYPH: Record<AgentState, string> = {
  working: '●',
  attention: '◐',
  idle: '○',
  done: '✓',
  ended: '–',
};

const LEADER_LOG_NAME = 'leader';
const UNKNOWN_SUBAGENT_NAME = 'subagent';
/** The type the server gives a run it never learned the type of. */
const UNKNOWN_RUN_TYPE = 'unknown';

function stateOf(status: SessionStatus, endedState: AgentState): AgentState {
  switch (status) {
    case 'working':
    case 'prompting':
      return 'working';
    case 'approval':
    case 'input':
      return 'attention';
    case 'ended':
      return endedState;
    default:
      return 'idle';
  }
}

/** Tools a session spawns subagents with (`Task` is the pre-2.1 name). */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/**
 * The session's own current call. When a subagent made the newest log entry,
 * the leader's own last call is shown only if it is the spawn it is waiting
 * in (a foreground Agent call). Anything else is from an earlier turn: a
 * background subagent's call also flips the leader back to `working` after
 * its turn ended.
 */
function ownCurrentCall(session: Session): ToolLogEntry | null {
  const log = session.toolLog ?? [];
  const newest = log[log.length - 1];
  if (!newest) return null;
  if (!newest.agentId) return newest;
  for (let i = log.length - 2; i >= 0; i--) {
    if (!log[i].agentId) return SPAWN_TOOLS.has(log[i].tool) ? log[i] : null;
  }
  return null;
}

function sessionNode(session: Session, kind: 'leader' | 'teammate'): AgentNode {
  const state = stateOf(session.status, kind === 'leader' ? 'ended' : 'done');
  const call = state === 'working' ? ownCurrentCall(session) : null;
  const ownCalls = (session.toolLog ?? []).filter((t) => !t.agentId).length;
  const cli = session.cliSource || detectCli(session) || 'claude';
  return {
    id: session.sessionId,
    kind,
    name: kind === 'teammate' ? session.agentName || sessionDisplayTitle(session) : sessionDisplayTitle(session),
    role: kind === 'teammate' ? 'teammate' : [cli, session.model].filter(Boolean).join(' · '),
    state,
    tool: call?.tool ?? null,
    target: call?.input ?? null,
    description: null,
    toolCount: ownCalls,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
  };
}

/**
 * A run as shown. Once the leader has ended, no hook can close its runs any
 * more (a kill or a crash sends none), so one still `working` is `ended`.
 */
function runNode(run: SubagentRun, leaderEnded: boolean): AgentNode {
  const status = leaderEnded && run.status === 'working' ? 'ended' : run.status;
  const working = status === 'working';
  return {
    id: run.agentId,
    kind: 'subagent',
    name: run.agentType,
    role: 'subagent',
    state: status,
    tool: working ? run.currentTool : null,
    target: working ? run.currentTarget : null,
    description: run.description,
    toolCount: run.toolCount,
    startedAt: run.startedAt,
    endedAt: run.endedAt,
  };
}

const isFinished = (n: AgentNode) => n.state === 'done' || n.state === 'ended';

/**
 * A run the server recorded for one of Claude Code's helper forks before it
 * learned to skip them (see finishRun): no type, no tool, no task, finished.
 * Nothing to show or open, so it is left out everywhere.
 */
function isGhostRun(r: SubagentRun): boolean {
  return r.agentType === UNKNOWN_RUN_TYPE && r.toolCount === 0 && !r.description && r.status !== 'working';
}

/** Every working agent, plus the most recently finished few, in start order. */
function visibleAgents(all: AgentNode[]): { shown: AgentNode[]; hidden: number } {
  const finished = all.filter(isFinished).sort((a, b) => (b.endedAt ?? 0) - (a.endedAt ?? 0));
  const keep = new Set(finished.slice(0, MAX_FINISHED_CARDS));
  const shown = all.filter((n) => !isFinished(n) || keep.has(n));
  return { shown, hidden: finished.length - keep.size };
}

function toolRow(entry: ToolLogEntry, key: string, agent: string, kind: AgentKind, agentId?: string): FlowLogRow {
  return {
    key, at: entry.timestamp, agent, kind, action: entry.tool, target: entry.input,
    ...(entry.detail ? { detail: entry.detail } : {}),
    ...(entry.error ? { error: entry.error } : {}),
    ...(entry.failed ? { failed: true } : {}),
    ...(agentId ? { agentId } : {}),
  };
}

/**
 * A key for a tool-log row that belongs to the CALL, not to its place in the
 * array. The server keeps the newest 200 entries by shifting the oldest out, so
 * an index moves every row up by one on every call once the log is full, and an
 * opened row (see AgentsTab) would slide onto a different command. Timestamp and
 * tool identify a call; the counter separates calls of one tool in one millisecond.
 */
function toolKeys(prefix: string, log: readonly ToolLogEntry[]): string[] {
  const seen = new Map<string, number>();
  return log.map((t) => {
    const base = `${prefix}${t.timestamp}:${t.tool}`;
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return `${base}#${n}`;
  });
}

function buildLog(
  leader: Session,
  runs: readonly SubagentRun[],
  teammates: readonly Session[],
  keep: (row: FlowLogRow) => boolean = () => true,
): FlowLogRow[] {
  const typeById = new Map(runs.map((r) => [r.agentId, r.agentType]));
  const rows: FlowLogRow[] = [];

  const leaderLog = leader.toolLog ?? [];
  const leaderKeys = toolKeys('L', leaderLog);
  leaderLog.forEach((t, i) => {
    rows.push(t.agentId
      ? toolRow(t, leaderKeys[i], typeById.get(t.agentId) ?? UNKNOWN_SUBAGENT_NAME, 'subagent', t.agentId)
      : toolRow(t, leaderKeys[i], LEADER_LOG_NAME, 'leader'));
  });
  for (const r of runs) {
    rows.push({
      key: `S${r.agentId}`, at: r.startedAt, agent: r.agentType, kind: 'subagent', action: 'start',
      target: r.description ?? '', agentId: r.agentId,
    });
    if (r.endedAt !== null && r.status !== 'working') {
      rows.push({
        key: `E${r.agentId}`, at: r.endedAt, agent: r.agentType, kind: 'subagent',
        action: r.status, target: `${r.toolCount} tool${r.toolCount === 1 ? '' : 's'}`, agentId: r.agentId,
      });
    }
  }
  for (const mate of teammates) {
    const name = mate.agentName || sessionDisplayTitle(mate);
    const mateTypes = new Map((mate.subagents ?? []).map((r) => [r.agentId, r.agentType]));
    const mateLog = mate.toolLog ?? [];
    const mateKeys = toolKeys(`T${mate.sessionId}:`, mateLog);
    mateLog.forEach((t, i) => rows.push(t.agentId
      ? toolRow(t, mateKeys[i], `${name} › ${mateTypes.get(t.agentId) ?? UNKNOWN_SUBAGENT_NAME}`, 'subagent')
      : toolRow(t, mateKeys[i], name, 'teammate')));
  }
  // Stable for equal timestamps: later-recorded rows first.
  return rows
    .filter(keep)
    .map((row, order) => ({ row, order }))
    .sort((a, b) => b.row.at - a.row.at || b.order - a.order)
    .slice(0, LOG_LIMIT)
    .map(({ row }) => row);
}

export function buildAgentFlow(leader: Session, teammates: readonly Session[]): AgentFlow {
  const runs = (leader.subagents ?? []).filter((r) => !isGhostRun(r));
  const leaderEnded = leader.status === 'ended';
  const all = [
    ...teammates.map((m) => sessionNode(m, 'teammate')),
    ...runs.map((r) => runNode(r, leaderEnded)),
  ].sort((a, b) => a.startedAt - b.startedAt);
  const { shown, hidden } = visibleAgents(all);

  return {
    leader: sessionNode(leader, 'leader'),
    agents: shown,
    log: buildLog(leader, runs, teammates),
    live: all.filter((n) => n.state === 'working').length,
    waiting: all.filter((n) => n.state === 'attention').length,
    finished: all.filter(isFinished).length,
    hiddenFinished: hidden,
    reportsSubagents: detectCli(leader) !== 'codex',
  };
}

/** One of the leader's subagent runs as a card node, or null when it has no such run. */
export function subagentNode(leader: Session, agentId: string): AgentNode | null {
  const run = (leader.subagents ?? []).find((r) => r.agentId === agentId);
  return run ? runNode(run, leader.status === 'ended') : null;
}

/** The log rows of one subagent run (newest first): what the detail view shows without a transcript. */
export function subagentLog(leader: Session, agentId: string): FlowLogRow[] {
  return buildLog(leader, leader.subagents ?? [], [], (row) => row.agentId === agentId);
}

/** The members of the team this session leads (none unless it is a leader). */
export function teammatesOf(session: Session, sessions: ReadonlyMap<string, Session>): Session[] {
  if (session.teamRole !== 'leader' || !session.teamId) return [];
  const out: Session[] = [];
  for (const s of sessions.values()) {
    if (s.sessionId !== session.sessionId && s.teamId === session.teamId && s.teamRole === 'member') out.push(s);
  }
  return out;
}

/** The AGENTS tab badge: subagents working plus teammates working or waiting on you. */
export function countLiveAgents(session: Session | undefined, sessions: ReadonlyMap<string, Session>): number {
  if (!session) return 0;
  const runs = session.status === 'ended' ? 0 : (session.subagents ?? []).filter((r) => r.status === 'working').length;
  const mates = teammatesOf(session, sessions)
    .filter((m) => { const st = stateOf(m.status, 'done'); return st === 'working' || st === 'attention'; })
    .length;
  return runs + mates;
}

export function columnsFor(width: number): number {
  return Math.max(1, Math.floor((width + AGENT_GAP_PX) / (AGENT_CARD_MIN_PX + AGENT_GAP_PX)));
}

export function chunkRows<T>(items: readonly T[], cols: number): T[][] {
  const size = Math.max(1, cols);
  const rows: T[][] = [];
  for (let i = 0; i < items.length; i += size) rows.push(items.slice(i, i + size));
  return rows;
}
