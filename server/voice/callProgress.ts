// callProgress.ts — what the call screen shows of the Voice central's work (Nov 22 2026).
//
// The phone hears only OpenAI's transcript, so a minute of the central's tool calls looked like silence. The phone
// now asks the Mac (GET /api/voice/call/:id/progress, voiceRouter.ts) every few seconds while the call is live, and
// this module builds the answer:
//
//   central  its state (working / needs you / idle / offline), the step it is on in plain words, for how long
//            (`elapsedMs`, not a time of day: the phone's clock need not agree with the Mac's)
//   tasks    the sessions it handed work to during this call (task ledger), newest first
//   replies  each reply of the central, word for word (the voice says it in its own words)
//
// A step is a phrase from the tool's name only: never a command, path or id, which the voice rules keep out of the
// call too. The caller passes only tasks whose session the calling device may see (sessionVisibility.ts).

import type { McpTaskState } from '../../src/types/mcpEvents.js';

/** Tasks the screen lists; older ones of the same call are left out. */
export const TASKS_SHOWN = 5;

/** A reply longer than this is cut with an ellipsis (the voice reads it whole). */
export const REPLY_TEXT_MAX = 2_000;

export type CentralState = 'working' | 'needs_you' | 'idle' | 'offline';

export type TaskShownState = 'working' | 'needs_you' | 'stalled' | 'finished' | 'failed' | 'cancelled';

/** The parts of the Voice central's session this reads. */
export interface ProgressCentral {
  title: string;
  status: string;
  toolLog: ReadonlyArray<{ tool: string; timestamp: number }>;
}

/** A task of the Voice central, with its session's display title. */
export interface ProgressTask {
  title: string;
  state: McpTaskState;
  createdAt: number;
}

export interface CallReply {
  at: number;
  text: string;
}

export interface CallProgressView {
  central: { title: string; state: CentralState; step: string | null; elapsedMs: number | null } | null;
  tasks: Array<{ title: string; state: TaskShownState }>;
  replies: CallReply[];
}

export interface CallProgressInput {
  central: ProgressCentral | null;
  /** When the question now with the central was handed over; null when none is. */
  busySince: number | null;
  callStartedAt: number;
  now: number;
  tasks: readonly ProgressTask[];
  replies: readonly CallReply[];
}

/** The central's own AASC tools, by name after `mcp__aasc__` (or `aasc.`). */
const AASC_STEPS: Readonly<Record<string, string>> = {
  session_list: 'Checking your sessions',
  session_get: 'Checking a session',
  session_create: 'Opening a new session',
  scope_get: 'Checking what it may do',
  chat_read: 'Reading a session’s chat',
  task_delegate: 'Handing the work to a session',
  task_send: 'Handing the work to a session',
  prompt_send: 'Sending a prompt',
  task_wait: 'Waiting for a session to finish',
  task_get: 'Checking on a task',
  request_list: 'Checking what needs you',
  confirm_wait: 'Waiting for your approval',
};

/** AASC tool-name prefixes that all read as one kind of step. */
const AASC_PREFIX_STEPS: ReadonlyArray<[string, string]> = [
  ['queue_', 'Updating a queue'],
  ['note', 'Reading notes'],
  ['room', 'Checking rooms'],
  ['resource', 'Checking resources'],
];

const AGENT_STEPS: Readonly<Record<string, string>> = {
  Bash: 'Running a command',
  shell: 'Running a command',
  exec_command: 'Running a command',
  local_shell: 'Running a command',
  unified_exec: 'Running a command',
  Read: 'Reading files',
  Grep: 'Searching files',
  Glob: 'Searching files',
  Edit: 'Editing files',
  MultiEdit: 'Editing files',
  Write: 'Editing files',
  apply_patch: 'Editing files',
  WebFetch: 'Reading a web page',
  WebSearch: 'Searching the web',
  Task: 'Running a helper agent',
  Agent: 'Running a helper agent',
  Skill: 'Using a skill',
};

/** A tool call as a short phrase for the call screen. */
export function stepPhrase(tool: string): string {
  const aasc = /^(?:mcp__aasc__|aasc\.)(.+)$/.exec(tool);
  if (aasc) {
    const name = aasc[1];
    const exact = AASC_STEPS[name];
    if (exact) return exact;
    const byPrefix = AASC_PREFIX_STEPS.find(([prefix]) => name.startsWith(prefix));
    if (byPrefix) return byPrefix[1];
    return `Using AASC: ${name.replace(/_/g, ' ')}`;
  }
  const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__/.exec(tool);
  if (mcp) return `Using ${mcp[1]}`;
  return AGENT_STEPS[tool] ?? 'Working';
}

/** A session status as the call shows it. */
export function centralState(status: string): CentralState {
  if (status === 'approval' || status === 'input') return 'needs_you';
  if (status === 'idle' || status === 'waiting') return 'idle';
  if (status === 'ended') return 'offline';
  return 'working';
}

const TASK_STATES: Readonly<Record<McpTaskState, TaskShownState>> = {
  queued: 'working',
  sent: 'working',
  running: 'working',
  blocked: 'needs_you',
  stalled: 'stalled',
  done: 'finished',
  failed: 'failed',
  cancelled: 'cancelled',
};

function clip(text: string): string {
  const t = text.trim();
  return t.length > REPLY_TEXT_MAX ? `${t.slice(0, REPLY_TEXT_MAX - 1)}…` : t;
}

function centralView(c: ProgressCentral, busySince: number | null, now: number): NonNullable<CallProgressView['central']> {
  const fromStatus = centralState(c.status);
  // A question handed over is work in progress even before the central's first hook arrives.
  const state: CentralState = busySince !== null && fromStatus === 'idle' ? 'working' : fromStatus;
  let step: string | null = null;
  if (state === 'needs_you') step = 'Waiting for your approval';
  else if (busySince !== null && state === 'working') {
    const last = [...c.toolLog].reverse().find((e) => e.timestamp >= busySince);
    step = last ? stepPhrase(last.tool) : 'Thinking';
  }
  return { title: c.title, state, step, elapsedMs: busySince === null ? null : Math.max(0, now - busySince) };
}

export function buildCallProgress(input: CallProgressInput): CallProgressView {
  return {
    central: input.central ? centralView(input.central, input.busySince, input.now) : null,
    tasks: input.tasks
      .filter((t) => t.createdAt >= input.callStartedAt)
      .slice()
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, TASKS_SHOWN)
      .map((t) => ({ title: t.title, state: TASK_STATES[t.state] })),
    replies: input.replies.map((r) => ({ at: r.at, text: clip(r.text) })),
  };
}

/** A session as `collectCallProgress` reads it (a live Session has these fields). */
export interface CollectSession {
  sessionId: string;
  title: string;
  status: string;
  toolLog?: ReadonlyArray<{ tool: string; timestamp: number }>;
}

export interface CollectInput<S extends CollectSession> {
  call: { replies(): readonly CallReply[]; busySince(): number | null };
  startedAt: number;
  now: number;
  /** The Voice central now (findBrain), or null when there is none. */
  central: { centralId: string; sessionId: string } | null;
  /** That central's tasks (the task ledger). */
  tasks(centralId: string): ReadonlyArray<{ sessionId: string; state: McpTaskState; createdAt: number }>;
  getSession(sessionId: string): S | null;
  /** May the calling device see this session (sessionVisibility.ts canSeeSession)? */
  canSee(session: S): boolean;
}

/** The progress view for one call, from the live server's parts; a session the caller may not see is left out. */
export function collectCallProgress<S extends CollectSession>(input: CollectInput<S>): CallProgressView {
  const visible = (id: string): S | null => {
    const s = input.getSession(id);
    return s !== null && input.canSee(s) ? s : null;
  };
  const centralSession = input.central ? visible(input.central.sessionId) : null;
  const tasks: ProgressTask[] = [];
  if (input.central) {
    for (const t of input.tasks(input.central.centralId)) {
      const s = visible(t.sessionId);
      if (s) tasks.push({ title: s.title, state: t.state, createdAt: t.createdAt });
    }
  }
  return buildCallProgress({
    central: centralSession ? { title: centralSession.title, status: centralSession.status, toolLog: centralSession.toolLog ?? [] } : null,
    busySince: input.call.busySince(),
    callStartedAt: input.startedAt,
    now: input.now,
    tasks,
    replies: input.call.replies(),
  });
}
