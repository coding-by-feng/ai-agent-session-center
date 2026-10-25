// test/mcp/resourceBookWorld.ts — what the subscription book's tests share: a book built for a central over a small
// world, on a fake broadcast feed, with the notifications it sends collected; the time its default delay takes; and
// the ToolError a call throws. (The book is server/mcp/resourceSubscriptions.ts; its tests run under fake timers.)
import { vi } from 'vitest';
import { createCentralRegistry, type MintInput } from '../../server/mcp/centrals.js';
import { createEventHub, type EventHub } from '../../server/mcp/events.js';
import { allTools, MCP_MAX_PHASE, toolsFor } from '../../server/mcp/registry.js';
import { offerResources } from '../../server/mcp/resourceDefs.js';
import {
  createResourceSubscriptions,
  RESOURCE_UPDATE_DEBOUNCE_MS,
} from '../../server/mcp/resourceSubscriptions.js';
import type { McpDeps } from '../../server/mcp/server.js';
import { ToolError } from '../../server/mcp/types.js';
import { fakeBus, globalInput } from './centralFixtures.js';
import { freshWorld, type World } from './resourceWorld.js';
import { fakeClient, NOW } from './toolHarness.js';

export interface BookOptions {
  debounceMs?: number;
  notify?: (uri: string) => void;
  /** A hub of the test's own, in place of one over the fake feed. */
  events?: EventHub;
}

export function book(
  input: MintInput = globalInput(),
  world: World = freshWorld(),
  options: BookOptions = {},
) {
  const registry = createCentralRegistry();
  const central = registry.mint(input);
  const bus = fakeBus();
  const notified: string[] = [];
  const deps: McpDeps = {
    registry,
    client: () => fakeClient(world.routes),
    sessions: () => world.sessions,
    rooms: () => world.rooms,
    events: options.events ?? createEventHub(bus.subscribe),
    now: () => NOW,
  };
  const offered = offerResources(central, toolsFor(central, MCP_MAX_PHASE, allTools()));
  const subs = createResourceSubscriptions({
    centralId: central.centralId,
    deps,
    offered,
    notify: options.notify ?? ((uri) => void notified.push(uri)),
    ...(options.debounceMs === undefined ? {} : { debounceMs: options.debounceMs }),
  });
  return { subs, bus, notified, world, registry, central, deps };
}

/** Lets what the book has waiting come due: the default delay and a little more. */
export const due = (): void => {
  vi.advanceTimersByTime(RESOURCE_UPDATE_DEBOUNCE_MS + 100);
};

/** The ToolError a call throws (the test fails when it answers, or throws something else). */
export async function toolError(call: Promise<unknown>): Promise<ToolError> {
  try {
    await call;
  } catch (err) {
    if (err instanceof ToolError) return err;
    throw err;
  }
  throw new Error('a ToolError was expected');
}
