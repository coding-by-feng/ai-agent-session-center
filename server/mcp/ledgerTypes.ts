// ledgerTypes.ts — the task ledger's types (ledger.ts holds the ledger itself and re-exports these).

import type { ChatEntry } from '../../src/types/chat.js';
import type { McpTaskRoute, McpTaskState } from '../../src/types/mcpEvents.js';
import type { Session } from '../../src/types/session.js';
import type { HookSignal } from '../hookSignals.js';
import type { CentralRecord } from './types.js';

export type TaskState = McpTaskState;

/** How AASC routed a task itself (`task_delegate` to "auto", Ruling P4-7): its decision, in its own words. */
export type TaskRoute = McpTaskRoute;

export interface TaskHistoryEntry {
  at: number;
  state: TaskState;
  /** Why, in AASC's words. */
  note: string;
}

export interface TaskRecord {
  /** `T<n>`: never reused, a new server run counts on from the last one's (Ruling 49). */
  taskId: string;
  centralId: string;
  /** The worker's id now: it follows a re-key (from the hook's own session id). */
  sessionId: string;
  /** The worker's terminal: one terminal is one card, whatever its id. */
  terminalId: string;
  /** The task as the central wrote it (fence it when echoing it back to a central: Ruling 28). */
  task: string;
  answerFormat: string | null;
  state: TaskState;
  createdAt: number;
  /** When the prompt route took the prompt; the floor for a cancel and for the answer. */
  sentAt: number | null;
  updatedAt: number;
  /** The prompt route's request key for this task's prompt. */
  promptKey: string;
  /** The answer, fenced as untrusted; null until done (and when the session wrote none). */
  answer: string | null;
  /** The answer was longer than ANSWER_MAX and is cut there (Ruling 48). */
  answerTruncated: boolean;
  /** Why it failed, in AASC's words. */
  error: string | null;
  history: ReadonlyArray<TaskHistoryEntry>;
  /** How AASC routed it; null when the central named the session. */
  route: TaskRoute | null;
  /** The session it was re-routed from, once, after that session's terminal closed (Ruling P4-7); else null. */
  retargetedFrom: string | null;
}

/** How a prompt's send ended, as GET /sessions/:id/prompt/:key says (promptSubmit.ts `PromptOutcome`). */
export type PromptOutcomeState = 'submitted' | 'unconfirmed' | 'stopped' | 'gave-up' | 'failed';

/** Why the prompt route stopped a central's send (Ruling 51): the session went hands-off, or a person took it. */
export type PromptStopReason = 'hands-off' | 'person';

export interface PromptOutcomeView {
  state: PromptOutcomeState;
  /** For `stopped`: what the route stopped it for, when it was one of the rails. */
  stoppedBy?: PromptStopReason;
}

export interface SubmitAnswer {
  accepted: boolean;
  /** The route's words for a refusal. */
  error: string | null;
}

/**
 * What the ledger needs from the server. The /api calls name the central they are made for (`centralId`): every
 * internal call carries `mcp:<centralId>` (the client's presence id).
 */
export interface LedgerDeps {
  /** POST /sessions/:id/prompt `{ text, key, mode: 'now' }`. */
  submit(sessionId: string, text: string, key: string, centralId: string): Promise<SubmitAnswer>;
  /** GET /sessions/:id/prompt/:key: how the send ended, or null while it runs (or when the key is gone). */
  promptOutcome(sessionId: string, key: string, centralId: string): Promise<PromptOutcomeView | null>;
  /** hookSignals.onTerminalHook. */
  onTerminalHook(terminalId: string, listener: (signal: HookSignal) => void): () => void;
  /** sshManager.onTerminalExit. */
  onTerminalExit(listener: (terminalId: string) => void): () => void;
  /** The session by id (following re-keys), as a copy, or null. */
  getSession(id: string): Session | null;
  /**
   * The session's newest chat entries (GET /sessions/:id/chat, assistant text read up to ANSWER_MAX), oldest first,
   * reaching back to the prompt that begins with `head` when a few pages do, else to `since`. Throws when it cannot.
   */
  readChat(sessionId: string, head: string, since: number, centralId: string): Promise<readonly ChatEntry[]>;
  /** Press Esc on the session's turn, if it still runs in that terminal (the shared submitter's): true when pressed. */
  interrupt(sessionId: string, terminalId: string): Promise<boolean>;
  /** A central is about to press Esc in this session (escHold.ts): its cancel stamp is not a person's. */
  noteCentralEsc?(sessionId: string, terminalId: string): void;
  /** Is the terminal's foreground program the agent (Ruling 50)? Left out: never checked. */
  agentInFront?(terminalId: string): boolean;
  /** The highest task number the activity log holds (Ruling 49), read once, at the first task; 0 when none. */
  lastTaskNumber?(): number;
  /** The session queue's own resume prompt, when it sets one. */
  resumePromptOf?(sessionId: string): string | null;
  now(): number;
}

export interface CreateTaskInput {
  central: CentralRecord;
  session: Session;
  task: string;
  answerFormat?: string;
  /** The room name or folder name the envelope shows for a room or project central (`envelopeLabel`). */
  label?: string;
  /** How AASC routed it (the router, for `task_delegate` to "auto"); left out when the central named the session. */
  route?: TaskRecord['route'];
}

export interface TaskFilter {
  centralId?: string;
  state?: TaskState;
  sessionId?: string;
}

/**
 * What a cancel did: pressed Esc on the task's turn; found nothing to press (the session no longer mid-turn there);
 * found the turn already over; was not let press (the rails, `mayPress`); or found the task already ended.
 */
export type CancelHow = 'pressed' | 'nothing-to-press' | 'turn-over' | 'held' | 'ended';

export interface CancelOutcome {
  task: TaskRecord;
  how: CancelHow;
}

export interface CancelOptions {
  /** The rails (minus the task's own lock) allow an Esc in that session now. Left out: no Esc. */
  mayPress?: boolean;
}

export interface Ledger {
  /**
   * Records a task and sends its prompt; to a session still starting (`connecting`, a worker just opened), once it has
   * started (Ruling P4-6). Throws BUSY while the session holds a task, INVALID for a bad one.
   */
  create(i: CreateTaskInput): TaskRecord;
  get(id: string): TaskRecord | null;
  /** Oldest first. */
  list(f?: TaskFilter): TaskRecord[];
  /** Does the session (or the terminal it runs in) hold a task that has not ended, other than `exceptTaskId`? */
  isLocked(sessionId: string, exceptTaskId?: string): boolean;
  /** Is this an id of a task from an earlier server run (at or below the first id of this one)? */
  isFromBeforeRestart(id: string): boolean;
  /**
   * The records of `ids` once every one is settled (done, failed, cancelled, blocked or stalled), or when
   * `timeoutMs` (at most 50 s) passes, or at once when `signal` aborts. Ids it does not hold are left out.
   */
  wait(ids: readonly string[], timeoutMs: number, signal?: AbortSignal): Promise<TaskRecord[]>;
  /**
   * Cancels `centralId`'s own task: Esc on its turn while that turn is current and `mayPress`; otherwise it ends
   * cancelled with nothing pressed. NOT_FOUND for another's, INVALID before it runs.
   */
  cancel(id: string, centralId: string, opts?: CancelOptions): Promise<CancelOutcome>;
  /**
   * Re-routes `centralId`'s own task to `session`, once (Ruling P4-7): only a task AASC routed itself (`route.by`
   * 'auto') that failed because its terminal closed before its turn stopped (`isRetargetable`). It keeps its id, takes
   * `session`'s lock, is queued again and sends the same envelope there. NOT_FOUND for another central's task, INVALID
   * for one that may not be re-routed, BUSY while `session` holds a task.
   */
  retarget(id: string, centralId: string, session: Session): TaskRecord;
  /** Every change of a record, as a copy. Returns the unsubscribe. */
  onChange(listener: (t: TaskRecord) => void): () => void;
}
