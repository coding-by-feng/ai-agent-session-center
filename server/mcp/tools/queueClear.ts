// tools/queueClear.ts — `queue_clear` (P5, Ruling P5-10): takes every prompt out of a session's queue. Filed under
// `queue` by queue.ts's export line.
//
// It is `destructive`: the texts are not kept. The steering rails come first (`steerTarget`: the session by id,
// scope-checked, then `ctx.mayDrive`), so a hands-off session, one a person drove in the last minute or one a task holds
// is refused before anything is read or asked. An empty queue needs no card and answers `cleared: 0`. Any other queue
// always asks, in a central's own worker too: the exemption of Ruling P5-4 names restart and close only. The card says
// how many prompts there are, how many are switched on, and each one's first line.
//
// What runs is what the person was shown (Ruling P5-3). The fingerprint is a digest of the prompts the card listed: each
// one's id, whether it is on, its first line, its chain steps (before and after) and its timing fields, all of which
// the clear removes; the card's row says "(+N chain steps)" for a prompt that has any. runTool asks `confirm` again
// after the allow, so a prompt the window added, sent, rewrote, switched or gave a step meanwhile runs nothing (CHANGED).
// `confirm` leaves the digest it made for this call (the context is one per call), and `run` recomputes the digest
// inside the one read-modify-write that clears and compares it with that one: whatever I/O is later put between the
// recheck and the write, a queue that is not the one the person approved is not cleared. A run the person did not
// allow (the queue was empty when `confirm` looked) clears nothing.
//
// queue.ts imports this file and queueWriteKit.ts imports queue.ts, so this module never imports the kit at load: it
// loads it when the tool runs (`kit()`), which keeps the three loadable in any order. The description writes the kit's
// RAILS sentence out (a test holds the two together), and the server's store is looked up when the tool runs.

import { createHash } from 'node:crypto';
import type { Session } from '../../../src/types/session.js';
import { clearItems, inOrder, queueItemIds, typedText, type QueueItemLike } from '../queueOps.js';
import type { ConfirmAsk, ToolContext, ToolDef, ToolResult } from '../registry.js';
import { shortIdOf } from '../scope.js';
import { ToolError } from '../types.js';
import { defineTool, isRecord, plural, SESSION_REF } from './define.js';
import type { QueueWriteDeps } from './queueWriteKit.js';

/** The write kit, loaded when a tool runs: it imports queue.ts, which imports this file (see the header). */
const kit = (): Promise<typeof import('./queueWriteKit.js')> => import('./queueWriteKit.js');

/** The longest first line the card shows of one prompt. */
const FIRST_LINE_MAX = 80;
/** The most the card's detail holds: the confirmation book's own cut (confirm.ts CONFIRM_DETAIL_MAX). */
const DETAIL_MAX = 2_000;
/** Room kept at the end of a cut detail for its "… and N more" line. */
const MORE_ROOM = 24;

/** The prompts as the queue holds them, in its order: entries that are not items are not prompts. */
const promptsOf = (items: readonly QueueItemLike[]): Array<Record<string, unknown>> => inOrder(items).filter(isRecord);

const isOn = (prompt: Record<string, unknown>): boolean => prompt.disabled !== true;

/** The two chains a prompt may have, as the queue stores them. */
const CHAINS = ['beforeChain', 'afterChain'] as const;
/** The timing fields the clear removes with the prompt. */
const TIMING = ['type', 'intervalMs', 'runAt', 'nextFireAt', 'firstFireOfDay', 'excludeWindows'] as const;

const stepsOf = (prompt: Record<string, unknown>, key: (typeof CHAINS)[number]): unknown[] => {
  const steps = prompt[key];
  return Array.isArray(steps) ? steps : [];
};

/** How many chain steps (before and after) a prompt has. */
const stepCount = (prompt: Record<string, unknown>): number => CHAINS.reduce((n, key) => n + stepsOf(prompt, key).length, 0);

/** A prompt's first line as the CLI would get it, cut to FIRST_LINE_MAX; "(no text)" for one with none. */
function firstLine(prompt: Record<string, unknown>): string {
  const text = typeof prompt.text === 'string' ? typedText(prompt.text) : '';
  const line = text.split('\n')[0]?.trim() ?? '';
  if (line === '') return '(no text)';
  return line.length > FIRST_LINE_MAX ? `${line.slice(0, FIRST_LINE_MAX - 1)}…` : line;
}

/** One row per prompt, its first line only; past DETAIL_MAX, as many as fit and then how many more there are. */
function detailOf(prompts: ReadonlyArray<Record<string, unknown>>): string {
  const rows = prompts.map((p) => {
    const steps = stepCount(p);
    return `- ${firstLine(p)}${steps > 0 ? ` (+${plural(steps, 'chain step')})` : ''}`;
  });
  const whole = rows.join('\n');
  if (whole.length <= DETAIL_MAX) return whole;
  const kept: string[] = [];
  let size = 0;
  for (const row of rows) {
    if (size + row.length + 1 > DETAIL_MAX - MORE_ROOM) break;
    kept.push(row);
    size += row.length + 1;
  }
  return [...kept, `… and ${rows.length - kept.length} more`].join('\n');
}

/**
 * What the person is shown and what the clear removes, as a digest: each prompt's id, whether it is on, its first line,
 * its chain steps and its timing fields. AASC-made, short.
 */
function fingerprintOf(prompts: ReadonlyArray<Record<string, unknown>>): string {
  const shown = prompts.map((p) => [
    typeof p.id === 'number' ? p.id : null,
    isOn(p),
    firstLine(p),
    CHAINS.map((key) => stepsOf(p, key)),
    TIMING.map((key) => p[key] ?? null),
  ]);
  shown.sort((a, b) => Number(a[0] ?? -1) - Number(b[0] ?? -1));
  const digest = createHash('sha256').update(JSON.stringify(shown)).digest('hex').slice(0, 40);
  return `queue:${prompts.length}:${digest}`;
}

/** The queue `run` is about to clear is not the one the person approved. */
const queueChanged = (): ToolError =>
  new ToolError('INVALID', 'The queue changed since the person was asked.', 'Call queue_clear again: the person is asked about the queue as it is now.');

/** A run marked allowed with no `confirm` of this call behind it: nothing to say what the person saw. */
const notAsked = (): ToolError =>
  new ToolError('INVALID', 'The person was not asked about this queue.', 'Call queue_clear again: the person is asked first.');

/** The digest `confirm` made for a call's context (one per call): what `run` of that call checks the queue against. */
const approvedDigest = new WeakMap<ToolContext, string>();

/** A run the person did not allow found prompts in a queue that was empty when `confirm` looked. */
const filledSince = (): ToolError =>
  new ToolError(
    'INVALID',
    'The queue is no longer empty, and the person was not asked about clearing it.',
    'Call queue_clear again: the person is asked first.',
  );

/** The answer: how many prompts went, and what the queue holds now. No text of any prompt comes back. */
async function clearedAnswer(ctx: ToolContext, s: Session, cleared: number, left: readonly QueueItemLike[]): Promise<ToolResult> {
  const id = s.sessionId;
  const prompts = left.filter(isRecord);
  const { nameOf, windowOpen } = await kit();
  const open = await windowOpen(ctx);
  const data = {
    id,
    shortId: shortIdOf(id),
    cleared,
    queue: { count: prompts.length, enabled: prompts.filter(isOn).length },
    windowOpen: open,
  };
  const name = nameOf(ctx, s);
  return {
    data,
    summary:
      cleared === 0
        ? `The queue of session ${name} is already empty; nothing was cleared.`
        : `Cleared ${plural(cleared, 'prompt')} from the queue of session ${name}. Their texts are not kept.`,
    activity: [
      {
        summary: cleared === 0 ? 'Found the queue already empty' : `Cleared a queue of ${plural(cleared, 'prompt')}`,
        targetSessionId: id,
        detail: { cleared },
      },
    ],
  };
}

/** `queue_clear` over `deps` (a test passes its own store); the server's store when none is given. */
export function createQueueClearTool(deps?: QueueWriteDeps): ToolDef {
  const depsOf = async (): Promise<QueueWriteDeps> => deps ?? (await kit()).serverDeps;
  return defineTool({
    name: 'queue_clear',
    toolset: 'queue',
    title: 'Clear a session’s queue',
    description:
      'Takes every prompt out of a session’s queue; its automation switches stay as they are. It cannot be undone: the ' +
      'texts are not kept. An empty queue answers cleared: 0 and asks nothing. Any other queue always waits for the ' +
      'person to allow it, in your own workers too (NEEDS_CONFIRMATION → confirm_wait): the card shows how many prompts ' +
      'there are, how many are on, and each one’s first line and chain steps. If the queue changes before the person allows it (a ' +
      'prompt added, sent, rewritten, switched or given a step), nothing is cleared: call it again. ' +
      'The rails of prompt_send apply: refused when the session is hands-off, a person drove it in the last minute, or a ' +
      'central’s task is running there.',
    risk: 'destructive',
    phase: 5,
    input: { id: SESSION_REF },
    async confirm(args, ctx): Promise<ConfirmAsk | null> {
      const { nameOf, steerTarget } = await kit();
      const s = steerTarget(ctx, args.id);
      const store = await (await depsOf()).store();
      const prompts = promptsOf(store.read(s.sessionId).items);
      if (prompts.length === 0) {
        approvedDigest.delete(ctx);
        return null;
      }
      const fingerprint = fingerprintOf(prompts);
      approvedDigest.set(ctx, fingerprint);
      return {
        summary: `clear the queue of session ${nameOf(ctx, s)}: ${plural(prompts.length, 'prompt')} (${prompts.filter(isOn).length} switched on)`,
        detail: detailOf(prompts),
        targetSessionId: s.sessionId,
        fingerprint,
      };
    },
    async run(args, ctx) {
      const { steerTarget, writeOp } = await kit();
      const s = steerTarget(ctx, args.id);
      const own = await depsOf();
      const stored = (await own.store()).read(s.sessionId).items;
      if (promptsOf(stored).length === 0) return clearedAnswer(ctx, s, 0, stored);
      if (!ctx.allowedByPerson()) throw filledSince();
      const approved = approvedDigest.get(ctx);
      if (approved === undefined) throw notAsked();
      const change = await writeOp(own, ctx, s, (state) => {
        // The queue as the one read-modify-write holds it, against what the card was made from.
        if (fingerprintOf(promptsOf(state.items)) !== approved) throw queueChanged();
        return clearItems(state, { expectIds: queueItemIds(state.items) });
      });
      return clearedAnswer(ctx, s, change.result.cleared, change.items);
    },
  });
}

/** The registered tool, on the server's own queue store. */
export const queueClearTool: ToolDef = createQueueClearTool();
