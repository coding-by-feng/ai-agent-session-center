// ownIdle.ts — when ending a session needs no card: the central's own idle worker (Ruling P5-4). The idle clean-up's
// rule (cleanup.ts, Ruling P4-11) without its minutes, so the two cannot drift: cleanup.ts imports `keptByPerson` and
// `hasEnabledItem` from here.
//
// `ownIdleReason` answers null (no card) only when every one of these holds, and otherwise the first that fails:
//   not-own           the card is the caller's own worker (workers.ts; a person who gave it input has adopted it)
//   pinned            the person did not pin it
//   hands-off         the person did not mark it hands-off
//   a task            it holds no task (any central's: the ledger's lock)
//   not-idle          its status is idle or waiting
//   queued-work       its queue holds no prompt switched on (an item without the `disabled` mark)
//   queue-unreadable  and that queue could be read
// The queue is read last, and only when everything else holds. It is for session_restart and session_close only; a
// kill always asks (P5-5). The tool checks `ctx.allowedByPerson()` again when it runs: an exempt call whose card needs
// asking by then is refused.
//
// Pure apart from `readQueue` (and a debug line when it fails): nothing here writes, and the clock is not read.

import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import type { Ledger } from './ledger.js';
import type { QueueItemLike } from './queueOps.js';
import type { ToolContext } from './registry.js';

/** Why ending this session needs the person's card; `ownIdleReason` answers null when it needs none. */
export type CardReason = 'not-own' | 'pinned' | 'hands-off' | 'a task' | 'not-idle' | 'queued-work' | 'queue-unreadable';

/** Does the queue hold an item switched on (one without the `disabled` mark)? */
export const hasEnabledItem = (items: readonly QueueItemLike[]): boolean => items.some((i) => i.disabled !== true);

/** Why the person keeps this worker (a P4-11 exclusion that needs no queue), or null. */
export function keptByPerson(s: Session, ledger: Pick<Ledger, 'isLocked'>): 'pinned' | 'hands-off' | 'a task' | null {
  if (s.pinned === true) return 'pinned';
  if (s.handsOff === true) return 'hands-off';
  if (ledger.isLocked(s.sessionId)) return 'a task';
  return null;
}

/**
 * Why restarting or closing `s` needs the person's card, in the header's order; null when it is the caller's own idle
 * worker that nobody keeps and whose queue holds nothing switched on. A queue that cannot be read needs a card.
 */
export async function ownIdleReason(
  ctx: Pick<ToolContext, 'central' | 'workers' | 'ledger'>,
  s: Session,
  readQueue: (sessionId: string) => Promise<readonly QueueItemLike[]>,
): Promise<CardReason | null> {
  if (!ctx.workers.isOwn(ctx.central.centralId, s)) return 'not-own';
  const kept = keptByPerson(s, ctx.ledger);
  if (kept !== null) return kept;
  if (s.status !== 'idle' && s.status !== 'waiting') return 'not-idle';
  let items: readonly QueueItemLike[];
  try {
    items = await readQueue(s.sessionId);
  } catch (err) {
    log.debug('mcp', `Reading a worker's queue failed, so ending it needs a card: ${err instanceof Error ? err.message : String(err)}`);
    return 'queue-unreadable';
  }
  return hasEnabledItem(items) ? 'queued-work' : null;
}
