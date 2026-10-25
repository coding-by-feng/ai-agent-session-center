// deliverWiring.ts — the server's own P2 runtime (deliver.ts), built from the live pieces: the session store, the
// terminals' exit feed and hook signals, presence, the database, and the prompt route's submitter. The composition
// root (server/index.ts) builds it once and hands it to the /mcp router as `McpDeps.deliver`:
//
//     createMcpRouter({ ..., deliver: createServerDeliver(centrals, centralClient) })
//
// Kept apart from deliver.ts and the ledger so that they stay testable without the store, the PTYs or SQLite; this
// module only joins them (test/mcp/deliverWiring.test.ts mocks what it imports).
//
// A cancel presses its Esc through a submitter of its own (createServerPromptSubmitter): the prompt route's Esc,
// with its checks (the session still in that terminal, mid-turn or at a dialog, its agent in front). An Esc takes no
// place in a terminal's line of prompts, so the two submitters need not be one. The ledger notes each Esc in the
// server's book of central Escs (escHold.ts), which the policy reads for the person's Esc hold (Ruling 47).
//
// Also from here: the agent-in-front check (Ruling 50: the terminal's foreground program, as the prompt route reads
// it), the highest task id the activity log holds (Ruling 49), the session queue's own resume prompt, and the releases
// of the centrals' own workers (workers.ts, Ruling P4-3): when a worker's terminal exits, and when its central is revoked
// or the person turns hands-off on for it — then the run the central left in its queue is paused (centralRun.ts,
// Rulings P4-25, P4-30). The queue store (queueWiring.ts) is loaded only when the first such pause runs.
//
// And P4's two background jobs, both stopped by the runtime's close(): the re-router (rerouter.ts, Ruling P4-7), which
// routes a task again as its central, in a context built as a tool call's is (callContext.ts) on the rooms the server
// passes in (`options.rooms`; its event hub hears nothing: neither job waits on a broadcast); and the idle clean-up
// (cleanup.ts, Ruling P4-11), which closes a central's own idle workers, reading their queues without writing them.
// close() also stops the worker releases, the hands-off handler and the ledger's own timers and listeners (P4-28).
//
// And P5's typed notices (notices.ts, Ruling P5-13), built only when `mcp.notices` is on (read at start, default off:
// Ruling P5-19): they type through the same submitter as the cancel's Esc, so the two take turns in a terminal, and
// read the queue with its automation (auto-send holds a notice back). close() stops them too.

import type Database from 'better-sqlite3';
import type { Room } from '../../src/types/room.js';
import { dbHandle, getSessionQueue } from '../db.js';
import { onTerminalHook } from '../hookSignals.js';
import log from '../logger.js';
import { isAgentProcessName } from '../mobile/phoneProfile.js';
import { getController } from '../presenceManager.js';
import { createServerPromptSubmitter } from '../promptWiring.js';
import { getAllSessions, getSession, resolveSessionId } from '../sessionStore.js';
import { getForegroundProcess, isOpsTerminal, onTerminalExit } from '../sshManager.js';
import { createActivityLog, type SqlDatabase } from './activity.js';
import { contextFor, neverAborted, withoutToken } from './callContext.js';
import { onHandsOffTurnedOn, releaseOnHandsOff, stopCentralRun, type CentralRunDeps } from './centralRun.js';
import { resolveCentralSession, type CentralRegistry } from './centrals.js';
import { startIdleCleanup } from './cleanup.js';
import type { InternalClient } from './client.js';
import { createDeliverRuntime, type DeliverRuntime } from './deliver.js';
import { confirms } from './confirm.js';
import { centralEscBook } from './escHold.js';
import { createEventHub } from './events.js';
import { createLedger } from './ledger.js';
import { ledgerApi } from './ledgerApi.js';
import type { QueueItemLike } from './queueOps.js';
import type { ToolContext } from './registry.js';
import { startRerouter } from './rerouter.js';
import { createNoticeBox } from './notices.js';
import { noticesOn } from './routerConfig.js';
import type { McpDeps } from './server.js';
import { isRecord } from './tools/define.js';
import type { CentralRecord } from './types.js';
import { wireWorkerReleases, workers } from './workers.js';

/** The server's database as the activity log reads it: positional parameters only. */
function sqlite(db: Database.Database): SqlDatabase {
  return { exec: (sql) => db.exec(sql), prepare: (sql) => db.prepare<unknown[]>(sql) };
}

/** The session queue's own resume prompt (its stored automation's `resumePrompt`), or null when it sets none. */
function queueResumePrompt(sessionId: string): string | null {
  try {
    const automation = getSessionQueue(sessionId)?.automation;
    const prompt = isRecord(automation) ? automation.resumePrompt : null;
    return typeof prompt === 'string' && prompt.trim() !== '' ? prompt : null;
  } catch (err) {
    log.debug('mcp', `Reading a queue's resume prompt failed: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** A session queue's items, read only (for the idle clean-up); none when it has no queue. */
function queueItems(sessionId: string): { items: QueueItemLike[]; automation: null } {
  const items = getSessionQueue(sessionId)?.items;
  return { items: Array.isArray(items) ? (items as QueueItemLike[]) : [], automation: null };
}

/** A session queue's items and its stored automation, read only (for the notices' auto-send check). */
function queueState(sessionId: string): { items: QueueItemLike[]; automation: unknown } {
  const queue = getSessionQueue(sessionId);
  return { items: Array.isArray(queue?.items) ? (queue.items as QueueItemLike[]) : [], automation: queue?.automation ?? null };
}

export interface ServerDeliverOptions {
  /** The Mac's room list now (apiRouter.ts `currentRooms`), for the re-router's contexts; none by default. */
  rooms?: () => Room[];
}

/**
 * The P2 runtime on the live server. `client` is the /api client a central's calls use (`centralClient`, which calls
 * as `mcp:<centralId>`): a task's prompt goes out as the central that sent it.
 */
export function createServerDeliver(
  registry: CentralRegistry,
  client: (central: CentralRecord) => InternalClient,
  options: ServerDeliverOptions = {},
): DeliverRuntime {
  const submitter = createServerPromptSubmitter();
  const clientFor = (centralId: string): InternalClient | null => {
    const record = registry.byId(centralId);
    return record === null ? null : client(withoutToken(record));
  };
  const activity = createActivityLog({ db: () => sqlite(dbHandle()) });
  const ledger = createLedger({
    ...ledgerApi(clientFor),
    onTerminalHook,
    onTerminalExit,
    getSession,
    interrupt: (sessionId, terminalId) => submitter.interrupt({ sessionId, terminalId }),
    noteCentralEsc: (sessionId, terminalId) => centralEscBook.note(sessionId, terminalId),
    agentInFront: (terminalId) => isAgentProcessName(getForegroundProcess(terminalId)),
    lastTaskNumber: () => activity.maxTaskNumber(),
    resumePromptOf: queueResumePrompt,
    now: Date.now,
  });
  const sessions = () => Object.values(getAllSessions());
  const centralSessionOf = (centralId: string): string | null => resolveCentralSession(centralId, sessions())?.sessionId ?? null;
  const runDeps: CentralRunDeps = {
    queue: async () => (await import('./queueWiring.js')).serverQueueStore(),
    activity,
    cardIn: (terminalId) => sessions().find((s) => s.terminalId === terminalId && s.status !== 'ended') ?? null,
    centralSessionOf,
    now: Date.now,
  };
  const stopReleases = wireWorkerReleases(workers, {
    onTerminalExit,
    centrals: registry,
    onRevoked: (released) => {
      for (const w of released) void stopCentralRun(w.terminalId, { centralId: w.centralId, reason: 'revoked' }, runDeps);
    },
  });
  const stopHandsOff = onHandsOffTurnedOn(releaseOnHandsOff({ ...runDeps, workers }));
  const runtime = createDeliverRuntime({
    ledger,
    activity,
    controller: getController,
    resolveSessionId,
    isOpsTerminal,
    centralEscAt: (sessionId, terminalId) => centralEscBook.at(sessionId, terminalId),
    sessions,
  });

  const mcp: McpDeps = {
    registry,
    client,
    sessions,
    rooms: options.rooms ?? (() => []),
    events: createEventHub(() => () => undefined),
    deliver: runtime,
    workers,
  };
  const contextOf = (centralId: string): ToolContext | null => {
    try {
      return contextFor(centralId, mcp, neverAborted);
    } catch {
      return null;
    }
  };
  const stopRerouter = startRerouter({ ledger, contextOf, activity, centralSessionOf });
  const cleanup = startIdleCleanup({
    workers,
    sessions,
    centrals: registry,
    client,
    ledger,
    queue: async () => ({ read: queueItems }),
    activity,
    now: Date.now,
    centralSessionOf,
  });
  const notices = noticesOn()
    ? createNoticeBox({
        registry,
        sessions,
        ledger,
        confirms,
        onTerminalHook,
        controller: getController,
        readQueue: async (sessionId) => queueState(sessionId),
        submit: (req) => submitter.submit(req),
        activity,
        on: () => true,
        now: Date.now,
      })
    : null;
  return {
    ...runtime,
    close() {
      notices?.close();
      stopRerouter();
      cleanup.close();
      stopReleases();
      stopHandsOff();
      ledger.close();
      runtime.close();
    },
  };
}
