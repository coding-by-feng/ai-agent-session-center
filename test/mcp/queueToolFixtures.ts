// test/mcp/queueToolFixtures.ts — what the queue write tool tests share: the tools on a fake store, called the way the
// endpoint calls them (arguments through the input shape, then `run`), a context for a global central over sessions a
// central may steer, the `GET /presence` answer that says whether a window is open to run the queue, and a world that
// runs the tools through `runTool` on a deliver runtime with a real activity log.
//
// The tools are LOCKED by default, as the server's are (Ruling 42: until P4 a central starts no unattended run, so
// turning a prompt or auto-send on, and ⚡ NOW, are refused DENIED; Rulings 43 and 53 add changes to a prompt that is on,
// resuming the queue, releasing a cancel's hold and the looser automation rules). `unlocked: true` stands in for what P4
// will do for a central's own worker: the lock's one helper lets the call through, and everything after it (the
// steering rails, the dialog guard, the window check, the ops) is what the tests of those pieces run.
import { z } from 'zod';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import { neverAborted } from '../../server/mcp/callContext.js';
import { createCentralRegistry, type MintInput } from '../../server/mcp/centrals.js';
import { createEventHub } from '../../server/mcp/events.js';
import type { ToolDef, ToolResult } from '../../server/mcp/registry.js';
import { runTool } from '../../server/mcp/runTool.js';
import type { McpDeps } from '../../server/mcp/server.js';
import type { QueueStore } from '../../server/mcp/queueOps.js';
import { createQueueWriteTools } from '../../server/mcp/tools/queueWrite.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { testDeliver } from './deliverFixtures.js';
import { automationOf, fakeQueueStore, item, NOW, type FakeQueueStore } from './queueFixtures.js';
import { fakeClient, makeCtx, makeSession, ok, type CtxOptions } from './toolHarness.js';

/**
 * The queue every tool is tried on: a paused prompt (id 1) with a before step (id 10), and a loop that is on (id 2).
 * Prompt 1 is paused so that a central may change its text, timing and steps: the same change to a prompt that is on is
 * locked (Ruling 43, tools.queueWriteLockMore.test.ts).
 */
export const standardRows = () => ({
  s1: {
    items: [
      item(1, { position: 0, disabled: true, beforeChain: [{ id: 10, text: 'first step' }] }),
      item(2, { position: 1, type: 'loop', intervalMs: 60_000, nextFireAt: NOW + 5_000 }),
    ],
    automation: automationOf(),
  },
});

/** The 15 queue writes of the catalog. */
export const WRITES = [
  'queue_add_item',
  'queue_edit_item',
  'queue_remove_item',
  'queue_move_item',
  'queue_set_item_enabled',
  'queue_set_item_schedule',
  'queue_fire_now',
  'queue_add_step',
  'queue_edit_step',
  'queue_remove_step',
  'queue_move_step',
  'queue_set_paused',
  'queue_set_auto_send',
  'queue_set_automation',
  'queue_resume_after_cancel',
];

/** Each tool with arguments that work on `standardRows`. */
export const CASES: Array<[string, Record<string, unknown>]> = [
  ['queue_add_item', { id: 's1', text: 'do the next thing' }],
  ['queue_edit_item', { id: 's1', itemId: 1, text: 'new words' }],
  ['queue_remove_item', { id: 's1', itemId: 1 }],
  ['queue_move_item', { id: 's1', itemId: 1, position: 1 }],
  ['queue_set_item_enabled', { id: 's1', itemId: 1, enabled: false }],
  ['queue_set_item_schedule', { id: 's1', itemId: 1, type: 'loop', intervalMs: 600_000 }],
  ['queue_fire_now', { id: 's1', itemId: 2 }],
  ['queue_add_step', { id: 's1', itemId: 1, chain: 'after', text: 'wrap up' }],
  ['queue_edit_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, text: 'better first step' }],
  ['queue_remove_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10 }],
  ['queue_move_step', { id: 's1', itemId: 1, chain: 'before', stepId: 10, position: 0 }],
  ['queue_set_paused', { id: 's1', paused: true }],
  ['queue_set_auto_send', { id: 's1', autoSend: false }],
  ['queue_set_automation', { id: 's1', autoEnter: false }],
  ['queue_resume_after_cancel', { id: 's1' }],
];

/** The CASES that make the window send by itself, which go ahead only with the lock let through (Rulings 42 and 43). */
export const STARTS: ReadonlySet<string> = new Set(['queue_fire_now', 'queue_resume_after_cancel']);

/** The route `queue_resume_after_cancel` calls. */
export const RESUME_ROUTE = { 'POST /sessions/s1/queue/resume': ok({ ok: true, resumed: true }) };


/** What `GET /presence` answers: a window (a device that saves the workspace) is connected, or none is. */
export const presence = (writer: string | null): Record<string, ReturnType<typeof ok>> => ({
  'GET /presence': ok({ ok: true, data: { devices: [], controllers: [], restoreOwner: null, workspaceWriter: writer } }),
});

/** A session a central may steer: local, with a terminal, waiting. */
export const worker = (sessionId: string, over: Partial<Session> = {}): Session =>
  makeSession(sessionId, { terminalId: `term-${sessionId}`, status: 'waiting', title: `Worker ${sessionId}`, ...over });

/** The queue write tools over `store`: locked (Ruling 42) unless `unlocked`, which stands in for a central's own worker. */
export const toolsOver = (store: QueueStore, opts: { unlocked?: boolean } = {}): readonly ToolDef[] =>
  createQueueWriteTools({ store: async () => store, ...(opts.unlocked === true ? { mayStartUnattended: () => undefined } : {}) });

export function toolNamed(tools: readonly ToolDef[], name: string): ToolDef {
  const found = tools.find((t) => t.name === name);
  if (found === undefined) throw new Error(`No queue write tool named ${name}`);
  return found;
}

/** Runs one of `tools` the way the endpoint does: the arguments through its input shape, then `run`. */
export async function callOn(
  tools: readonly ToolDef[],
  name: string,
  args: Record<string, unknown>,
  ctx: Parameters<ToolDef['run']>[1],
): Promise<ToolResult> {
  const def = toolNamed(tools, name);
  const parsed = await z.object(def.input).safeParseAsync(args);
  if (!parsed.success) throw new Error(`Arguments refused for ${name}: ${parsed.error.message}`);
  return def.run(parsed.data as Record<string, unknown>, ctx);
}

/** Does the input shape of `name` accept these arguments? (What the endpoint checks before `run`.) */
export const accepts = (tools: readonly ToolDef[], name: string, args: Record<string, unknown>): boolean =>
  z.object(toolNamed(tools, name).input).safeParse(args).success;

export interface QueueWorldOptions extends Omit<CtxOptions, 'sessions'> {
  sessions?: Session[];
  /** The rows the store starts with. */
  rows?: Parameters<typeof fakeQueueStore>[0];
  /** The device that saves the workspace; null for none (the default: a window is open). */
  writer?: string | null;
  /** Let the lock's helper pass (what P4 does for a central's own worker); by default the server's lock holds. */
  unlocked?: boolean;
}

/** A context, a store and the tools over it. By default one worker `s1`, an empty queue and a window open. */
export function queueWorld(opts: QueueWorldOptions = {}) {
  const { sessions = [worker('s1')], rows = {}, writer = 'device-1', unlocked = false, routes, ...rest } = opts;
  const store: FakeQueueStore = fakeQueueStore(rows);
  const tools = toolsOver(store, { unlocked });
  const h = makeCtx({ ...rest, sessions, routes: { ...presence(writer), ...routes } });
  const call = (name: string, args: Record<string, unknown>) => callOn(tools, name, args, h.ctx);
  const refused = async (name: string, args: Record<string, unknown>): Promise<ToolError> => {
    try {
      await call(name, args);
    } catch (err) {
      if (err instanceof ToolError) return err;
      throw err;
    }
    throw new Error(`${name} answered; a ToolError was expected`);
  };
  return { ...h, store, tools, call, refused };
}

export interface LoggedWorldOptions {
  input?: MintInput;
  rooms?: Room[];
  /** Run without the P2 runtime (no activity log, no steering rails), as a server that never wired it does. */
  unwired?: boolean;
  /** The device that saves the workspace (a window is open); null for none. Default: one. */
  writer?: string | null;
  /** Let the lock's helper pass (what P4 does for a central's own worker). */
  unlocked?: boolean;
  /** Replaces the sessions: by default the central's card, an idle worker `s1`, a hands-off `s2` and `s3` (driven 5 s ago). */
  sessions?: Session[];
}

/**
 * A central, an idle worker `s1` it may steer, a hands-off one `s2`, one a person drove 5 s ago `s3`, and the tools on a
 * fake store; calls go through `runTool` on a deliver runtime with a real activity log.
 */
export function loggedWorld(opts: LoggedWorldOptions = {}) {
  const registry = createCentralRegistry();
  const central = registry.mint(opts.input ?? globalInput());
  const card: Session = makeSession('card-1', {
    terminalId: 'term-card',
    central: { centralId: central.centralId, kind: central.kind, scopeRef: central.scopeRef },
  });
  const sessions: Session[] = opts.sessions ?? [card, worker('s1'), worker('s2', { handsOff: true }), worker('s3')];
  const t = testDeliver({
    sessions: () => sessions,
    controller: (id) => (id === 's3' ? { clientId: 'device-1', lastActivityAt: NOW - 5_000 } : null),
  });
  const store = fakeQueueStore(standardRows());
  const tools = toolsOver(store, { unlocked: opts.unlocked === true });
  const deps: McpDeps = {
    registry,
    client: () => fakeClient({ ...presence(opts.writer === undefined ? 'device-1' : opts.writer), ...RESUME_ROUTE }),
    sessions: () => sessions,
    rooms: () => opts.rooms ?? [],
    events: createEventHub(fakeBus().subscribe),
    now: () => NOW,
    ...(opts.unwired === true ? {} : { deliver: t.deliver }),
  };
  const call = (name: string, args: Record<string, unknown>) =>
    runTool(toolNamed(tools, name), args, { centralId: central.centralId, deps, signal: neverAborted, via: 'call' });
  const failure = async (name: string, args: Record<string, unknown>): Promise<ToolError> => {
    try {
      await call(name, args);
    } catch (err) {
      if (err instanceof ToolError) return err;
      throw err;
    }
    throw new Error(`${name} answered; a ToolError was expected`);
  };
  return { ...t, central, store, tools, call, failure };
}
