/**
 * @module centralActivity
 * The pure half of showing what a central does (server/mcp, P2): the words of a worker's badge
 * (`← ★ global · T12 · running`), the tone it takes by task state, and the words, times and colours of a row of
 * a central's activity log. The two components that show them (`WorkerBadge`, `CentralActivity`) only lay these
 * out, so what a card says and what the panel says cannot drift apart.
 *
 * Every word here is AASC's own: a task's title and a row's summary are shown as they came from the server,
 * which wrote them (or scrubbed them) in its own words.
 */
import { centralBadgeText, scopeName } from '@/lib/centralChoice';
import { sessionDisplayTitle, type TitledSession } from '@/lib/sessionDisplayTitle';
import type { CentralKind, McpActivityOutcome, McpTaskState } from '@/types';

/** What the words need to know about the central that sent a task. Unknown while its list has not arrived. */
type Scope = { kind: CentralKind; scopeRef: string | null };
type TaskWords = { taskId: string; state: McpTaskState };

// ---------------------------------------------------------------------------
// The worker badge
// ---------------------------------------------------------------------------

/** The scope part of the badge, which may be cut short on a narrow card: `← ★ global`, `← ★ room Backend`. */
export function workerBadgeScope(central: Scope | undefined, roomName?: string | null): string {
  return `← ${central === undefined ? '★ central' : centralBadgeText(central, roomName)}`;
}

/** What stands between the scope and the task: it belongs to the scope, so a badge that drops the scope drops it too. */
export const WORKER_BADGE_SEPARATOR = ' · ';

/** The task id and its state, the part that is never cut short: `T12 · running`. */
export function workerBadgeTask(task: TaskWords): string {
  return `${task.taskId} · ${task.state}`;
}

/** The separator and the task: ` · T12 · running`. */
export function workerBadgeRest(task: TaskWords): string {
  return `${WORKER_BADGE_SEPARATOR}${workerBadgeTask(task)}`;
}

/** The whole badge: `← ★ global · T12 · running`. */
export function workerBadgeText(task: TaskWords, central: Scope | undefined, roomName?: string | null): string {
  return workerBadgeScope(central, roomName) + workerBadgeRest(task);
}

/** The badge on a card with no room for words: the task id alone. */
export function workerBadgeCompactText(task: Pick<TaskWords, 'taskId'>): string {
  return task.taskId;
}

export type WorkerBadgeTone = 'pending' | 'running' | 'attention';

/**
 * How a badge is coloured: quiet while the prompt is on its way, the central's colour while the session works,
 * and a warning when it waits on a person (a dialog) or a fault, so it stands out on a card in a long list.
 */
export function workerBadgeTone(state: McpTaskState): WorkerBadgeTone {
  if (state === 'running') return 'running';
  if (state === 'blocked' || state === 'stalled') return 'attention';
  return 'pending';
}

/** The badge in words for a screen reader (the compact badge shows the id alone): `Task T12 from the global central: running`. */
export function workerBadgeLabel(task: TaskWords, central: Scope | undefined, roomName?: string | null): string {
  const from = central === undefined ? 'a central session' : `the ${scopeName(central, roomName)} central`;
  return `Task ${task.taskId} from ${from}: ${task.state}`;
}

const TASK_STATE_HINTS: Record<McpTaskState, string> = {
  queued: 'AASC is about to send the prompt.',
  sent: 'AASC is typing the prompt into the session.',
  running: 'The session is working on it.',
  blocked: 'The session waits on a dialog; the task goes on once someone answers it.',
  stalled: 'The turn ended on an API fault (rate limit, overload or network); the task goes on when the turn is continued.',
  done: 'The turn ended and the answer went back to the central.',
  failed: 'The prompt was not taken, or the session ended.',
  cancelled: 'The turn was stopped, or the central cancelled the task.',
};

/** What a task state means, in a sentence. */
export function taskStateHint(state: McpTaskState): string {
  return TASK_STATE_HINTS[state];
}

/** Who sent the task, for a tooltip: `From the global central.` */
function fromCentral(central: Scope | undefined, roomName?: string | null): string {
  if (central === undefined) return 'From a central session.';
  if (central.kind === 'global') return 'From the global central.';
  if (central.kind === 'room') {
    return roomName?.trim() ? `From the room central for “${roomName.trim()}”.` : 'From a room central.';
  }
  return central.scopeRef?.trim() ? `From the project central for ${central.scopeRef.trim()}.` : 'From a project central.';
}

/** The badge's tooltip (the shared Tooltip's label and description): who sent it, what it asked, what its state means. */
export function workerBadgeTip(
  task: TaskWords & { title: string },
  central: Scope | undefined,
  roomName?: string | null,
): { label: string; description: string } {
  const asked = task.title.trim() ? ` “${task.title.trim()}”.` : '';
  return {
    label: `Task ${task.taskId} · ${task.state}`,
    description: `${fromCentral(central, roomName)}${asked} ${taskStateHint(task.state)}`,
  };
}

// ---------------------------------------------------------------------------
// The activity panel
// ---------------------------------------------------------------------------

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;
const pad = (n: number): string => String(n).padStart(2, '0');

/**
 * A row's time: the clock with seconds for a row of today (`14:05:09`), the day and the minute for an older one
 * (`Oct 24 14:05`), both in this window's time zone. `title` is the full date and time, for hover. A time that is
 * not a date reads as a dash.
 */
export function activityTime(at: number, now: number): { text: string; title: string } {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return { text: '—', title: '' };
  const today = new Date(now);
  const sameDay =
    date.getFullYear() === today.getFullYear() && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return {
    text: sameDay ? `${clock}:${pad(date.getSeconds())}` : `${MONTHS[date.getMonth()]} ${date.getDate()} ${clock}`,
    title: date.toLocaleString(),
  };
}

/** A row's outcome in a word: `ok`, `refused`, `failed`, or the state a task moved to. */
export function activityOutcomeLabel(outcome: McpActivityOutcome): string {
  return outcome;
}

export type OutcomeTone = 'neutral' | 'info' | 'success' | 'warning' | 'danger';

const OUTCOME_TONES: Record<McpActivityOutcome, OutcomeTone> = {
  ok: 'success',
  done: 'success',
  refused: 'warning',
  blocked: 'warning',
  stalled: 'warning',
  failed: 'danger',
  running: 'info',
  queued: 'neutral',
  sent: 'neutral',
  cancelled: 'neutral',
};

/** The Chip tone of an outcome, by meaning: done is good, a refusal or a wait is a warning, a failure an error. */
export function activityOutcomeTone(outcome: McpActivityOutcome): OutcomeTone {
  return OUTCOME_TONES[outcome];
}

/**
 * The session a row was about, in words: its name as the cards say it, or its first 8 characters when the board no
 * longer has it (it ended and was removed, or was re-keyed), or a dash when the row had no target. `known` says
 * whether the board has it.
 */
export function activityTargetLabel(
  targetSessionId: string | null,
  sessions: ReadonlyMap<string, TitledSession>,
): { text: string; known: boolean } {
  if (targetSessionId === null) return { text: '—', known: false };
  const session = sessions.get(targetSessionId);
  if (session === undefined) return { text: targetSessionId.slice(0, 8), known: false };
  return { text: sessionDisplayTitle(session), known: true };
}
