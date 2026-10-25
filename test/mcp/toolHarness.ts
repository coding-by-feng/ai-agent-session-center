// test/mcp/toolHarness.ts — what the tool tests (tools.*.test.ts) share: session and room fixtures, a fake
// /api client that records every call and answers from a route table, and a ToolContext built the way
// server/mcp/server.ts builds one (scoped copies, a real event hub on a fake bus), so a tool runs here
// exactly as it does behind the endpoint, without a server.
//
// A test file that uses this must mock ../../server/logger.js itself (the event hub logs through it).
import { z } from 'zod';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import type { InternalCallOptions, InternalClient, InternalQuery, InternalResponse } from '../../server/mcp/client.js';
import { forgetTerminalHeard, noteTerminalHeard } from '../../server/heardTerminals.js';
import { lockedByAnother } from '../../server/mcp/callContext.js';
import { unwiredLedger } from '../../server/mcp/deliver.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { Ledger } from '../../server/mcp/ledger.js';
import { changedRefusal, createConfirmBook, stillAsAsked, type ConfirmBook } from '../../server/mcp/confirm.js';
import {
  assertMayEditCard,
  assertMayEnd,
  assertMayHandOff,
  assertMayRelaunch,
  assertMaySteer,
  type SessionController,
} from '../../server/mcp/policy.js';
import { allTools, type ToolContext, type ToolResult } from '../../server/mcp/registry.js';
import { isInScope } from '../../server/mcp/scope.js';
import { ALL_TOOLSETS, ToolError, WAITS_FOR_PERSON, type CentralKind, type CentralRecord } from '../../server/mcp/types.js';
import { createWorkerRegistry, workersFor, type WorkerRegistry } from '../../server/mcp/workers.js';
import { fakeBus } from './centralFixtures.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * A whole Session with only the fields a test names changed: local, idle, in /a/proj, no title of its own. The terminal
 * it names is one AASC has heard a hook from (heardTerminals.ts, Ruling P4-58), as a live card's is once its CLI has
 * spoken; not while the card is `connecting` or carries the never-started marker. `unheard` makes any card one whose
 * CLI has not reported in (a survivor of an AASC restart).
 */
export function makeSession(sessionId: string, over: Partial<Session> = {}): Session {
  if (typeof over.terminalId === 'string' && over.terminalId !== '') {
    if (over.status === 'connecting' || over.startHeard === false) forgetTerminalHeard(over.terminalId);
    else noteTerminalHeard(over.terminalId);
  }
  return {
    sessionId,
    status: 'idle',
    animationState: 'Idle',
    emote: null,
    projectName: 'proj',
    projectPath: '/a/proj',
    title: '',
    source: 'ssh',
    model: '',
    startedAt: 1,
    lastActivityAt: 1_000,
    endedAt: null,
    currentPrompt: '',
    promptHistory: [],
    toolUsage: {},
    totalToolCalls: 0,
    toolLog: [],
    responseLog: [],
    events: [],
    pendingTool: null,
    waitingDetail: null,
    subagentCount: 0,
    terminalId: null,
    cachedPid: null,
    archived: 0,
    queueCount: 0,
    ...over,
  };
}

/** The session, its terminal one AASC has not heard from: a new worker before its first hook, or any after a restart. */
export function unheard<T extends Pick<Session, 'terminalId'>>(s: T): T {
  if (s.terminalId) forgetTerminalHeard(s.terminalId);
  return s;
}

export const makeRoom = (id: string, sessionIds: string[], name = `Room ${id}`): Room => ({
  id,
  name,
  sessionIds,
  collapsed: false,
  createdAt: 0,
});

/** A central as a tool's context holds it: the token blanked. */
export function makeCentral(
  kind: CentralKind = 'global',
  scopeRef: string | null = null,
  over: Partial<CentralRecord> = {},
): CentralRecord {
  return {
    centralId: 'central-1',
    kind,
    scopeRef,
    cli: 'claude',
    permissionMode: null,
    toolsets: [...ALL_TOOLSETS],
    token: '',
    terminalId: 'term-central',
    createdAt: 1,
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The fake /api client
// ---------------------------------------------------------------------------

export interface ApiCall {
  method: string;
  path: string;
  query?: InternalQuery;
  body?: unknown;
  /** The extra headers the call asked for (a cloud binding); absent when it asked for none. */
  headers?: Record<string, string>;
}

export type Answer = InternalResponse<unknown> | ((call: ApiCall) => InternalResponse<unknown>);

export const ok = (data: unknown, status = 200): InternalResponse<unknown> => ({
  ok: true,
  status,
  data,
  error: null,
});

export const fail = (status: number, error: string): InternalResponse<unknown> => ({
  ok: false,
  status,
  data: { error },
  error,
});

/** `{ success: true, data }`, the shape most routes answer in. */
export const envelope = (data: unknown): InternalResponse<unknown> => ok({ success: true, data });

/**
 * Records each call (method, path as the tool wrote it, query, body) and answers from `routes`, keyed
 * `"GET /sessions/s1/chat"`. A route with no entry answers 404.
 */
export function fakeClient(routes: Record<string, Answer> = {}): InternalClient & { calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  async function answer<T>(
    method: string,
    path: string,
    query?: InternalQuery,
    body?: unknown,
    options?: InternalCallOptions,
  ): Promise<InternalResponse<T>> {
    const call: ApiCall = {
      method,
      path,
      ...(query ? { query } : {}),
      ...(body !== undefined ? { body } : {}),
      ...(options?.headers ? { headers: { ...options.headers } } : {}),
    };
    calls.push(call);
    const route = routes[`${method} ${path}`];
    const response = route === undefined ? fail(404, 'Not found') : typeof route === 'function' ? route(call) : route;
    return response as InternalResponse<T>;
  }
  return {
    calls,
    get: <T>(path: string, query?: InternalQuery, options?: InternalCallOptions) => answer<T>('GET', path, query, undefined, options),
    post: <T>(path: string, body?: unknown, options?: InternalCallOptions) => answer<T>('POST', path, undefined, body, options),
    put: <T>(path: string, body?: unknown, options?: InternalCallOptions) => answer<T>('PUT', path, undefined, body, options),
    patch: <T>(path: string, body?: unknown, options?: InternalCallOptions) => answer<T>('PATCH', path, undefined, body, options),
    del: <T>(path: string, body?: unknown, options?: InternalCallOptions) => answer<T>('DELETE', path, undefined, body, options),
  };
}

// ---------------------------------------------------------------------------
// The tool context
// ---------------------------------------------------------------------------

export const NOW = 1_700_000_000_000;

export interface CtxOptions {
  central?: CentralRecord;
  sessions?: Session[];
  rooms?: Room[];
  centrals?: CentralRecord[];
  routes?: Record<string, Answer>;
  now?: number;
  signal?: AbortSignal;
  /**
   * The sessions centrals opened themselves (server/mcp/workers.ts): a room central's scope takes the central's own,
   * and the unattended lock lets them through. By default an empty registry that reads `controller` as presence.
   */
  workers?: WorkerRegistry;
  /** Old session id → newer one (a re-key, a restore); a chain is followed to its end. */
  aliases?: Record<string, string>;
  /** The ledger `ctx.ledger` is; by default one that refuses UNAVAILABLE (as an unwired server's does). */
  ledger?: Ledger;
  /** Who drove each session last, for `ctx.mayDrive`'s 60-second rule; nobody by default. */
  controller?: (sessionId: string) => SessionController | null;
  isOpsTerminal?: (terminalId: string) => boolean;
  /**
   * The confirmation book `ctx.confirms` reads (server/mcp/confirm.ts): a test that answers a confirmation passes its
   * own. A fresh real book by default.
   */
  confirmBook?: ConfirmBook;
  /**
   * What `ctx.allowedByPerson()` answers (runTool's gate sets it after a checked allow): a tool test of a run the person
   * allowed passes a box it sets. Never allowed by default.
   */
  allowedByPerson?: () => boolean;
}

export interface Harness {
  ctx: ToolContext;
  client: ReturnType<typeof fakeClient>;
  bus: ReturnType<typeof fakeBus>;
  /** The book `ctx.confirms` reads. */
  confirmBook: ConfirmBook;
  /** The sessions the context holds (the store's own objects: what a tool must never change). */
  sessions: Session[];
  rooms: Room[];
}

const copyRoom = (r: Room): Room => ({ ...r, sessionIds: [...r.sessionIds] });

/**
 * A context for `central`, built like callContext.ts's `contextFor`: shallow copies, one scope rule (`inScope`, which
 * `scopedSessions` applies, the central's own workers included), aliases followed, the real policy behind `mayDrive`,
 * `mayEdit`, `mayRelaunch` and `mayEnd` (with `controller` and the ledger's lock; `mayEnd`'s leaves out the central's
 * own tasks, as callContext.ts's `lockedByAnother` does), and `confirms` over a real book.
 */
export function makeCtx(opts: CtxOptions = {}): Harness {
  const central = opts.central ?? makeCentral();
  const sessions = opts.sessions ?? [];
  const rooms = opts.rooms ?? [];
  const client = fakeClient(opts.routes);
  const bus = fakeBus();
  const ledger = opts.ledger ?? unwiredLedger;
  const now = (): number => opts.now ?? NOW;
  const workers = workersFor(opts.workers ?? createWorkerRegistry({ controller: opts.controller ?? (() => null) }), central.centralId);
  const ownWorker = (s: Session): boolean => workers.isOwn(central.centralId, s);
  const inScope = (s: Session): boolean => isInScope(central, s, rooms.map(copyRoom), ownWorker);
  const resolveSessionId = (id: string): string | null => {
    let current = id;
    for (let hop = 0; hop < 16; hop += 1) {
      if (sessions.some((s) => s.sessionId === current)) return current;
      const next = opts.aliases?.[current];
      if (next === undefined) return null;
      current = next;
    }
    return null;
  };
  const confirmBook = opts.confirmBook ?? createConfirmBook();
  const railsOf = () => ({
    inScope,
    controller: opts.controller ?? (() => null),
    isLocked: (id: string) => ledger.isLocked(id),
    isOpsTerminal: opts.isOpsTerminal ?? (() => false),
    now,
  });
  const ctx: ToolContext = {
    central,
    client,
    scopedSessions: () => sessions.filter(inScope).map((s) => ({ ...s })),
    sessions: () => sessions.map((s) => ({ ...s })),
    rooms: () => rooms.map(copyRoom),
    centrals: () => (opts.centrals ?? [central]).map((c) => ({ ...c, toolsets: [...c.toolsets], token: '' })),
    events: createEventHub(bus.subscribe),
    now,
    signal: opts.signal ?? new AbortController().signal,
    inScope,
    workers,
    resolveSessionId,
    ledger,
    mayDrive: (session, drive) => {
      const rails = railsOf();
      if (drive?.handOffTo) assertMayHandOff(central, drive.handOffTo, session, rails);
      else assertMaySteer(central, session, rails);
    },
    mayEdit: (session, edit) => assertMayEditCard(central, session, railsOf(), edit),
    mayRelaunch: (session) => assertMayRelaunch(central, session, railsOf()),
    mayEnd: (session) => assertMayEnd(central, session, { ...railsOf(), isLocked: (id: string) => lockedByAnother(ledger, id) }),
    allowedByPerson: opts.allowedByPerson ?? (() => false),
    confirms: harnessConfirms(central.centralId, confirmBook, () => ctx, opts.signal),
  };
  return { ctx, client, bus, sessions, rooms, confirmBook };
}

/**
 * `ctx.confirms` over `book`, as callContext.ts builds it for the calling central. `runApproved` here does what
 * runTool's gate does for an approved call (a tool test has no runTool around it): uses the record once, asks the
 * tool's `confirm` again and refuses CHANGED unless it is still the card the person allowed (`stillAsAsked`), then runs
 * the registered tool with the stored arguments on the same context, `ctx.allowedByPerson()` true only when a card was
 * still needed.
 */
function harnessConfirms(
  centralId: string,
  book: ConfirmBook,
  ctxOf: () => ToolContext,
  signal: AbortSignal | undefined,
): ToolContext['confirms'] {
  return {
    async wait(confirmId, timeoutMs) {
      const record = book.forCentral(confirmId, centralId);
      if (record === null) throw new ToolError('NOT_FOUND', 'There is no such confirmation of yours.');
      const state = await book.wait(record.confirmId, centralId, timeoutMs, signal ?? new AbortController().signal);
      return { confirmId: record.confirmId, state, expiresAt: record.expiresAt };
    },
    async runApproved(confirmId) {
      const record = book.consume(confirmId, centralId);
      if (record === null) throw new ToolError('INVALID', 'That confirmation was already used, or was not allowed.');
      const tool = allTools().find((t) => t.name === record.tool);
      if (tool === undefined) throw new ToolError('UNAVAILABLE', 'That tool is no longer yours.');
      // As the gate: a tool that waits for the person but cannot ask is never run (P5-2, fails closed).
      if (WAITS_FOR_PERSON.has(tool.risk) && tool.confirm === undefined) {
        throw new ToolError('UNAVAILABLE', 'That tool cannot ask the person in this build.', 'Tell the person.');
      }
      const args = structuredClone({ ...record.args });
      // One context for the recheck and the run, as runTool gives a call (a tool may key state from confirm to run on it).
      let allowed = false;
      const callCtx: ToolContext = { ...ctxOf(), allowedByPerson: () => allowed };
      const again = (await tool.confirm?.(args, callCtx)) ?? null;
      if (again !== null && !stillAsAsked(record, again)) throw changedRefusal();
      allowed = again !== null;
      return tool.run(args, callCtx);
    },
  };
}

// ---------------------------------------------------------------------------
// Running a tool
// ---------------------------------------------------------------------------

/** Runs a registered tool the way the endpoint does: arguments through its input shape, then `run`. */
export async function run(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> {
  const tool = allTools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`No registered tool named ${name}`);
  const parsed = await z.object(tool.input).safeParseAsync(args);
  if (!parsed.success) throw new Error(`Arguments refused for ${name}: ${parsed.error.message}`);
  return tool.run(parsed.data as Record<string, unknown>, ctx);
}

/** The ToolError a tool throws (the test fails when it answers instead, or throws something else). */
export async function runRefused(name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<ToolError> {
  try {
    await run(name, args, ctx);
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error(`${name} answered; a ToolError was expected`);
}

/** The data a tool answered, typed by the caller. */
export async function dataOf<T = Record<string, unknown>>(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<T> {
  return (await run(name, args, ctx)).data as T;
}

/** Counts the occurrences of a string, for "exactly one fence" checks. */
export const countOf = (text: string, needle: string): number => text.split(needle).length - 1;
