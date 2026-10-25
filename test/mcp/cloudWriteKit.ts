// test/mcp/cloudWriteKit.ts — what the P6 cloud write tests share: a tool context on a Mac connected to AASC Cloud as
// account A or B (the status route answers whichever is connected at each call), with its window open, and the two
// ways a card is allowed:
//   * `allowNext`: the next card opened in the harness's book is allowed as it opens, so the gate's wait (runTool) sees
//     the allow at once;
//   * `askAndRun`: what the gate does for a call the person allowed, on the harness alone: `confirm` asks, the card is
//     opened and allowed, then `ctx.confirms.runApproved` asks `confirm` again and runs the tool on one context
//     (toolHarness.ts). `between` runs after the allow and before the recheck: switch the account there.
//
// A test file that uses this must mock ../../server/logger.js itself (the event hub logs through it).
import { z } from 'zod';
import { allTools, type ConfirmAsk, type ToolResult } from '../../server/mcp/registry.js';
import type { CentralKind } from '../../server/mcp/types.js';
import { CONNECTION, CONNECTION_B, STATUS_PATH } from './cloudFixtures.js';
import { envelope, makeCentral, makeCtx, ok, type CtxOptions, type Harness } from './toolHarness.js';

export type Account = 'A' | 'B';

const CONNECTIONS: Readonly<Record<Account, object>> = { A: CONNECTION, B: CONNECTION_B };

/** The scope a central of each kind has in these tests. */
const SCOPE: Readonly<Record<CentralKind, string | null>> = { global: null, room: 'room-1', project: '/a/proj' };

/** GET /presence with the Mac's window open: a card can be answered there. */
export const MAC_OPEN = ok({ ok: true, data: { devices: [{ clientId: 'mac-1', isLocal: true, connections: 1 }], workspaceWriter: 'mac-1' } });

/** How each harness's status route is switched (`switchAccount`). */
const switches = new WeakMap<Harness, (to: Account) => void>();

/**
 * A context for a central of `kind` (global by default) on a Mac connected as `account` (A by default), its window open.
 * `routes` are merged over those two.
 */
export function cloudCtx(opts: CtxOptions & { kind?: CentralKind; account?: Account } = {}): Harness {
  const { kind = 'global', account = 'A', ...rest } = opts;
  let connected: Account = account;
  const h = makeCtx({
    ...rest,
    central: rest.central ?? makeCentral(kind, SCOPE[kind]),
    routes: {
      [STATUS_PATH]: () => envelope({ connection: CONNECTIONS[connected], state: 'connected', lastError: null }),
      'GET /presence': MAC_OPEN,
      ...rest.routes,
    },
  });
  switches.set(h, (to) => {
    connected = to;
  });
  return h;
}

/** From now on the status route of `h` says the Mac is connected as `to`. */
export function switchAccount(h: Harness, to: Account): void {
  const flip = switches.get(h);
  if (flip === undefined) throw new Error('switchAccount needs a harness made by cloudCtx');
  flip(to);
}

/** Allows the next card opened in `h`'s book the moment it opens, as a person at the Mac would (book.answer). */
export function allowNext(h: Harness): void {
  const stop = h.confirmBook.onChange((e) => {
    if (e.kind !== 'opened') return;
    stop();
    h.confirmBook.answer(e.confirm.cardId, 'allow');
  });
}

/** The registered tool's `confirm`, with its arguments through its input shape: what the person would be asked. */
export async function askOf(h: Harness, name: string, args: Record<string, unknown>): Promise<ConfirmAsk | null> {
  const tool = allTools().find((t) => t.name === name);
  if (tool?.confirm === undefined) throw new Error(`No registered tool named ${name} with a confirm`);
  const parsed = (await z.object(tool.input).parseAsync(args)) as Record<string, unknown>;
  return tool.confirm(parsed, h.ctx);
}

/**
 * A call of a waiting tool the person allows: asks (`confirm`), opens the card in `h`'s book and allows it, runs
 * `between`, then carries it out through `ctx.confirms.runApproved` (the recheck and the run on one context).
 */
export async function askAndRun(
  h: Harness,
  name: string,
  args: Record<string, unknown>,
  between?: () => void,
): Promise<{ ask: ConfirmAsk; result: ToolResult }> {
  const tool = allTools().find((t) => t.name === name);
  if (tool === undefined) throw new Error(`No registered tool named ${name}`);
  const parsed = (await z.object(tool.input).parseAsync(args)) as Record<string, unknown>;
  const ask = await askOf(h, name, parsed);
  if (ask === null) throw new Error(`${name} asked nothing`);
  const record = h.confirmBook.open({
    centralId: h.ctx.central.centralId,
    tool: name,
    risk: tool.risk,
    args: parsed,
    summary: ask.summary,
    detail: ask.detail ?? null,
    targetSessionId: ask.targetSessionId ?? null,
    fingerprint: ask.fingerprint ?? null,
  });
  h.confirmBook.answer(record.cardId, 'allow');
  between?.();
  return { ask, result: await h.ctx.confirms.runApproved(record.confirmId) };
}
