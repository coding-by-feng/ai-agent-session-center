// subagentTracker.ts — the in-process subagents each session is running, for
// the AGENTS tab.
//
// What Claude Code reports (verified against 2.1.293's real payloads):
// SubagentStart/SubagentStop and every tool call made INSIDE a subagent carry
// `agent_id` + `agent_type` under the LEADER's session_id; the leader's own
// events carry neither. The leader's Stop lists still-running subagents in
// `background_tasks`, because a background subagent outlives its leader's turn.
//
// Hooks arrive through detached shells, so any of these can be late, reordered
// or lost. Every step therefore heals rather than trusts: a tool call creates
// the run its SubagentStart never announced, a late SubagentStop upgrades an
// `ended` run to `done`, and the leader's Stop reconciles against the CLI's own
// list of what is still running.
//
// The run logic is pure (no I/O, never mutates its inputs). The only state here
// is the per-session queue of Agent-tool descriptions waiting for their
// SubagentStart, which never leaves the server.

import type { BackgroundTask, SubagentRun } from '../src/types/session.js';

/** Runs kept per session. Working runs always stay; the oldest finished go first. */
export const MAX_SUBAGENT_RUNS = 24;

/** How long a leader's Agent call waits for the SubagentStart it describes. */
export const SPAWN_MATCH_WINDOW_MS = 60_000;

/** Tools the leader uses to spawn a subagent (`Task` is the pre-2.1 name). */
const SPAWN_TOOLS = new Set(['Agent', 'Task']);

/**
 * Cap on an agent id or type. Real ones are ~20 chars, but hook payloads are
 * untrusted (any local process can append to the queue) and these ride on
 * every broadcast of the session.
 */
export const MAX_AGENT_FIELD_CHARS = 128;

/** Agent-call descriptions waiting for their SubagentStart, per session (forged hooks can't grow it). */
export const MAX_PENDING_SPAWNS = 16;

const DEFAULT_SPAWN_TYPE = 'general-purpose';
const UNKNOWN_TYPE = 'unknown';
const MAX_DESCRIPTION_CHARS = 160;

export interface PendingSpawn {
  agentType: string;
  description: string;
  at: number;
}

export interface SubagentIdentity {
  id: string;
  type: string | null;
}

type HookFields = Record<string, unknown>;

function str(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null;
}

/** An id or type: a non-empty string, capped. */
function field(v: unknown): string | null {
  const s = str(v);
  return s && s.slice(0, MAX_AGENT_FIELD_CHARS);
}

function clip(text: string): string {
  return text.length > MAX_DESCRIPTION_CHARS ? `${text.slice(0, MAX_DESCRIPTION_CHARS - 1)}…` : text;
}

/** A description: a non-empty string, clipped; anything else is ignored. */
function describe(v: unknown): string | null {
  const s = str(v);
  return s && clip(s);
}

/**
 * Which subagent fired this hook, or null for the session's own events.
 *
 * The macOS/Linux hook overwrites `agent_id`/`agent_type` with the agent-team
 * env vars (null outside a team) and preserves Claude's originals as
 * `claude_agent_id`/`claude_agent_type`. When those preserved fields exist they
 * are the only truth: falling back to `agent_id` would then read the team
 * identity. Payloads without them (the Windows hook, a hook from before the
 * change) pass Claude's own `agent_id` through untouched.
 */
export function subagentIdentity(hook: HookFields): SubagentIdentity | null {
  const preserved = 'claude_agent_id' in hook;
  const id = field(preserved ? hook.claude_agent_id : hook.agent_id);
  if (!id) return null;
  // A teammate session's own team identity is not a subagent of itself.
  if (preserved && field(hook.agent_id) === id) return null;
  const type = field(preserved ? hook.claude_agent_type : hook.agent_type);
  return { id, type };
}

function freshRun(agentId: string, agentType: string | null, at: number): SubagentRun {
  return {
    agentId,
    agentType: agentType ?? UNKNOWN_TYPE,
    description: null,
    descriptionConfirmed: false,
    status: 'working',
    startedAt: at,
    endedAt: null,
    lastActivityAt: at,
    toolCount: 0,
    currentTool: null,
    currentTarget: null,
  };
}

function withoutStale(pending: readonly PendingSpawn[], at: number): PendingSpawn[] {
  return pending.filter((p) => at - p.at <= SPAWN_MATCH_WINDOW_MS);
}

/** Queue the description of a leader's Agent call for the SubagentStart that follows it. */
export function noteSpawn(pending: readonly PendingSpawn[], toolInput: unknown, at: number): PendingSpawn[] {
  const kept = withoutStale(pending, at);
  if (!toolInput || typeof toolInput !== 'object') return kept;
  const input = toolInput as HookFields;
  const description = describe(input.description);
  if (!description) return kept;
  return [...kept, { agentType: field(input.subagent_type) ?? DEFAULT_SPAWN_TYPE, description, at }].slice(-MAX_PENDING_SPAWNS);
}

/**
 * Pin a description from an id-keyed source onto its run. A FIFO guess is
 * replaced; if another run was holding this description as ITS guess (two
 * parallel spawns of one type started in the other order), it takes the
 * displaced guess instead, which swaps the pair back. A confirmed description
 * is never overwritten.
 */
export function confirmDescription(
  runs: readonly SubagentRun[],
  agentId: string,
  description: string,
): SubagentRun[] {
  const target = runs.find((r) => r.agentId === agentId);
  if (!target || target.descriptionConfirmed) return runs as SubagentRun[];
  const displaced = target.description;
  const holder = runs.find((r) => r !== target && !r.descriptionConfirmed && r.description === description);
  return runs.map((r) => {
    if (r === target) return { ...r, description, descriptionConfirmed: true };
    if (r === holder) return { ...r, description: displaced };
    return r;
  });
}

export function startRun(
  runs: readonly SubagentRun[],
  pending: readonly PendingSpawn[],
  { agentId, agentType, at }: { agentId: string; agentType: string | null; at: number },
): { runs: SubagentRun[]; pending: PendingSpawn[] } {
  const live = withoutStale(pending, at);
  const existing = runs.find((r) => r.agentId === agentId);
  // Its launch (or its first tool call) may have beaten its SubagentStart here.
  // One that already knows its task must not spend the next run's description.
  if (existing?.description) {
    return {
      runs: runs.map((r) => (r === existing ? { ...r, agentType: agentType ?? r.agentType } : r)),
      pending: live,
    };
  }
  const matchIdx = live.findIndex((p) => p.agentType === (agentType ?? DEFAULT_SPAWN_TYPE));
  const description = matchIdx >= 0 ? live[matchIdx].description : null;
  const nextPending = matchIdx >= 0 ? live.filter((_, i) => i !== matchIdx) : live;
  if (existing) {
    return {
      runs: runs.map((r) => (r === existing ? { ...r, agentType: agentType ?? r.agentType, description } : r)),
      pending: nextPending,
    };
  }
  const run = { ...freshRun(agentId, agentType, at), description };
  return { runs: capRuns([...runs, run]), pending: nextPending };
}

export function recordToolCall(
  runs: readonly SubagentRun[],
  identity: SubagentIdentity,
  tool: string,
  target: string | null,
  at: number,
): { runs: SubagentRun[]; matched: boolean } {
  const existing = runs.find((r) => r.agentId === identity.id);
  if (!existing) {
    // Its SubagentStart was lost or is still on the way. Without a type it
    // could be anything (a teammate's own id, say), so don't invent a run.
    if (!identity.type) return { runs: [...runs], matched: false };
    const run = { ...freshRun(identity.id, identity.type, at), toolCount: 1, currentTool: tool, currentTarget: target };
    return { runs: capRuns([...runs, run]), matched: true };
  }
  return {
    runs: runs.map((r) => {
      if (r.agentId !== identity.id) return r;
      // A straggler hook after SubagentStop changes nothing; an `ended` run
      // that is still calling tools was closed too early, so reopen it.
      if (r.status === 'done') return r;
      return {
        ...r,
        status: 'working' as const,
        endedAt: null,
        toolCount: r.toolCount + 1,
        currentTool: tool,
        currentTarget: target,
        lastActivityAt: at,
      };
    }),
    matched: true,
  };
}

/** A `background_tasks` subagent entry, with every field checked and capped. */
interface ListedSubagent {
  id: string;
  agentType: string | null;
  running: boolean;
  description: string | null;
}

function backgroundSubagents(background: unknown): ListedSubagent[] | null {
  if (!Array.isArray(background)) return null;
  const out: ListedSubagent[] = [];
  for (const t of background as unknown[]) {
    if (!t || typeof t !== 'object') continue;
    const task = t as BackgroundTask;
    const id = field(task.id);
    if (task.type !== 'subagent' || !id) continue;
    const status = str(task.status);
    out.push({ id, agentType: field(task.agent_type), running: !status || status === 'running', description: describe(task.description) });
  }
  return out;
}

function finish(run: SubagentRun, status: 'done' | 'ended', at: number): SubagentRun {
  return { ...run, status, endedAt: at, currentTool: null, currentTarget: null };
}

export function finishRun(
  runs: readonly SubagentRun[],
  identity: SubagentIdentity | null,
  at: number,
  background?: unknown,
): SubagentRun[] {
  if (!identity) {
    // No id to go by: close the oldest run still working.
    const oldest = runs.find((r) => r.status === 'working');
    return runs.map((r) => (r === oldest ? finish(r, 'done', at) : r));
  }
  const description = backgroundSubagents(background)?.find((t) => t.id === identity.id)?.description ?? null;

  if (!runs.some((r) => r.agentId === identity.id)) {
    const run = { ...freshRun(identity.id, identity.type, at), description, descriptionConfirmed: description !== null };
    return capRuns([...runs, finish(run, 'done', at)]);
  }
  const finished = runs.map((r) => (r.agentId === identity.id && r.status !== 'done' ? finish(r, 'done', at) : r));
  return description ? confirmDescription(finished, identity.id, description) : finished;
}

/**
 * The leader's Stop: everything the CLI still lists as running stays working,
 * and every other working run is closed as `ended` (its SubagentStop, if it
 * ever comes, upgrades it to `done`). A listed subagent never seen starting is
 * added. Without a `background_tasks` array the CLI didn't say, so nothing changes.
 */
export function reconcileWithBackground(
  runs: readonly SubagentRun[],
  background: unknown,
  at: number,
): SubagentRun[] {
  const listed = backgroundSubagents(background);
  if (!listed) return runs as SubagentRun[];
  const running = new Map(listed.filter((t) => t.running).map((t) => [t.id, t]));

  let updated = runs.map((r) => (r.status === 'working' && !running.has(r.agentId) ? finish(r, 'ended', at) : r));
  for (const task of running.values()) {
    if (task.description) updated = confirmDescription(updated, task.id, task.description);
  }
  const known = new Set(runs.map((r) => r.agentId));
  const added = [...running.values()]
    .filter((t) => !known.has(t.id))
    .map((t) => ({ ...freshRun(t.id, t.agentType, at), description: t.description, descriptionConfirmed: t.description !== null }));
  return added.length > 0 ? capRuns([...updated, ...added]) : updated;
}

/** A session (re)start or end: nothing from before can still be running under it. */
export function endAllRuns(runs: readonly SubagentRun[], at: number): SubagentRun[] {
  return runs.map((r) => (r.status === 'working' ? finish(r, 'ended', at) : r));
}

export function capRuns(runs: readonly SubagentRun[]): SubagentRun[] {
  if (runs.length <= MAX_SUBAGENT_RUNS) return [...runs];
  let excess = runs.length - MAX_SUBAGENT_RUNS;
  const drop = new Set<SubagentRun>();
  for (const r of runs) {
    if (excess === 0) break;
    if (r.status !== 'working') {
      drop.add(r);
      excess--;
    }
  }
  return runs.filter((r) => !drop.has(r));
}

// ---------------------------------------------------------------------------
// Event dispatch (the one stateful seam: pending Agent-call descriptions)
// ---------------------------------------------------------------------------

const pendingBySession = new Map<string, PendingSpawn[]>();

export function forgetSubagentSession(sessionId: string): void {
  pendingBySession.delete(sessionId);
}

/**
 * Apply one hook event to a session's subagent runs. `toolTarget` is the
 * summarized tool input the tool log already computed. `toolAgentId` is the
 * subagent a PreToolUse belongs to, or null for the session's own call.
 */
export function trackSubagentEvent(
  sessionId: string,
  runs: readonly SubagentRun[],
  event: string,
  hook: HookFields,
  toolTarget: string | null,
  at: number,
): { runs: SubagentRun[]; toolAgentId: string | null } {
  const same = { runs: runs as SubagentRun[], toolAgentId: null };
  switch (event) {
    case 'SessionStart':
    case 'SessionEnd':
      forgetSubagentSession(sessionId);
      return { runs: endAllRuns(runs, at), toolAgentId: null };

    case 'PreToolUse': {
      const identity = subagentIdentity(hook);
      const tool = str(hook.tool_name) ?? 'Unknown';
      if (identity) {
        const r = recordToolCall(runs, identity, tool, toolTarget, at);
        return { runs: r.runs, toolAgentId: r.matched ? identity.id : null };
      }
      if (SPAWN_TOOLS.has(tool)) {
        pendingBySession.set(sessionId, noteSpawn(pendingBySession.get(sessionId) ?? [], hook.tool_input, at));
      }
      return same;
    }

    case 'PostToolUse': {
      // The leader's Agent call returns the new agent's id with its task:
      // the one exact id → description binding Claude Code gives.
      if (subagentIdentity(hook) || !SPAWN_TOOLS.has(str(hook.tool_name) ?? '')) return same;
      const response = hook.tool_response;
      if (!response || typeof response !== 'object') return same;
      const result = response as HookFields;
      const agentId = field(result.agentId);
      if (!agentId) return same;
      const input = hook.tool_input && typeof hook.tool_input === 'object' ? hook.tool_input as HookFields : {};
      const description = describe(result.description) ?? describe(input.description);
      if (runs.some((r) => r.agentId === agentId)) {
        return { runs: description ? confirmDescription(runs, agentId, description) : runs as SubagentRun[], toolAgentId: null };
      }
      // A synchronous call returns after its agent finished: nothing to start.
      if (str(result.status) !== 'async_launched') return same;
      const agentType = field(input.subagent_type) ?? DEFAULT_SPAWN_TYPE;
      // It is about to start: take its own queued description out, so the
      // FIFO queue stays aligned for the spawns still waiting.
      const pending = pendingBySession.get(sessionId) ?? [];
      const own = pending.findIndex((p) => p.agentType === agentType && p.description === description);
      if (own >= 0) pendingBySession.set(sessionId, pending.filter((_, i) => i !== own));
      const run = { ...freshRun(agentId, agentType, at), description, descriptionConfirmed: description !== null };
      return { runs: capRuns([...runs, run]), toolAgentId: null };
    }

    case 'SubagentStart': {
      const identity = subagentIdentity(hook);
      if (!identity) return same;
      const r = startRun(runs, pendingBySession.get(sessionId) ?? [], { agentId: identity.id, agentType: identity.type, at });
      pendingBySession.set(sessionId, r.pending);
      return { runs: r.runs, toolAgentId: null };
    }

    case 'SubagentStop':
      return { runs: finishRun(runs, subagentIdentity(hook), at, hook.background_tasks), toolAgentId: null };

    case 'Stop':
      return { runs: reconcileWithBackground(runs, hook.background_tasks, at), toolAgentId: null };

    default:
      return same;
  }
}
