// tools/queueWriteKit.ts — what the queue write tools (queueWrite.ts, queueWriteSteps.ts, queueWriteAutomation.ts) share:
// where the queue is kept, how a tool names the session it changes, whether a window is open to run the queue, and the
// shape of every answer.
//
// A write goes: `steerTarget` (the session by id, scope-checked, then the steering rails of `ctx.mayDrive`; a refusal is
// logged as it is thrown and nothing is read or written), `writeOp` (the one synchronous read-modify-write of
// queueOps.ts, as `mcp:<centralId>`), then an answer that says what changed. Whether a window is open is asked AFTER the
// write, so a refusal costs no route call; the queue itself is only run by the desktop window's scheduler, so every
// answer says when no window is open ("runs when the AASC window is open").
//
// A call that would make the window send without anyone asking (turn a prompt on, ⚡ NOW, auto-send, auto-enter or
// auto-resume on, resume the queue, release a cancel's hold, loosen a guard or the resume prompt) goes through
// `startTarget` instead: the session by id, then the lock of Ruling 42 (`assertMayStartUnattended`, unattended.ts: until
// P4 a central starts no unattended run, so it refuses DENIED), then the same rails. The lock comes first, so nothing is
// read, written or asked of AASC for a call that can never work. A lock that depends on the stored queue (Rulings 43 and
// 53: a prompt that is on, the quiet hours, the resume attempts) is checked by `lockUnattended` inside the op, in the
// same read-modify-write, so it is judged on the queue it writes.
//
// The text of a queued prompt is written by a central or a person and typed into a CLI later: it reaches a central only
// fenced as untrusted, in the data and in the text (Ruling 28), through the same views `queue_get` uses.

import { z } from 'zod';
import type { Session } from '../../../src/types/session.js';
import log from '../../logger.js';
import type { ActivityNote } from '../activity.js';
import { catalogEntries, catalogRefusal, leadingCommand, queuedCommandVerdict, unknownCliRefusal } from '../commandRules.js';
import { MCP_CLIENT_PREFIX, SteerRefusal } from '../policy.js';
import {
  applyQueueOp,
  CLOCK_RE,
  TEXT_MAX,
  typedText,
  type QueueChange,
  type QueueItemLike,
  type QueueOp,
  type QueueStore,
} from '../queueOps.js';
import type { ToolContext, ToolResult } from '../registry.js';
import { shortIdOf, toSessionCard } from '../scope.js';
import { ToolError } from '../types.js';
import { assertMayStartUnattended, isEnabledPrompt, type UnattendedChange } from '../unattended.js';
import { fence, isRecord, nonEmptyString, oneLine, plural, refOf, resolveTarget, sessionSource, unwrap } from './define.js';
import { automationLine, automationOf as viewAutomation, FULL, itemOf } from './queue.js';

// ---------------------------------------------------------------------------
// Where the queue is kept
// ---------------------------------------------------------------------------

/** What the queue write tools run on. The server's own store, and the lock of Ruling 42, unless a test passes its own. */
export interface QueueWriteDeps {
  store(): Promise<QueueStore>;
  /**
   * The lock on unattended runs: throws unless this central may make this change in this session. Absent, it is
   * `assertMayStartUnattended` (always refuses in P2); only a test passes another, to stand in for P4's own workers.
   */
  mayStartUnattended?(ctx: ToolContext, session: Session, change: UnattendedChange): void;
}

let server: Promise<QueueStore> | null = null;

/**
 * The server's queue store (queueWiring.ts), loaded on the first write and kept. It imports the database and the
 * WebSocket manager, so it is loaded here, not at import time: nothing that only lists the tools opens SQLite.
 */
export function serverQueueStore(): Promise<QueueStore> {
  server ??= import('../queueWiring.js')
    .then((wiring) => wiring.serverQueueStore())
    .catch((err: unknown) => {
      server = null;
      throw err;
    });
  return server;
}

/** The deps the registered tools use. */
export const serverDeps: QueueWriteDeps = { store: serverQueueStore };

// ---------------------------------------------------------------------------
// Arguments every tool takes the same way
// ---------------------------------------------------------------------------

export const ITEM_ID = z.number().int().min(1).describe('A queued prompt: its id, as queue_get shows it.');
export const STEP_ID = z.number().int().min(1).describe('A chain step: its id, as queue_get shows it.');
export const CHAIN = z
  .enum(['before', 'after'])
  .describe('Which chain: "before" runs ahead of the prompt, "after" runs behind it.');
export const PROMPT_TEXT = z
  .string()
  .min(1)
  .max(TEXT_MAX)
  .describe(
    'The words to type into the session (plain text, up to 64 KiB). Text that starts with a /command must be one ' +
      'command_run may run, written as command_list shows it in invoke.',
  );
/** A place in a list, counted from 0. The ops clamp it to the list. */
export const PLACE = z.number().int().min(0);

/** A time of day, 24-hour, local: how the queue stores a quiet-hours window and a loop's first fire of the day. */
export const CLOCK_TIME = z.string().regex(CLOCK_RE, 'A time is 24-hour HH:MM, like 07:30.');
/** Quiet hours: a loop does not start between `start` and `end`. */
export const QUIET_WINDOW = z.object({
  start: CLOCK_TIME.describe('When the quiet hours start.'),
  end: CLOCK_TIME.describe('When they end (earlier than the start means past midnight).'),
});

/** The rails a steering call is held to: the sentence every tool description that steers ends with. */
export const RAILS =
  'The rails of prompt_send apply: refused when the session is hands-off, a person drove it in the last minute, or a central’s task is running there.';

/** What a tool that changes one prompt says about a prompt that is on (Ruling 43). */
export const ON_LOCK =
  'For a prompt that is on, which AASC sends by itself: allowed in a session this central opened itself, refused ' +
  '(DENIED) in any other; there, turn it off first, and a person turns it back on in AASC.';

/** What the lock on unattended runs comes to now that centrals open workers (Ruling P4-12): the sentence the tools share. */
export const OWN_WORKERS_ONLY =
  'Allowed in a session this central opened itself (task_delegate, session_create); refused (DENIED) in any other ' +
  'session, where only a person can do it, in AASC.';

// ---------------------------------------------------------------------------
// Steering a session
// ---------------------------------------------------------------------------

/** What every write runs under: `mcp:<centralId>`, so the desktop window applies the update instead of dropping it as its echo. */
export const originOf = (ctx: ToolContext): string => `${MCP_CLIENT_PREFIX}${ctx.central.centralId}`;

/** The session `ref` names (scope-checked), after the steering rails agree. Throws their refusal, which is already logged. */
export function steerTarget(ctx: ToolContext, ref: string): Session {
  const session = resolveTarget(ctx, ref);
  ctx.mayDrive(session);
  return session;
}

/**
 * `steerTarget` for a call that queues `raw` text: the session by id (scope-checked), then the text check (which may read
 * the session's catalog), and only then the steering rails, so they are judged right before the write and not across
 * that await (P4-32 M5). A refused text reads and writes no queue and logs no steer.
 */
export async function steerTargetForText(ctx: ToolContext, ref: string, raw: string): Promise<Session> {
  await assertMayQueueText(ctx, resolveTarget(ctx, ref), raw);
  return steerTarget(ctx, ref);
}

/** The lock on unattended runs, for this change in this session: DENIED in P2. Its helper is the one place P4 relaxes. */
export function lockUnattended(deps: QueueWriteDeps, ctx: ToolContext, session: Session, change: UnattendedChange): void {
  (deps.mayStartUnattended ?? assertMayStartUnattended)(ctx, session, change);
}

/**
 * The session `ref` names for a call whose arguments alone make the window send by itself, or loosen how it does:
 * scope-checked, then the lock (DENIED in P2, before anything else is said or done), then the steering rails.
 */
export function startTarget(deps: QueueWriteDeps, ctx: ToolContext, ref: string, change: UnattendedChange = 'start'): Session {
  const session = resolveTarget(ctx, ref);
  lockUnattended(deps, ctx, session, change);
  ctx.mayDrive(session);
  return session;
}

/**
 * Inside a write's read-modify-write: the lock, when the prompt it changes is on (Ruling 43). The window sends a prompt
 * that is on by itself, so changing its text, timing, chain or place changes an unattended run; one that is off waits
 * for a person to turn it on. A prompt that is not in the queue passes, for the op to answer NOT_FOUND.
 */
export function lockIfOn(deps: QueueWriteDeps, ctx: ToolContext, session: Session, items: readonly QueueItemLike[], itemId: number): void {
  if (isEnabledPrompt(items, itemId)) lockUnattended(deps, ctx, session, 'enabledPrompt');
}

/** How plain words name the session: its short id, or the whole id where short ids collide. */
export const nameOf = (ctx: ToolContext, session: Session): string => refOf(ctx)(session.sessionId);

/**
 * A refusal about this session's queue, made to carry the session: runTool logs a refusal's session only from a
 * `SteerRefusal`, so the activity row says which queue was refused. Anything else (a policy refusal, which already
 * names it; an unexpected failure) is left as it is.
 */
function aboutSession(err: unknown, session: Session): unknown {
  if (!(err instanceof ToolError) || err instanceof SteerRefusal) return err;
  return new SteerRefusal(err.code, err.message, err.hint ?? '', session.sessionId);
}

/** The read-modify-write of one op on the session's stored queue (one synchronous step once the store is there). */
export async function writeOp<R>(deps: QueueWriteDeps, ctx: ToolContext, session: Session, op: QueueOp<R>): Promise<QueueChange<R>> {
  const store = await deps.store();
  try {
    return applyQueueOp(store, session.sessionId, op, originOf(ctx));
  } catch (err) {
    throw aboutSession(err, session);
  }
}

/**
 * Ruling 60: the window types queued text as stored, so text a central queues that starts with a slash command must be
 * one command_run would run (commandRules.ts). The session's catalog is asked only when the rule cannot tell without it;
 * a catalog that cannot be read refuses, so nothing is queued on a guess. Runs before the write: a refusal reads and
 * writes no queue.
 */
export async function assertMayQueueText(ctx: ToolContext, session: Session, raw: string): Promise<void> {
  try {
    await checkQueuedText(ctx, session, raw);
  } catch (err) {
    throw aboutSession(err, session);
  }
}

async function checkQueuedText(ctx: ToolContext, session: Session, raw: string): Promise<void> {
  const cmd = leadingCommand(typedText(raw));
  if (cmd === null) return;
  const verdict = queuedCommandVerdict(cmd);
  if (verdict === 'allowed') return;
  if (verdict !== 'catalog') throw verdict;
  const card = toSessionCard(session, []);
  if (card.cli === null) throw unknownCliRefusal();
  const query = { cli: card.cli, ...(card.project === null ? {} : { projectPath: card.project }) };
  const refusal = catalogRefusal(cmd, catalogEntries(unwrap<unknown>(await ctx.client.get('/commands', query))));
  if (refusal !== null) throw refusal;
}

// ---------------------------------------------------------------------------
// The window
// ---------------------------------------------------------------------------

/** Is a device connected that saves the workspace (the desktop window, whose scheduler runs every queue)? Reads `GET /presence`. */
async function writerConnected(ctx: ToolContext): Promise<boolean> {
  const snapshot = unwrap<{ workspaceWriter?: unknown }>(await ctx.client.get('/presence'));
  return nonEmptyString(snapshot.workspaceWriter) !== null;
}

/** A window open to run the queue: true or false, or null when AASC could not say (the write is not held up for it). */
export async function windowOpen(ctx: ToolContext): Promise<boolean | null> {
  try {
    return await writerConnected(ctx);
  } catch (err) {
    log.debug('mcp', `Reading presence for a queue write failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** ⚡ NOW is carried out by the window: refuses NO_WINDOW when none is open, and the presence route's failure when it cannot say. */
export async function requireWindow(ctx: ToolContext): Promise<void> {
  if (!(await writerConnected(ctx))) {
    throw new ToolError(
      'NO_WINDOW',
      'No AASC window is open to start it.',
      'The AASC window sends queued prompts: ask the person to open it, or type the prompt with prompt_send.',
    );
  }
}

/** The sentence for an answer when the queue has nothing to run it: empty when a window is open. */
export function windowWords(open: boolean | null): string {
  if (open === true) return '';
  return open === false
    ? ' No AASC window is open now: the queue runs when the AASC window is open.'
    : ' The queue runs when the AASC window is open.';
}

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

/** How many prompts the queue holds, and how many of them are on. */
function countsOf(items: readonly QueueItemLike[]): { count: number; enabled: number } {
  const records = items.filter(isRecord);
  return { count: records.length, enabled: records.filter((i) => i.disabled !== true).length };
}

const heldWords = (items: readonly QueueItemLike[]): string => {
  const { count, enabled } = countsOf(items);
  return `The queue holds ${plural(count, 'prompt')} (${enabled} on).`;
};

/** What every answer is made of: the words AASC says (never text a caller or a session wrote), and the log's note. */
interface AnswerBase {
  ctx: ToolContext;
  session: Session;
  change: QueueChange<unknown>;
  said: string;
  note: ActivityNote;
}

export interface ItemAnswer extends AnswerBase {
  itemId: number;
  /** Fields beside the item in `data`. */
  extra?: Record<string, unknown>;
}

/** The place a prompt stands at in the queue now. */
export function positionOf(items: readonly QueueItemLike[], itemId: number): number | null {
  const found = items.find((entry) => isRecord(entry) && entry.id === itemId);
  return isRecord(found) && typeof found.position === 'number' ? found.position : null;
}

/** An answer about one prompt that is still in the queue: the prompt as stored (text fenced), the queue's counts, the window. */
export async function itemAnswer(a: ItemAnswer): Promise<ToolResult> {
  const id = a.session.sessionId;
  const raw = a.change.items.find((entry) => isRecord(entry) && entry.id === a.itemId);
  if (!isRecord(raw)) throw new Error('The prompt just written is not in the queue it was written to.');
  const { view, rows } = itemOf(id, raw, FULL);
  const open = await windowOpen(a.ctx);
  const data = { id, shortId: shortIdOf(id), item: view, queue: countsOf(a.change.items), windowOpen: open, ...a.extra };
  const lead = `${a.said} ${heldWords(a.change.items)}${windowWords(open)}`;
  return { data, summary: `${lead}\n${fence(sessionSource(id), 'queue', rows.join('\n'))}`, activity: [a.note] };
}

/** An answer about a prompt that is gone: no text of it comes back. */
export async function removedAnswer(a: ItemAnswer): Promise<ToolResult> {
  const id = a.session.sessionId;
  const open = await windowOpen(a.ctx);
  const data = { id, shortId: shortIdOf(id), removed: { itemId: a.itemId }, queue: countsOf(a.change.items), windowOpen: open, ...a.extra };
  return { data, summary: `${a.said} ${heldWords(a.change.items)}${windowWords(open)}`, activity: [a.note] };
}

/** The row for a resume prompt in the text, inside the one fence. */
const RESUME_ROW_TEXT = 160;

/** An answer about the session's automation switches. A resume prompt, when it is shown, is fenced in the data and the text. */
export async function automationAnswer(a: AnswerBase & { showResumePrompt?: boolean }): Promise<ToolResult> {
  const id = a.session.sessionId;
  const view = viewAutomation(id, a.change.automation);
  if (view === null) throw new Error('The automation just written is not in the queue record it was written to.');
  const open = await windowOpen(a.ctx);
  const data = { id, shortId: shortIdOf(id), automation: view, windowOpen: open };
  const lead = `${a.said} ${automationLine(view)}${windowWords(open)}`;
  const prompt = isRecord(a.change.automation) && typeof a.change.automation.resumePrompt === 'string' ? a.change.automation.resumePrompt : '';
  const block =
    a.showResumePrompt === true && prompt !== ''
      ? `\n${fence(sessionSource(id), 'queue', `resume prompt: ${JSON.stringify(oneLine(prompt, RESUME_ROW_TEXT))}`)}`
      : '';
  return { data, summary: `${lead}${block}`, activity: [a.note] };
}
