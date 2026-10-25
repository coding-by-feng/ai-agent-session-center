// test/mcp/deliverFixtures.ts — a deliver runtime for tests (server/mcp/deliver.ts): a real ledger on fake deps
// (ledgerFixtures.ts), a real activity log on an in-memory SQLite database (`node:sqlite`, the same SQL the
// server runs through better-sqlite3), and stand-ins for presence, the alias map and the ops-shell check.
//
// Pass `testDeliver().deliver` as `McpDeps.deliver` to give an endpoint, a server or a context the P2 rails. A test
// file that uses this must mock ../../server/logger.js itself.
import { DatabaseSync } from 'node:sqlite';
import type { Session } from '../../src/types/session.js';
import { createActivityLog } from '../../server/mcp/activity.js';
import { createDeliverRuntime } from '../../server/mcp/deliver.js';
import { createLedger, type Ledger } from '../../server/mcp/ledger.js';
import type { SessionController } from '../../server/mcp/policy.js';
import { fakeLedgerDeps } from './ledgerFixtures.js';

export interface TestDeliverOptions {
  /** Old session id → newer one; a chain is followed to its end (as sessionStore's alias map is). */
  aliases?: Record<string, string>;
  /** Who drove each session last; nobody by default. */
  controller?: (sessionId: string) => SessionController | null;
  isOpsTerminal?: (terminalId: string) => boolean;
  /** A ledger of the test's own; by default a real one on `ledgerDeps`. */
  ledger?: Ledger;
  /** The sessions the runtime finds a central's card among (for the activity rows of task changes). */
  sessions?: () => readonly Session[];
  now?: () => number;
}

/** Follows `aliases` from `id` to the end of its chain (at most 16 hops; a cycle is no id). */
export function aliasResolver(aliases: Record<string, string>): (id: string) => string | null {
  return (id) => {
    let current = id;
    for (let hop = 0; hop < 16; hop += 1) {
      const next = aliases[current];
      if (next === undefined) return current;
      current = next;
    }
    return null;
  };
}

export function testDeliver(opts: TestDeliverOptions = {}) {
  const db = new DatabaseSync(':memory:');
  const activity = createActivityLog({ db: () => db, ...(opts.now ? { now: opts.now } : {}), pruneEveryMs: null });
  const ledgerDeps = fakeLedgerDeps();
  const ledger = opts.ledger ?? createLedger(ledgerDeps.deps);
  const deliver = createDeliverRuntime({
    ledger,
    activity,
    controller: opts.controller ?? (() => null),
    resolveSessionId: aliasResolver(opts.aliases ?? {}),
    isOpsTerminal: opts.isOpsTerminal ?? (() => false),
    ...(opts.sessions ? { sessions: opts.sessions } : {}),
  });
  /** Every row the activity table holds, as the database has it (column names as stored). */
  const rawRows = (): Array<Record<string, unknown>> =>
    db.prepare('SELECT * FROM mcp_activity ORDER BY id').all() as Array<Record<string, unknown>>;
  return { deliver, activity, ledger, ledgerDeps, db, rawRows };
}
