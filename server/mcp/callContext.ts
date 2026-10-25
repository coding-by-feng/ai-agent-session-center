// callContext.ts — the context one call runs with, whoever makes the call: a tool call (server.ts), a resource
// read or a subscription (resources.ts, resourceSubscriptions.ts). One builder, so every way into a tool reaches
// it with the same scope, the same copies and the same view of the central.
//
// What is built holds nothing from the HTTP request but its abort signal: the request's headers carry the
// central's bearer token. The central is the registry's record now (its terminal may have changed since the MCP
// session opened) with the token blanked, and sessions reach a tool scoped to that central, as copies.
//
// Scope is ONE predicate (`inScope`, from scope.ts `scopePredicate` with the central's own workers), read fresh
// at each check; `scopedSessions` is that predicate applied to every session. Steering goes through `mayDrive`
// (policy.ts, with live presence, the person's Esc hold and the ledger's lock, which leaves out only the central's
// own task when it names it: `DriveOptions.ownTaskId`) and tasks through the ledger seen as this central; a card write
// through `mayEdit` and a relaunch through `mayRelaunch` (P3, the same rails); an interrupt, restart, kill or close
// through `mayEnd` (P5-8, whose lock leaves out every task of the caller's own: the person is asked). All of them need
// the P2 runtime (`McpDeps.deliver`); without it they refuse UNAVAILABLE and ids are matched exactly. `confirms` is the
// central's own view of the confirmation book (confirm.ts); its `wait` says when a still-pending card is one a paired
// phone may answer too (phoneAnswerable.ts, P5-25). `allowedByPerson` reads a box only runTool's gate sets:
// true while the call carries out a confirmation the person allowed, false in every context the gate did not build.

import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { canSeeSession } from '../sessionVisibility.js';
import { resolveCentralSession } from './centrals.js';
import { confirms as serverConfirms } from './confirm.js';
import { unwired, unwiredLedger, type DeliverRuntime } from './deliver.js';
import { ledgerFor, type Ledger } from './ledger.js';
import { isOpen } from './ledgerParts.js';
import { phoneMayAnswer, type PhoneAnswerDeps } from './phoneAnswerable.js';
import {
  assertMayEditCard,
  assertMayEnd,
  assertMayHandOff,
  assertMayRelaunch,
  assertMaySteer,
  type SteerContext,
} from './policy.js';
import type { ToolConfirms, ToolContext, ToolResult } from './registry.js';
import { scopePredicate } from './scope.js';
import type { McpDeps } from './server.js';
import { ToolError, type CentralRecord } from './types.js';
import { workers as serverWorkers, workersFor } from './workers.js';

/**
 * The signal of a call nobody can cancel: a completion or a subscription check has no request signal to hand on
 * (the SDK gives those handlers none), and a tool that waits must still be given one.
 */
export const neverAborted: AbortSignal = new AbortController().signal;

/** What a call's context reports to the activity log while the call runs (runTool.ts builds one per call). */
export interface CallAudit {
  /** A policy refusal, as `mayDrive` throws it: logged once, whatever the tool does with it. */
  refused(err: ToolError, targetSessionId: string): void;
}

/** A copy of a central's record with the token blanked: the only form a record leaves the gate in. */
export function withoutToken(record: CentralRecord): CentralRecord {
  return { ...record, toolsets: [...record.toolsets], token: '' };
}

/** Shallow copies: a tool that edits what it was handed cannot change the store's own objects. */
const sessionCopies = (sessions: readonly Session[]): Session[] => sessions.map((s) => ({ ...s }));
const roomCopies = (rooms: readonly Room[]): Room[] =>
  rooms.map((r) => ({ ...r, sessionIds: [...r.sessionIds] }));

/** Without the P2 runtime there is no alias map: an id is a session's only when a session has exactly it. */
const exactIdOnly =
  (deps: McpDeps) =>
  (id: string): string | null =>
    deps.sessions().some((s) => s.sessionId === id) ? id : null;

/** The policy's rails for one call: `mayDrive`, P3's `mayEdit` and `mayRelaunch`, and P5's `mayEnd`. */
type Steering = Pick<ToolContext, 'mayDrive' | 'mayEdit' | 'mayRelaunch' | 'mayEnd'>;

/**
 * Does the session hold a task other than one of the central's own (`ledger` is the central's view, whose `list` is its
 * own tasks)? The lock `mayEnd` asks (P5-8): a session holds one open task at most, so leaving out each own open task
 * in turn leaves out the one it may hold, and another central's still locks it.
 */
export function lockedByAnother(ledger: Pick<Ledger, 'list' | 'isLocked'>, sessionId: string): boolean {
  const own = ledger.list().filter(isOpen);
  return own.length === 0 ? ledger.isLocked(sessionId) : own.every((t) => ledger.isLocked(sessionId, t.taskId));
}

/**
 * The rails for this central: the policy, told the one scope rule, who drove each session last, the ledger's lock as
 * this central sees it (`ledger`: only its own task may be left out), when a central last pressed Esc there, and which
 * terminals are ops shells (the runtime's check, and any card's own `opsTerminalId`). A hand-off to a child central's
 * card (`DriveOptions.handOffTo`) is asked the policy's hand-off rails instead (Ruling P4-8). Every refusal is logged
 * once, as it is thrown (a quiet `mayDrive` excepted).
 */
function steering(
  central: CentralRecord,
  deps: McpDeps,
  deliver: DeliverRuntime,
  ledger: Ledger,
  inScope: (s: Session) => boolean,
  audit: CallAudit | undefined,
): Steering {
  const now = deps.now ?? Date.now;
  const isOpsTerminal = (terminalId: string): boolean =>
    deliver.isOpsTerminal(terminalId) || deps.sessions().some((s) => s.opsTerminalId === terminalId);
  // The lock is the ledger's, with `ownTaskId` left out; `mayEnd` hands in its own (every own task left out).
  const railsFor = (
    ownTaskId?: string,
    isLocked = (sessionId: string): boolean => ledger.isLocked(sessionId, ownTaskId),
  ): SteerContext => ({
    inScope,
    controller: (sessionId) => deliver.controller(sessionId),
    isLocked,
    isOpsTerminal,
    centralEscAt: (sessionId, terminalId) => deliver.centralEscAt?.(sessionId, terminalId) ?? null,
    now,
  });
  const logged = (session: Session, check: () => void, quiet = false): void => {
    try {
      check();
    } catch (err) {
      if (err instanceof ToolError && !quiet) audit?.refused(err, session.sessionId);
      throw err;
    }
  };
  return {
    mayDrive: (session, opts = {}) =>
      logged(
        session,
        () => {
          const rails = railsFor(opts.ownTaskId);
          if (opts.handOffTo) assertMayHandOff(central, opts.handOffTo, session, rails);
          else assertMaySteer(central, session, rails);
        },
        opts.quiet === true,
      ),
    mayEdit: (session, opts = {}) => logged(session, () => assertMayEditCard(central, session, railsFor(), opts)),
    mayRelaunch: (session) => logged(session, () => assertMayRelaunch(central, session, railsFor())),
    mayEnd: (session) =>
      logged(session, () =>
        assertMayEnd(central, session, railsFor(undefined, (sessionId) => lockedByAnother(ledger, sessionId))),
      ),
  };
}

/** Rails that refuse UNAVAILABLE: a server with no P2 runtime writes nothing. */
const unwiredSteering: Steering = {
  mayDrive: () => {
    throw unwired();
  },
  mayEdit: () => {
    throw unwired();
  },
  mayRelaunch: () => {
    throw unwired();
  },
  mayEnd: () => {
    throw unwired();
  },
};

/** How an approved confirmation is carried out: runTool.ts hands its own in; a context it did not build has none. */
export type RunApproved = (confirmId: string) => Promise<ToolResult>;

const noRunApproved: RunApproved = async () => {
  throw new ToolError('UNAVAILABLE', 'A confirmation cannot be carried out from here.', 'Call confirm_wait with its confirmId.');
};

/**
 * What the phone rule (phoneAnswerable.ts) reads, from the sessions as the store holds them at each read: the
 * central's card, the target, and whether each is shared with remote devices (sessionVisibility.ts).
 */
export function phoneAnswerDepsOf(deps: Pick<McpDeps, 'sessions'>): PhoneAnswerDeps {
  const find = (id: string): Session | null => deps.sessions().find((s) => s.sessionId === id) ?? null;
  return {
    getSession: find,
    centralCard: (centralId) => resolveCentralSession(centralId, deps.sessions()),
    isShared: (sessionId) => canSeeSession(false, find(sessionId)),
  };
}

/** The calling central's view of the confirmation book (confirm.ts): its own records only. */
function confirmsFor(centralId: string, deps: McpDeps, signal: AbortSignal, runApproved: RunApproved): ToolConfirms {
  const book = deps.confirms ?? serverConfirms;
  return {
    async wait(confirmId, timeoutMs) {
      const record = book.forCentral(confirmId, centralId);
      if (record === null) {
        throw new ToolError(
          'NOT_FOUND',
          'There is no such confirmation of yours.',
          'It was answered over 10 minutes ago, or it is not yours: call the tool again to ask the person.',
        );
      }
      const state = await book.wait(record.confirmId, centralId, timeoutMs, signal);
      const now = book.forCentral(record.confirmId, centralId) ?? record;
      const phone = state === 'pending' && phoneMayAnswer(now, phoneAnswerDepsOf(deps));
      return { confirmId: record.confirmId, state, expiresAt: record.expiresAt, phone };
    },
    runApproved,
  };
}

/**
 * The context for one call by the central `centralId`: the central as the registry holds it now, and from the
 * request only its abort signal. `audit` is the call's activity reporter (a tool call's; a completion or a
 * subscription check has none), `runApproved` how `ctx.confirms` carries out an approved call (runTool's; any
 * other context refuses it), and `allowedByPerson` the box runTool's gate sets once the person's allow is checked
 * (any other context: never). Throws UNAVAILABLE when the central is no longer live.
 */
export function contextFor(
  centralId: string,
  deps: McpDeps,
  signal: AbortSignal,
  audit?: CallAudit,
  runApproved: RunApproved = noRunApproved,
  allowedByPerson: () => boolean = () => false,
): ToolContext {
  const record = deps.registry.byId(centralId);
  if (record === null) {
    throw new ToolError(
      'UNAVAILABLE',
      'This central is no longer live.',
      'Its terminal closed or it was revoked; ask the person to start a new central.',
    );
  }
  const central = withoutToken(record);
  const own = workersFor(deps.workers ?? serverWorkers, central.centralId);
  const ownWorker = (s: Session): boolean => own.isOwn(central.centralId, s);
  // Built at each check from the rooms and the own workers as they are then: one rule, never a stale copy of it.
  const predicate = (): ((s: Session) => boolean) => scopePredicate(central, deps.rooms(), ownWorker);
  const inScope = (s: Session): boolean => predicate()(s);
  const deliver = deps.deliver;
  const ledger = deliver ? ledgerFor(deliver.ledger, central, deps.rooms) : unwiredLedger;
  return {
    central,
    client: deps.client(central),
    scopedSessions: () => {
      const visible = predicate();
      return sessionCopies(deps.sessions().filter((s) => visible(s)));
    },
    sessions: () => sessionCopies(deps.sessions()),
    rooms: () => roomCopies(deps.rooms()),
    centrals: () => deps.registry.list().map(withoutToken),
    events: deps.events,
    now: deps.now ?? Date.now,
    signal,
    inScope,
    workers: own,
    resolveSessionId: deliver ? (id) => deliver.resolveSessionId(id) : exactIdOnly(deps),
    ledger,
    ...(deliver ? steering(central, deps, deliver, ledger, inScope, audit) : unwiredSteering),
    allowedByPerson,
    confirms: confirmsFor(central.centralId, deps, signal, runApproved),
  };
}
