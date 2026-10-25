// ledgerTurn.ts — how the task ledger (ledger.ts) knows a task's own turn (Ruling 46) and reads its answer (Ruling 48).
// Pure: the envelope AASC types, the words that recognise it in a hook's prompt, the prompts that continue a stalled
// turn, and the reading of a chat page (src/types/chat.ts) for the task's turn.
//
// A task's turn is the one its own envelope started: a prompt that begins with `[AASC · task T<n> from `. It is bounded
// by the next prompt that is not one of its resume prompts: its answer is the final assistant message before that
// prompt (its text blocks joined, at most ANSWER_MAX characters), and a cancel mark (`system: 'cancelled'`, which both
// readers write for a turn the person stopped) between the two means the turn was cancelled. When the pages read do not
// reach back to the task's own prompt, its send time is the floor.

import { basename } from 'node:path';
import type { ChatAssistantEntry, ChatEntry } from '../../src/types/chat.js';
import type { Room } from '../../src/types/room.js';
import { normalizeFolder } from './paths.js';
import { clipText } from './tools/define.js';
import type { CentralRecord } from './types.js';

/** The longest answer handed back whole. */
export const ANSWER_MAX = 20_000;

/** The ledger's history note for a task done whose answer could not be read (READ_TRIES failed reads). */
export const ANSWER_UNREAD_NOTE = 'its answer could not be read';

// ---------------------------------------------------------------------------
// The envelope
// ---------------------------------------------------------------------------

const CLOSING_LINE = 'Your final answer goes back to the central that sent this.';
const LABEL_MAX = 60;

/** A room or folder name on one line, inside its quotes and its brackets: it is not the central's to choose. */
function cleanLabel(label: string): string {
  return label
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F-\x9F]/g, ' ')
    .replace(/"/g, "'")
    .replace(/\[/g, '(')
    .replace(/\]/g, ')')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, LABEL_MAX)
    .trim();
}

/** How every envelope of task `taskId` begins, whoever sent it: `[AASC · task T<n> from `. */
export const envelopeHead = (taskId: string): string => `[AASC · task ${taskId} from `;

/**
 * What AASC types into the worker: `[AASC · task T<n> from ★ <kind><label>] <task>`, a blank line, and
 * `Your final answer goes back to the central that sent this.`; with an answer format, a blank line and
 * `Answer format: <format>` after it. `label` is the bare room or folder name (quoted here); a global central has none.
 */
export function buildEnvelope(
  taskId: string,
  central: Pick<CentralRecord, 'kind'>,
  label: string,
  task: string,
  answerFormat: string | null,
): string {
  const name = central.kind === 'global' ? '' : cleanLabel(label);
  const from = `★ ${central.kind}${name === '' ? '' : ` "${name}"`}`;
  const envelope = `${envelopeHead(taskId)}${from}] ${task}\n\n${CLOSING_LINE}`;
  return answerFormat ? `${envelope}\n\nAnswer format: ${answerFormat}` : envelope;
}

/** The label of a room central (its room's name) or a project central (its folder's name); '' for a global one. */
export function envelopeLabel(central: Pick<CentralRecord, 'kind' | 'scopeRef'>, rooms: readonly Room[]): string {
  const ref = central.scopeRef;
  if (central.kind === 'room') return rooms.find((r) => r.id === ref)?.name ?? '';
  if (central.kind === 'project' && typeof ref === 'string' && ref.trim() !== '') return basename(normalizeFolder(ref));
  return '';
}

/** The prompt route's request key for a task: `mcp-<central id's first 8>-task-T<n>` (route-legal, never reused). */
export function promptKeyFor(centralId: string, taskId: string): string {
  return `mcp-${centralId.slice(0, 8).replace(/[^A-Za-z0-9]/g, '_')}-task-${taskId}`;
}

// ---------------------------------------------------------------------------
// Whose prompt
// ---------------------------------------------------------------------------

/** Is this prompt (a hook's `currentPrompt`, a chat page's user entry) task `taskId`'s own envelope? */
export const isOwnPrompt = (prompt: string, taskId: string): boolean => prompt.trimStart().startsWith(envelopeHead(taskId));

/**
 * The auto-resume watchdog's own words when the queue sets none (src/lib/resumeWatchdog.ts `DEFAULT_RESUME_PROMPT`,
 * which the server build cannot import; test/mcp/ledgerTurn.test.ts holds the two equal).
 */
export const DEFAULT_RESUME_PROMPT =
  'The previous turn was interrupted by a transient error, not by you finishing. ' +
  'Continue from exactly where you left off — do not restart the task and do not repeat completed work.';

/** A short "carry on" a person or a central types to continue a turn a fault stopped. */
const RESUME_WORDS = /^(continue|resume|go on|keep going)\b/i;
const RESUME_WORDS_MAX = 40;

const folded = (text: string): string => text.replace(/\s+/g, ' ').trim();

/** The mark sessionStore puts after a prompt it kept only the start of (sessionTrim.ts `TRUNCATION_MARKER`). */
const CUT_MARK = /\s*\[… truncated[^\]]*\]\s*$/;

/**
 * Does this prompt continue a stalled turn? The session queue's own resume prompt (`queueResumePrompt`; the watchdog's
 * default wording when the queue sets none), or a short "continue", "resume", "go on" or "keep going".
 */
export function isResumePrompt(prompt: string, queueResumePrompt: string | null): boolean {
  const cut = CUT_MARK.test(prompt);
  const text = folded(prompt.replace(CUT_MARK, ''));
  if (text === '') return false;
  const own = folded(queueResumePrompt ?? '') || folded(DEFAULT_RESUME_PROMPT);
  // A hook's prompt keeps only its first 2 000 characters: a resume prompt longer than that matches by its start.
  if (text === own || (cut && own.startsWith(text))) return true;
  return text.length <= RESUME_WORDS_MAX && RESUME_WORDS.test(text);
}

// ---------------------------------------------------------------------------
// The task's turn on a chat page
// ---------------------------------------------------------------------------

export interface TurnRead {
  /** The task's own prompt was on the pages read; when it was not, its send time was the floor. */
  found: boolean;
  /** A later prompt (not one of its resume prompts) ends the turn on the page: the answer stops before it. */
  movedOn: boolean;
  /** A cancel mark between the task's prompt and that bound: the person (or an Esc) stopped the turn. */
  cancelled: boolean;
  /** The turn's final assistant message, its text blocks joined, at most ANSWER_MAX characters; null for none. */
  answer: string | null;
  /** The answer was longer than ANSWER_MAX (or the reader had to cut one of its blocks). */
  truncated: boolean;
}

export interface TurnBounds {
  taskId: string;
  /** When the prompt route took the task's prompt: the floor when the page does not reach back to it. */
  since: number;
  /** The prompts that continued its stalled turn: they do not end it. */
  resumes: readonly string[];
}

/** Where the task's turn begins on the page: just after its own prompt, else at its send time. */
function turnStart(entries: readonly ChatEntry[], b: TurnBounds): { start: number; found: boolean } {
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const e = entries[i];
    if (e.kind === 'user' && isOwnPrompt(e.text, b.taskId)) return { start: i + 1, found: true };
  }
  const first = entries.findIndex((e) => e.timestamp >= b.since);
  return { start: first < 0 ? entries.length : first, found: false };
}

/** The last run of assistant entries in `slice` (thinking between them belongs to the same message). */
function finalMessage(slice: readonly ChatEntry[]): ChatAssistantEntry[] {
  let last: ChatAssistantEntry[] = [];
  let current: ChatAssistantEntry[] = [];
  for (const e of slice) {
    if (e.kind === 'assistant') current = [...current, e];
    else if (e.kind !== 'thinking' && current.length > 0) {
      last = current;
      current = [];
    }
  }
  return current.length > 0 ? current : last;
}

/** The task's turn as the chat page (oldest first) shows it. */
export function readTurn(entries: readonly ChatEntry[], b: TurnBounds): TurnRead {
  const { start, found } = turnStart(entries, b);
  const resumes = new Set(b.resumes.map(folded));
  const bound = entries.findIndex((e, i) => i >= start && e.kind === 'user' && !resumes.has(folded(e.text)));
  const end = bound < 0 ? entries.length : bound;
  const slice = entries.slice(start, end);
  const cancelled = slice.some((e) => e.kind === 'system' && e.system === 'cancelled');
  const blocks = finalMessage(slice).filter((e) => e.text.trim() !== '');
  const whole = blocks.map((e) => e.text).join('\n\n');
  const clipped = clipText(whole, ANSWER_MAX);
  return {
    found,
    movedOn: bound >= 0,
    cancelled,
    answer: whole === '' ? null : clipped.text,
    truncated: clipped.truncated || blocks.some((e) => e.truncated === true),
  };
}
