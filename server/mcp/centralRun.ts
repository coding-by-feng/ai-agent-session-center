// centralRun.ts — stopping the run a central left in one of its own workers (Rulings P4-25, P4-30).
//
// A central may set its own worker's queue running unattended (P4-12: auto-send on, enabled items). When the central is
// gone (revoked: workers.ts `releaseCentral`) or the person turns hands-off on for that worker (it is theirs now), the
// window must not go on typing those prompts with nobody reading the answers (what Ruling 42 exists to prevent). So the
// worker's queue gets the write queue_pause makes — `paused: true`, and auto-resume off — through queueOps. Its items
// stay; the person resumes it. A queue that runs nothing (no auto-send, no enabled item, no auto-resume) or is paused
// already is left alone. One activity row per worker, as its central's, in AASC's words.
//
// The server wiring is deliverWiring.ts: it hands `stopCentralRun` the released workers of a revoke (wireWorkerReleases'
// `onRevoked`) and installs `releaseOnHandsOff` as the hands-off handler (`onHandsOffTurnedOn`), which the setter the
// dashboard's route is handed (handsOffSetter.ts) calls when the switch turns on. The handler is installed rather than
// imported because the setter is built in server/index.ts before the runtime that holds the activity log.

import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import type { ActivityLog } from './activity.js';
import { applyQueueOp, setAutomation, setPaused, type QueueOp, type QueueState, type QueueStore } from './queueOps.js';
import { shortIdOf } from './scope.js';
import type { WorkerRegistry } from './workers.js';

/** The origin of the queue write, so every window applies it (never its own echo) and can tell what made it. */
export const CENTRAL_RUN_ORIGIN = 'mcp-release';

export type CentralRunReason = 'revoked' | 'hands-off';

export interface CentralRunStop {
  /** The central whose worker it was (the row is that central's). */
  centralId: string;
  reason: CentralRunReason;
}

export interface CentralRunDeps {
  /** The server's queue store (queueWiring.ts), loaded when first needed. */
  queue(): Promise<QueueStore>;
  activity: Pick<ActivityLog, 'logActivity'>;
  /** The live card in this terminal, or null. */
  cardIn(terminalId: string): Session | null;
  /** The card a central runs in, for its rows. */
  centralSessionOf?(centralId: string): string | null;
  now(): number;
}

const WHY: Readonly<Record<CentralRunReason, string>> = {
  revoked: 'its central was revoked',
  'hands-off': 'the person turned hands-off on',
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** Would the window send anything from this queue on its own? */
function runs(state: QueueState): boolean {
  const a = state.automation;
  if (a?.paused === true && a.autoResume !== true) return false;
  return a?.autoSend === true || a?.autoResume === true || state.items.some((i) => i.disabled !== true);
}

/** queue_pause's write, with auto-resume off as well. */
const pauseOp =
  (now: number): QueueOp<{ changed: string[] }> =>
  (state) => {
    const paused = setPaused(state, true);
    const off = setAutomation({ items: paused.items, automation: paused.automation }, { autoResume: false }, now);
    return { ...off, result: { changed: ['paused', 'autoResume'] } };
  };

/**
 * Pauses the queue of the worker in `terminalId` when it runs anything, with one activity row. Answers whether it
 * paused it. Never throws: a queue it could not write is a 'failed' row and a log line.
 */
export async function stopCentralRun(terminalId: string, stop: CentralRunStop, deps: CentralRunDeps): Promise<boolean> {
  const card = deps.cardIn(terminalId);
  if (card === null) return false;
  const row = (outcome: 'ok' | 'failed', summary: string): void => {
    try {
      deps.activity.logActivity({
        centralId: stop.centralId,
        centralSessionId: deps.centralSessionOf?.(stop.centralId) ?? null,
        tool: 'central_run_stop',
        risk: 'write',
        targetSessionId: card.sessionId,
        taskId: null,
        summary,
        outcome,
        detail: { reason: stop.reason },
      });
    } catch (err) {
      log.warn('mcp', `Logging a stopped central run failed: ${describe(err)}`);
    }
  };
  const short = shortIdOf(card.sessionId);
  try {
    const store = await deps.queue();
    if (!runs(store.read(card.sessionId))) return false;
    applyQueueOp(store, card.sessionId, pauseOp(deps.now()), CENTRAL_RUN_ORIGIN);
  } catch (err) {
    log.warn('mcp', `Pausing the queue of a central's worker failed (${stop.reason}): ${describe(err)}`);
    row('failed', `could not pause the queue of #${short} (${WHY[stop.reason]})`);
    return false;
  }
  log.info('mcp', `Paused the queue of central ${stop.centralId}'s worker in terminal ${terminalId.slice(0, 12)} (${stop.reason})`);
  row('ok', `paused the queue of #${short} (${WHY[stop.reason]}); its prompts are kept`);
  return true;
}

/**
 * The hands-off handler: a card that is a central's own worker is released (it is the person's now) and its run
 * stopped. A person's own session, or a worker already released, is left alone.
 */
export function releaseOnHandsOff(
  deps: CentralRunDeps & { workers: Pick<WorkerRegistry, 'ownerOf' | 'release'> },
): (card: Session) => void {
  return (card) => {
    const terminalId = card.terminalId;
    if (!terminalId) return;
    const centralId = deps.workers.ownerOf(card);
    if (centralId === null) return;
    deps.workers.release(terminalId, 'hands-off');
    void stopCentralRun(terminalId, { centralId, reason: 'hands-off' }, deps);
  };
}

let handsOffHandler: ((card: Session) => void) | null = null;

/** Installs the handler `handsOffTurnedOn` calls (deliverWiring.ts); returns the removal. */
export function onHandsOffTurnedOn(handler: (card: Session) => void): () => void {
  handsOffHandler = handler;
  return () => {
    if (handsOffHandler === handler) handsOffHandler = null;
  };
}

/** Hands-off just turned on for this card (handsOffSetter.ts). Never throws. */
export function handsOffTurnedOn(card: Session): void {
  try {
    handsOffHandler?.(card);
  } catch (err) {
    log.warn('mcp', `Releasing a worker on hands-off failed: ${describe(err)}`);
  }
}
