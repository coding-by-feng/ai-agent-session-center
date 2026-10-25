// test/mcp/deliverToolFixtures.ts — what the P2 delivery tool tests share (tools.deliver*.test.ts, tools.tasks.test.ts):
// workers a global central may steer, the answers the prompt route gives, and a tool context whose ledger is a real one
// on fake deps (ledgerFixtures.ts), seen as the central sees it (`ledgerFor`). Its `mayDrive` is the real policy as
// callContext.ts asks it: the lock skipped for the caller's own task when a tool names it (`ownTaskId`), and a
// central's own Esc (`centralEscAt`) exempt from the person's Esc hold. Its `mayEnd` leaves out every own task, as
// callContext.ts's does (Ruling P5-8).
//
// A test file that uses this must mock ../../server/logger.js itself. Nothing here reaches a terminal or a process.
import { createLedger, ledgerFor, type Ledger } from '../../server/mcp/ledger.js';
import { lockedByAnother } from '../../server/mcp/callContext.js';
import { assertMayEditCard, assertMayEnd, assertMayHandOff, assertMayRelaunch, assertMaySteer } from '../../server/mcp/policy.js';
import type { DriveOptions, EditOptions, ToolContext } from '../../server/mcp/registry.js';
import type { Session } from '../../src/types/session.js';
import { fakeLedgerDeps, type FakeLedgerDeps } from './ledgerFixtures.js';
import {
  makeCentral,
  makeCtx,
  makeSession,
  ok,
  type Answer,
  type ApiCall,
  type CtxOptions,
  type Harness,
} from './toolHarness.js';

/** A worker: local, waiting for a prompt, on its own terminal, in /a/proj. */
export const worker = (id: string, over: Partial<Session> = {}): Session =>
  makeSession(id, { terminalId: `term-${id}`, status: 'waiting', ...over });

/** What the prompt route answers when it takes a prompt (202), echoing the key it was sent. */
export const taken: Answer = (call: ApiCall) =>
  ok({ success: true, data: { accepted: true, key: (call.body as { key?: string } | undefined)?.key ?? '' } }, 202);

/** What the prompt route answers when it refuses: its status, words and code. */
export const refusedBy = (status: number, error: string, code?: string): Answer =>
  ({ ok: false, status, data: { success: false, error, ...(code ? { code } : {}) }, error });

/** The prompt route of each worker, taking everything. */
export const promptRoutes = (...ids: string[]): Record<string, Answer> =>
  Object.fromEntries(ids.map((id) => [`POST /sessions/${id}/prompt`, taken]));

/** The prompt bodies a fake client was sent, in order. */
export const promptBodies = (h: Pick<Harness, 'client'>): Array<Record<string, unknown>> =>
  h.client.calls.filter((c) => c.method === 'POST' && /\/prompt$/.test(c.path)).map((c) => c.body as Record<string, unknown>);

export interface DeliverCtxOptions extends Omit<CtxOptions, 'ledger'> {
  /** Another ledger than the fake-deps one (for a test that shares one between two centrals). */
  ledger?: Ledger;
  /** When a central last pressed Esc in a session (escHold.ts); never by default. */
  centralEscAt?: (sessionId: string, terminalId: string | null) => number | null;
}

/** A tool context for the global `central`, its ledger real (on `f`'s fake deps) and seen as that central sees it. */
export function deliverCtx(opts: DeliverCtxOptions = {}): Harness & { f: FakeLedgerDeps; base: Ledger } {
  const central = opts.central ?? makeCentral();
  const f = fakeLedgerDeps();
  const base = opts.ledger ?? createLedger(f.deps);
  const sessions = opts.sessions ?? [];
  for (const s of sessions) f.setSession(s);
  const rooms = opts.rooms ?? [];
  const ledger = ledgerFor(base, central, () => rooms);
  const h = makeCtx({ ...opts, central, sessions, rooms, ledger });
  const railsOf = (ownTaskId?: string) => ({
    inScope: h.ctx.inScope,
    controller: opts.controller ?? (() => null),
    isLocked: (id: string) => ledger.isLocked(id, ownTaskId),
    isOpsTerminal: opts.isOpsTerminal ?? (() => false),
    centralEscAt: opts.centralEscAt ?? (() => null),
    now: h.ctx.now,
  });
  const ctx: ToolContext = {
    ...h.ctx,
    mayDrive: (session: Session, drive?: DriveOptions) => {
      const rails = railsOf(drive?.ownTaskId);
      if (drive?.handOffTo) assertMayHandOff(central, drive.handOffTo, session, rails);
      else assertMaySteer(central, session, rails);
    },
    mayEdit: (session: Session, edit?: EditOptions) => assertMayEditCard(central, session, railsOf(), edit),
    mayRelaunch: (session: Session) => assertMayRelaunch(central, session, railsOf()),
    mayEnd: (session: Session) =>
      assertMayEnd(central, session, { ...railsOf(), isLocked: (id: string) => lockedByAnother(ledger, id) }),
  };
  return { ...h, ctx, f, base };
}
