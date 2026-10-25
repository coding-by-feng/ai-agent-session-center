// workers.ts — the sessions a central opened itself: its own workers (Ruling P4-3).
//
// openWorker.ts records each session a central opens. Being its own gives the central three things: a room central sees
// the worker before the workspace writer has filed it into the room (scope.ts), the unattended lock lets it through
// (unattended.ts, P4-12), and a prompt it queues there is added on (tools/queueWrite.ts).
//
// A worker is kept by its terminal id, never by its session id: AASC files a new session under `term-…` and the CLI's
// first hook re-keys the card to the CLI's own id, in the same terminal (p4-facts §9). It stops being the central's own,
// for good, when:
//   exited    its terminal exits (the terminals' exit feed, `wireWorkerReleases`)
//   adopted   a person drives it: its presence controller is a client that is not a central (`mcp:`) and gave it
//             input after the worker opened — typed, sent a prompt, answered a request (`lastInputAt`, Ruling P4-23);
//             a resize or a clear moves the baton but is not input (checked whenever the registry is asked)
//   revoked   its central is revoked (the central registry's change feed, `wireWorkerReleases`); the run the central
//             left in its queue is stopped (centralRun.ts, Ruling P4-25)
//   hands-off the person turned hands-off on for it (handsOffSetter.ts, Ruling P4-30): it is theirs now
//   closed    AASC closed it (the idle clean-up)
//
// In memory only: a central's workers end with the process, as the central does. Records go in and out as copies.

import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import { getController } from '../presenceManager.js';
import type { CentralRegistry } from './centrals.js';
import { MCP_CLIENT_PREFIX, type SessionController } from './policy.js';

export interface OwnWorker {
  centralId: string;
  terminalId: string;
  /** Epoch ms of the open: a person's activity before it does not adopt the worker. */
  openedAt: number;
  folder: string;
  cli: 'claude' | 'codex';
}

/** Why a worker stopped being its central's own. */
export type ReleaseReason = 'exited' | 'adopted' | 'revoked' | 'hands-off' | 'closed';

export interface WorkerRegistry {
  add(w: OwnWorker): void;
  /** The central whose own worker this session is (by its terminal), or null. A person who drove it since releases it. */
  ownerOf(session: Session): string | null;
  isOwn(centralId: string, session: Session): boolean;
  /** The central's own workers as recorded, as copies. */
  of(centralId: string): readonly OwnWorker[];
  /** How many of the central's own workers are live in `sessions` (a card that has ended is not), one per terminal. */
  liveCount(centralId: string, sessions: readonly Session[]): number;
  release(terminalId: string, why: ReleaseReason): void;
  /** Every worker of the central, when it is revoked; answers the workers it released, as copies. */
  releaseCentral(centralId: string): readonly OwnWorker[];
  /** Called after each change that happened (not for a no-op). Returns the unsubscribe. */
  onChange(l: () => void): () => void;
  /** How many workers the central opened at or after `since`, released ones included (the rolling-minute budget). */
  opensSince(centralId: string, since: number): number;
  /**
   * An open the central made that is not its own worker (a resume or a reconnect: openWorker.ts `openThroughRoute`):
   * counted by `opensSince`, never live, never the central's.
   */
  noteOpen(centralId: string, at: number): void;
}

/** What a call sees of the registry (`ToolContext.workers`): bound to the calling central. */
export type WorkersView = Pick<WorkerRegistry, 'isOwn' | 'of' | 'liveCount'>;

/** Who holds a session's baton, and when they last gave it input (absent: never; presence's `lastInputAt`). */
export type WorkerController = SessionController & { lastInputAt?: number };

export interface WorkerRegistryOptions {
  /** Who drove a session last; defaults to presence (presenceManager.ts). */
  controller?: (sessionId: string) => WorkerController | null;
}

/**
 * The open times kept per central (its own workers' and the opens `noteOpen` records). The budget allows 10 opens a
 * minute and only an open that was let through is recorded, so the last 64 always cover the last minute.
 */
const OPENS_KEPT = 64;

const copyOf = (w: OwnWorker): OwnWorker => ({ ...w });

export function createWorkerRegistry(opts: WorkerRegistryOptions = {}): WorkerRegistry {
  const controller = opts.controller ?? getController;
  // Terminal id → the only copy of its worker. An entry is replaced or removed, never edited.
  const byTerminal = new Map<string, OwnWorker>();
  const opens = new Map<string, readonly number[]>();
  const listeners = new Set<() => void>();

  function notify(): void {
    for (const listener of [...listeners]) listener();
  }

  function release(terminalId: string, why: ReleaseReason): void {
    if (!byTerminal.delete(terminalId)) return;
    log.debug('mcp', `A worker in terminal ${terminalId.slice(0, 12)} is no longer its central's own (${why})`);
    notify();
  }

  /** Has a person given the session input since the worker opened (a resize or a clear is not input, P4-23)? */
  function adopted(worker: OwnWorker, session: Session): boolean {
    const holder = controller(session.sessionId);
    return holder !== null && !holder.clientId.startsWith(MCP_CLIENT_PREFIX) && (holder.lastInputAt ?? 0) > worker.openedAt;
  }

  function ownerOf(session: Session): string | null {
    const worker = session.terminalId ? byTerminal.get(session.terminalId) : undefined;
    if (worker === undefined) return null;
    if (adopted(worker, session)) {
      release(worker.terminalId, 'adopted');
      return null;
    }
    return worker.centralId;
  }

  const recordOpen = (centralId: string, at: number): void => {
    opens.set(centralId, [...(opens.get(centralId) ?? []), at].slice(-OPENS_KEPT));
  };

  return {
    add(w) {
      byTerminal.set(w.terminalId, copyOf(w));
      recordOpen(w.centralId, w.openedAt);
      notify();
    },
    noteOpen: recordOpen,
    ownerOf,
    isOwn: (centralId, session) => ownerOf(session) === centralId,
    of: (centralId) => [...byTerminal.values()].filter((w) => w.centralId === centralId).map(copyOf),
    liveCount(centralId, sessions) {
      const live = sessions.filter((s) => s.status !== 'ended' && ownerOf(s) === centralId);
      return new Set(live.map((s) => s.terminalId)).size;
    },
    release,
    releaseCentral(centralId) {
      opens.delete(centralId);
      const theirs = [...byTerminal.values()].filter((w) => w.centralId === centralId);
      if (theirs.length === 0) return [];
      for (const w of theirs) byTerminal.delete(w.terminalId);
      log.debug('mcp', `A revoked central's ${theirs.length} worker(s) are no longer its own`);
      notify();
      return theirs.map(copyOf);
    },
    onChange(l) {
      listeners.add(l);
      return () => {
        listeners.delete(l);
      };
    },
    opensSince: (centralId, since) => (opens.get(centralId) ?? []).filter((at) => at >= since).length,
  };
}

/** The view a call by `centralId` gets: it answers about that central's workers only (another's: none). */
export function workersFor(registry: WorkerRegistry, centralId: string): WorkersView {
  const mine = (id: string): boolean => id === centralId;
  return {
    isOwn: (id, session) => mine(id) && registry.isOwn(id, session),
    of: (id) => (mine(id) ? registry.of(id) : []),
    liveCount: (id, sessions) => (mine(id) ? registry.liveCount(id, sessions) : 0),
  };
}

/** The feeds that end a worker's ownership by themselves. */
export interface WorkerReleaseFeeds {
  /** The terminals' exit feed (sshManager.ts `onTerminalExit`). */
  onTerminalExit(listener: (terminalId: string) => void): () => void;
  /** The central registry: a central no longer in it was revoked. */
  centrals: Pick<CentralRegistry, 'list' | 'onChange'>;
  /** Told the workers a revoke released (deliverWiring.ts stops the runs they were left with, Ruling P4-25). */
  onRevoked?(released: readonly OwnWorker[]): void;
}

/**
 * Releases a worker when its terminal exits ('exited') and all of a central's when it is revoked, telling `onRevoked`
 * which. deliverWiring.ts wires the server's registry this way; returns the unsubscribe.
 */
export function wireWorkerReleases(registry: WorkerRegistry, feeds: WorkerReleaseFeeds): () => void {
  const stopExits = feeds.onTerminalExit((terminalId) => registry.release(terminalId, 'exited'));
  const liveIds = (): ReadonlySet<string> => new Set(feeds.centrals.list().map((c) => c.centralId));
  let known = liveIds();
  const stopCentrals = feeds.centrals.onChange(() => {
    const now = liveIds();
    for (const id of known) {
      if (now.has(id)) continue;
      const released = registry.releaseCentral(id);
      if (released.length > 0) feeds.onRevoked?.(released);
    }
    known = now;
  });
  return () => {
    stopExits();
    stopCentrals();
  };
}

/** The registry the server runs on. */
export const workers: WorkerRegistry = createWorkerRegistry();
