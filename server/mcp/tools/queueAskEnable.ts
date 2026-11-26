// queueAskEnable.ts — `queue_ask_enable` (Nov 22 2026): how a central turns a queued prompt ON in a session it did not
// open itself. The lock on unattended runs (Ruling 42, unattended.ts) refuses `queue_set_item_enabled` there, so a
// voice request like "check T3 every 5 minutes" had no way through. This tool keeps the lock's meaning — only a person
// turns on an unattended run in someone else's session — by asking the person on a confirmation card first (risk `ask`,
// runTool's gate), and turning the prompt on only in the run the person allowed. In a session the central opened itself
// it asks nothing, as `queue_set_item_enabled` would not. The steering rails (hands-off, a person's recent drive, a task
// of another central) apply either way.

import { setItemEnabled, type QueueItemLike } from '../queueOps.js';
import type { ConfirmAsk, ToolContext, ToolDef } from '../registry.js';
import { ToolError } from '../types.js';
import { isOwnWorker } from '../unattended.js';
import { clipText, defineTool, refOf, resolveTarget, SESSION_REF } from './define.js';
import { isClearStepText, ITEM_ID, itemAnswer, nameOf, RAILS, serverDeps, startTarget, writeOp, type QueueWriteDeps } from './queueWriteKit.js';

/** The longest prompt text shown on the card. */
const DETAIL_MAX = 2_000;

const minutes = (ms: number): string => {
  const m = ms / 60_000;
  if (m < 1) return `${Math.round(ms / 1000)} s`;
  if (m < 120) return `${Math.round(m)} min`;
  return `${Math.round(m / 60)} h`;
};

/** How often the prompt runs, in the card's words. */
export function timingOf(item: QueueItemLike): string {
  if (item.type === 'loop' && typeof item.intervalMs === 'number') return `every ${minutes(item.intervalMs)}`;
  if (item.type === 'schedule' && typeof item.runAt === 'number') return `once at ${new Date(item.runAt).toLocaleString()}`;
  return 'once, when the session is ready';
}

/** A chain's step texts, in order (steps the window types before or after the prompt itself). */
function chainTexts(item: QueueItemLike, chain: 'beforeChain' | 'afterChain'): string[] {
  const steps = item[chain];
  if (!Array.isArray(steps)) return [];
  return steps.map((step: unknown) => (typeof step === 'object' && step !== null && typeof (step as { text?: unknown }).text === 'string'
    ? (step as { text: string }).text
    : ''));
}

/**
 * Everything turning the prompt on lets run, as the person reads it: the steps before, the prompt, the steps after.
 * A step added after the card opened changes this text, and so the fingerprint, and the gate runs nothing (P5-3).
 */
export function runText(item: QueueItemLike): string {
  const text = typeof item.text === 'string' ? item.text : '';
  const before = chainTexts(item, 'beforeChain').map((t) => `Before: ${t}`);
  const after = chainTexts(item, 'afterChain').map((t) => `After: ${t}`);
  return [...before, before.length + after.length > 0 ? `Prompt: ${text}` : text, ...after].join('\n');
}

/** How a step reads on the card: a bare `/clear` says what it does, since it wipes the session's context (Ruling 68). */
const stepWords = (text: string): string => (isClearStepText(text) ? `${text.trim()} (clears the session’s context)` : text);

/** Does a step of either chain clear the session's context? */
const clearsContext = (item: QueueItemLike): boolean =>
  [...chainTexts(item, 'beforeChain'), ...chainTexts(item, 'afterChain')].some(isClearStepText);

/**
 * What the card shows the person, steps first: "Before each run: /clear (clears the session’s context) → /model opus",
 * then the prompt, then the steps after. The fingerprint stays on `runText`, the steps' raw text.
 */
export function cardText(item: QueueItemLike): string {
  const text = typeof item.text === 'string' ? item.text : '';
  const before = chainTexts(item, 'beforeChain').map(stepWords);
  const after = chainTexts(item, 'afterChain').map(stepWords);
  return [
    ...(before.length > 0 ? [`Before each run: ${before.join(' → ')}`] : []),
    before.length + after.length > 0 ? `Prompt: ${text}` : text,
    ...(after.length > 0 ? [`After each run: ${after.join(' → ')}`] : []),
  ].join('\n');
}

async function itemOf(deps: QueueWriteDeps, sessionId: string, itemId: number): Promise<QueueItemLike> {
  const store = await deps.store();
  const found = store.read(sessionId).items.find((i) => i.id === itemId);
  if (found === undefined) {
    throw new ToolError('NOT_FOUND', 'That session has no queued prompt with that id.', 'Check the id with queue_get.');
  }
  return found;
}

export const queueAskEnableTool = (deps: QueueWriteDeps): ToolDef =>
  defineTool({
    name: 'queue_ask_enable',
    toolset: 'queue',
    title: 'Ask the person to turn a queued prompt on',
    description:
      'Turns one queued prompt ON (a loop, a schedule or a once) in a session you did not open, after the person allows ' +
      'it on a card on the Mac or the paired phone: the way to set up "check it every 5 minutes" on someone else’s ' +
      'session. Add the prompt first (queue_add_item; queue_set_item_schedule for its timing; it stays off), then call ' +
      'this; it answers NEEDS_CONFIRMATION, so tell the person to look at their screen and call confirm_wait. The card ' +
      'shows the steps first and says when one clears the session’s context (/clear); a step changed after the person ' +
      'allows it makes the run do nothing. In a ' +
      `session you opened yourself it asks nothing and turns it on. ${RAILS}`,
    risk: 'ask',
    phase: 3,
    idempotent: true,
    input: { id: SESSION_REF, itemId: ITEM_ID },
    async confirm(args, ctx: ToolContext): Promise<ConfirmAsk | null> {
      const s = resolveTarget(ctx, args.id);
      if (isOwnWorker(ctx, s)) return null;
      const item = await itemOf(deps, s.sessionId, args.itemId);
      const text = runText(item);
      const clears = clearsContext(item) ? ', clearing the session’s context (/clear) before each run' : '';
      return {
        summary: `turn on a queued prompt in session ${refOf(ctx)(s.sessionId)} so AASC sends it on its own, ${timingOf(item)}${clears}`,
        detail: clipText(cardText(item), DETAIL_MAX).text,
        targetSessionId: s.sessionId,
        fingerprint: `${s.terminalId ?? ''}|${args.itemId}|${String(item.type)}|${String(item.intervalMs)}|${String(item.runAt)}|${text}`,
      };
    },
    async run(args, ctx) {
      // Without the person's allow this is queue_set_item_enabled: the lock lets only the central's own worker through.
      const s = ctx.allowedByPerson() ? resolveTarget(ctx, args.id) : startTarget(deps, ctx, args.id);
      if (ctx.allowedByPerson()) ctx.mayDrive(s);
      const change = await writeOp(deps, ctx, s, (state) => setItemEnabled(state, { itemId: args.itemId, enabled: true }));
      return itemAnswer({
        ctx,
        session: s,
        change,
        itemId: args.itemId,
        said: `Turned a queued prompt of session ${nameOf(ctx, s)} on. It can now run on its own when the session is ready.`,
        note: { summary: 'Turned a queued prompt on', targetSessionId: s.sessionId, detail: { itemId: args.itemId, allowedByPerson: ctx.allowedByPerson() } },
      });
    },
  });

/** The tool the registry offers (tools/index.ts), over the server's own queue store. */
export const queueAskEnable: ToolDef = queueAskEnableTool(serverDeps);
