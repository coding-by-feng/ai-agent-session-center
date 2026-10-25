// cleanup.ts — the idle clean-up: AASC closes a central's own worker that has sat idle too long (Ruling P4-11).
//
// Every 5 minutes it looks at the sessions centrals opened themselves (workers.ts; a person's session, or one a
// person drove since it opened, is no central's). One that is idle or waiting and whose last activity is older than
// `mcp.idleWorkerMinutes` (30 by default, 0 = never), or one whose CLI never reported that it started (the card's
// `startHeard` is false) a minute past the new-worker start window (NEW_WORKER_START_MS: it holds a slot; this one is
// closed even with idle clean-up off), is closed as its central, through DELETE /sessions/:id on
// the internal client, and stops being its own ('closed'). Each is judged again, card and lock, right before its
// DELETE. Never closed, whatever its idle time:
//   pinned       the person pinned it
//   hands-off    the person marked it so
//   a task       it holds a task a central gave it (the ledger's lock)
//   adopted      a person drove it since it opened (the registry releases it as it is asked)
//   queued work  its queue holds an item switched on (read only: the queue store's `read`, never a write)
// A queue that cannot be read keeps the worker open. The exclusions are ownIdle.ts's (`keptByPerson`, `hasEnabledItem`),
// the rule P5's restart and close use without the minutes, so the two cannot drift. Each close is a row of the central's
// activity log, in AASC's words and ids: "close #<short> (its own worker, idle 30 min)" or "(its own worker, never
// started)".

import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import type { ActivityLog } from './activity.js';
import { withoutToken } from './callContext.js';
import type { CentralRegistry } from './centrals.js';
import type { InternalClient } from './client.js';
import type { Ledger } from './ledger.js';
import { NEW_WORKER_START_MS } from './ledgerReroute.js';
import { hasEnabledItem, keptByPerson } from './ownIdle.js';
import type { QueueStore } from './queueOps.js';
import { idleWorkerMinutes } from './routerConfig.js';
import { shortIdOf } from './scope.js';
import { seg } from './tools/define.js';
import type { CentralRecord } from './types.js';
import type { WorkerRegistry } from './workers.js';

/** How often the clean-up looks. */
export const CLEANUP_EVERY_MS = 5 * 60_000;
const MINUTE_MS = 60_000;
/**
 * A worker still `connecting` this long after it opened never started (its folder may be waiting for the person to
 * trust it): its task failed at NEW_WORKER_START_MS, and it holds one of its central's slots. A minute's grace on top.
 */
const NEVER_STARTED_MS = NEW_WORKER_START_MS + 60_000;

export interface CleanupDeps {
  workers: Pick<WorkerRegistry, 'ownerOf' | 'release'>;
  sessions(): readonly Session[];
  centrals: Pick<CentralRegistry, 'byId'>;
  /** The /api client calling as this central (`mcp:<centralId>`). */
  client(central: CentralRecord): InternalClient;
  ledger: Pick<Ledger, 'isLocked'>;
  /** The queue store (read only). */
  queue(): Promise<Pick<QueueStore, 'read'>>;
  activity: Pick<ActivityLog, 'logActivity'>;
  /** Minutes idle before a worker is closed; `mcp.idleWorkerMinutes` by default. 0 = never. */
  minutes?: number;
  now(): number;
  /** The card a central runs in, for its rows; none by default. */
  centralSessionOf?(centralId: string): string | null;
}

export interface IdleCleanup {
  /** One look now: the ids it closed. */
  sweep(): Promise<string[]>;
  close(): void;
}

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** A worker the clean-up would close, with its central and why. */
interface Due {
  session: Session;
  central: CentralRecord;
  why: 'idle' | 'never started';
}

export function startIdleCleanup(deps: CleanupDeps): IdleCleanup {
  const minutes = deps.minutes ?? idleWorkerMinutes();
  let running = false;

  /** Why this card is due to close by its status and times alone: idle too long, or never started; else null. */
  function dueBy(s: Session, now: number): Due['why'] | null {
    if (!s.terminalId) return null;
    // The connecting timeout flips every claude/codex card to idle at 30 s whether or not its CLI spoke, so the
    // card's status cannot say it never started; `startHeard: false` (no hook from its terminal) does (Ruling P4-44).
    if (s.startHeard === false && now - s.startedAt > NEVER_STARTED_MS) return 'never started';
    if (minutes <= 0) return null;
    if (s.status !== 'idle' && s.status !== 'waiting') return null;
    return s.lastActivityAt <= now - minutes * MINUTE_MS ? 'idle' : null;
  }

  /** The card as a clean-up candidate, with its central and why: everything but the queue checked. */
  function due(s: Session): Due | null {
    const why = dueBy(s, deps.now());
    if (why === null) return null;
    const owner = deps.workers.ownerOf(s);
    const central = owner === null ? null : deps.centrals.byId(owner);
    if (central === null || keptByPerson(s, deps.ledger) !== null) return null;
    return { session: s, central, why };
  }

  function summaryOf(d: Due): string {
    const why = d.why === 'idle' ? `idle ${minutes} min` : 'never started';
    return `close #${shortIdOf(d.session.sessionId)} (its own worker, ${why})`;
  }

  async function closeOne(seen: Due, store: Pick<QueueStore, 'read'>): Promise<boolean> {
    // The card and the lock again, right before its DELETE: an earlier close was awaited, and in that gap a central may
    // have given this worker a task, or a person a prompt.
    const card = deps.sessions().find((x) => x.sessionId === seen.session.sessionId);
    const d = card === undefined ? null : due(card);
    if (d === null || d.central.centralId !== seen.central.centralId) return false;
    const { session: s, central } = d;
    try {
      if (hasEnabledItem(store.read(s.sessionId).items)) return false;
    } catch (err) {
      log.debug('mcp', `Reading a worker's queue failed, so it stays open: ${describe(err)}`);
      return false;
    }
    const res = await deps.client(withoutToken(central)).del(`/sessions/${seg(s.sessionId)}`);
    if (!res.ok) {
      log.warn('mcp', `Closing an idle worker of central ${central.centralId} failed (HTTP ${res.status})`);
      return false;
    }
    deps.workers.release(s.terminalId ?? '', 'closed');
    try {
      deps.activity.logActivity({
        centralId: central.centralId,
        centralSessionId: deps.centralSessionOf?.(central.centralId) ?? null,
        tool: 'idle_cleanup',
        risk: 'write',
        targetSessionId: s.sessionId,
        taskId: null,
        summary: summaryOf(d),
        outcome: 'ok',
        detail:
          d.why === 'idle'
            ? { idleMinutes: Math.floor((deps.now() - s.lastActivityAt) / MINUTE_MS) }
            : { neverStarted: true, startedMinutes: Math.floor((deps.now() - s.startedAt) / MINUTE_MS) },
      });
    } catch (err) {
      log.warn('mcp', `Logging an idle worker's close failed: ${describe(err)}`);
    }
    return true;
  }

  async function sweep(): Promise<string[]> {
    if (running) return [];
    running = true;
    try {
      const seen = deps.sessions().flatMap((s) => {
        const d = due(s);
        return d === null ? [] : [d];
      });
      if (seen.length === 0) return [];
      const store = await deps.queue();
      const closed: string[] = [];
      for (const d of seen) {
        if (await closeOne(d, store)) closed.push(d.session.sessionId);
      }
      return closed;
    } catch (err) {
      log.warn('mcp', `The idle clean-up failed: ${describe(err)}`);
      return [];
    } finally {
      running = false;
    }
  }

  // Always running: with idle clean-up off (minutes 0) a worker that never started must still give its slot back.
  const timer = setInterval(() => void sweep(), CLEANUP_EVERY_MS);
  timer.unref?.();
  return {
    sweep,
    close() {
      clearInterval(timer);
    },
  };
}
