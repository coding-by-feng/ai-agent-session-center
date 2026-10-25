// server.ts — the MCP server one central talks to: its name, its playbook, and the tools its toolsets
// allow at this build's phase, every one answering in the same shape.
//
// One McpServer is built per MCP session (index.ts), for the central that opened it. What it is given is
// that central's record with the token blanked: nothing built here ever holds a token, so nothing here can
// put one in a result, an error, a log line or the playbook.
//
// Every tool answers `{ ok, data?, code?, message?, hint? }` as `structuredContent`, with a line of text
// beside it for a client that reads only `content`:
//   success      { ok: true, data }                    text: the tool's summary
//   ToolError    { ok: false, code, message, hint, data? }  isError; text: code, message, hint and each data line
//   other error  { ok: false, code: 'UPSTREAM', ... }  isError; fixed text, the details only in the log
// AASC answers tools/call itself (`answerToolCalls`), so refusals before a tool runs share that envelope:
// a tool the central was not given is NOT_FOUND, arguments its input shape refuses are INVALID. A tool runs
// through runTool.ts, the one way into its `run`: a read of a resource that is its answer goes the same way.
//
// A tool's context takes nothing from the HTTP request but its abort signal: the request's headers carry
// the central's bearer token. Sessions reach a tool scoped to its central, as copies (callContext.ts, which
// resource reads and subscriptions use too).
//
// Beside its tools the server offers the central its resources (resources.ts: a tool's answer under an aasc://
// URI, subscribable) and prompts (prompts.ts), each only when the tools it needs are the central's.

import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  CallToolRequestSchema,
  type CallToolResult,
  type ServerCapabilities,
  type ToolAnnotations,
} from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import type { Room } from '../../src/types/room.js';
import type { Session } from '../../src/types/session.js';
import log from '../logger.js';
import { withoutToken } from './callContext.js';
import type { CentralRegistry } from './centrals.js';
import type { InternalClient } from './client.js';
import { sessionCompleter } from './completion.js';
import type { ConfirmBook } from './confirm.js';
import type { DeliverRuntime } from './deliver.js';
import type { EventHub } from './events.js';
import { centralInstructions } from './instructions.js';
import { registerPrompts } from './prompts.js';
import { allTools, MCP_MAX_PHASE, toolsFor, type ToolDef } from './registry.js';
import { registerResources } from './resources.js';
import { logArgumentRefusal, runTool, upstreamFailure } from './runTool.js';
import { ToolError, type CentralRecord } from './types.js';
import type { WorkerRegistry } from './workers.js';

/** The name centrals know AASC's server by: their tools appear as `mcp__aasc__<tool>`. */
export const MCP_SERVER_NAME = 'aasc';

/** The version of the /mcp surface (not of the app). */
const MCP_SERVER_VERSION = '1.0.0';

/** What the endpoint needs from the rest of the server. Tests pass fakes for all of it. */
export interface McpDeps {
  registry: CentralRegistry;
  /** The loopback /api client for a central's tools; production calls as `mcp:<centralId>` (index.ts). */
  client(central: CentralRecord): InternalClient;
  sessions(): Session[];
  rooms(): Room[];
  events: EventHub;
  /** The tools to offer; defaults to every registered tool (Ruling 3: tests pass stubs). */
  tools?: () => ToolDef[];
  /** The clock; defaults to `Date.now`. */
  now?: () => number;
  /**
   * How long a burst of changes to a resource waits before it is one `notifications/resources/updated`
   * (resourceSubscriptions.ts); defaults to 500 ms. A test that cannot wait passes less.
   */
  resourceDebounceMs?: number;
  /**
   * The runtime P2's writes run on: the task ledger, the activity log, presence, the alias map (deliver.ts; the
   * server's comes from deliverWiring.ts). Without it every call still reads, and nothing writes: non-read tools,
   * `ctx.ledger` and `ctx.mayDrive` refuse UNAVAILABLE, and session ids are matched exactly (no aliases).
   */
  deliver?: DeliverRuntime;
  /** The sessions centrals opened themselves; defaults to the server's own registry (workers.ts). */
  workers?: WorkerRegistry;
  /** The confirmations `ask` tools wait on; defaults to the server's own book (confirm.ts). */
  confirms?: ConfirmBook;
}

/**
 * What every central's server announces. Its resources and prompts are filled in from the tools the central has
 * (resources.ts, prompts.ts); with none, their lists answer empty rather than "method not found".
 */
const CAPABILITIES: ServerCapabilities = {
  tools: { listChanged: true },
  resources: { subscribe: true, listChanged: true },
  prompts: { listChanged: true },
  logging: {},
};

/** The one output shape every tool declares, success and refusal alike. */
const TOOL_OUTPUT = {
  ok: z.boolean(),
  data: z.unknown().optional(),
  code: z.string().optional(),
  message: z.string().optional(),
  hint: z.string().optional(),
};

/** What a tool's risk, toolset and idempotence say about it. Each hint is explicit: MCP's defaults assume the worst. */
function annotationsFor(tool: ToolDef): ToolAnnotations {
  return {
    readOnlyHint: tool.risk === 'read',
    destructiveHint: tool.risk === 'destructive',
    idempotentHint: tool.idempotent === true,
    openWorldHint: tool.toolset === 'cloud',
  };
}

/**
 * A refusal in the one envelope. Its `data` (the facts a central acts on, such as NEEDS_CONFIRMATION's confirmId) is in
 * `structuredContent.data` and, one `key: value` line each, in the text: Claude Code shows the model the one, a client
 * that reads `content` only the other (Ruling 66).
 */
function errorResult(err: ToolError): CallToolResult {
  const hint = err.hint ? `\nHint: ${err.hint}` : '';
  const facts = err.data === undefined ? [] : Object.entries(err.data).map(([key, value]) => `\n${key}: ${String(value)}`);
  return {
    isError: true,
    content: [{ type: 'text', text: `${err.code}: ${err.message}${hint}${facts.join('')}` }],
    structuredContent: {
      ok: false,
      code: err.code,
      message: err.message,
      ...(err.hint ? { hint: err.hint } : {}),
      ...(err.data === undefined ? {} : { data: { ...err.data } }),
    },
  };
}

async function callTool(
  tool: ToolDef,
  args: Record<string, unknown>,
  centralId: string,
  deps: McpDeps,
  signal: AbortSignal,
): Promise<CallToolResult> {
  try {
    const { data, summary } = await runTool(tool, args, { centralId, deps, signal, via: 'call' });
    return { content: [{ type: 'text', text: summary }], structuredContent: { ok: true, data } };
  } catch (err) {
    // runTool throws only ToolErrors; anything else came from building the answer here.
    return errorResult(err instanceof ToolError ? err : upstreamFailure(tool.name, centralId, err));
  }
}

/** A tool this central is offered: its definition, its argument check (built once), its SDK registration. */
interface OfferedTool {
  def: ToolDef;
  args: z.ZodType;
  registered: RegisteredTool;
}

/**
 * Registers a tool for tools/list: its schemas and annotations. Calls never reach the callback given
 * here, because `answerToolCalls` replaces McpServer's tools/call handler; it calls the same `callTool`,
 * so a call that did reach it would run the same way.
 */
function registerTool(
  server: McpServer,
  tool: ToolDef,
  centralId: string,
  deps: McpDeps,
): OfferedTool {
  const registered = server.registerTool(
    tool.name,
    {
      title: tool.title,
      description: tool.description,
      inputSchema: tool.input,
      outputSchema: TOOL_OUTPUT,
      annotations: annotationsFor(tool),
    },
    (args, extra) => callTool(tool, args as Record<string, unknown>, centralId, deps, extra.signal),
  );
  return { def: tool, args: z.object(tool.input), registered };
}

/** INVALID, naming every field that failed and why, in zod's own words (they name the rule, not the value sent). */
function badArguments(tool: ToolDef, error: z.ZodError): ToolError {
  const fields = error.issues
    .map((issue) => `${issue.path.map(String).join('.') || '(arguments)'}: ${issue.message}`)
    .join('; ');
  return new ToolError(
    'INVALID',
    `Invalid arguments for ${tool.name}: ${fields}`,
    `Check ${tool.name}'s input schema in tools/list and call it again.`,
  );
}

/**
 * tools/call, answered here rather than by McpServer's own handler, so that every failure comes back in
 * the one envelope (`isError`, `structuredContent: { ok: false, code, message, hint }`): a tool this
 * central was not given (unknown, another toolset's, a later phase's, disabled) is NOT_FOUND, arguments
 * its input shape refuses are INVALID. McpServer's handler answers both in plain text only.
 *
 * TOKEN TRAP: the SDK hands every handler `extra.requestInfo.headers`, all of the HTTP request's headers,
 * `Authorization: Bearer <the central's token>` among them. Nothing from `extra` reaches a tool but
 * `extra.signal`; never pass `extra`, `requestInfo` or `authInfo` on.
 */
function answerToolCalls(
  server: McpServer,
  offered: ReadonlyMap<string, OfferedTool>,
  centralId: string,
  deps: McpDeps,
): void {
  server.server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = offered.get(request.params.name);
    if (tool === undefined || !tool.registered.enabled) {
      return errorResult(
        new ToolError(
          'NOT_FOUND',
          `This central has no tool named ${request.params.name.slice(0, 64)}.`,
          'Call tools/list to see the tools it has.',
        ),
      );
    }
    // Async, so a tool whose input uses an async refinement is checked the same way as any other.
    const parsed = await tool.args.safeParseAsync(request.params.arguments ?? {});
    if (!parsed.success) {
      const refusal = badArguments(tool.def, parsed.error);
      // A refused write is in the activity log like any other refusal (a read is not).
      logArgumentRefusal(tool.def, refusal, centralId, deps);
      return errorResult(refusal);
    }
    return callTool(
      tool.def,
      parsed.data as Record<string, unknown>,
      centralId,
      deps,
      extra.signal,
    );
  });
}

/**
 * McpServer installs its tools/list, resources/list and prompts/list handlers the first time something
 * of that kind is registered. A central can have no tool, resource or prompt (no toolset it holds backs
 * one in this build); without the handlers those lists would fail with "method not found" for
 * capabilities the server announces. Registering and removing a placeholder installs them through the
 * SDK's public API, before the server is connected, so no client ever sees it.
 */
function answerEmptyLists(server: McpServer): void {
  const placeholder = 'aasc_placeholder';
  server.registerTool(placeholder, {}, () => ({ content: [] })).remove();
  server.registerResource(placeholder, 'aasc://placeholder', {}, () => ({ contents: [] })).remove();
  server.registerPrompt(placeholder, {}, () => ({ messages: [] })).remove();
}

/**
 * The MCP server for one central. `central` is the record the gate admitted; only its id, kind and
 * toolsets are read, and the token is blanked before anything else sees it.
 */
export function buildMcpServer(central: CentralRecord, deps: McpDeps): McpServer {
  const self = withoutToken(central);
  const server = new McpServer(
    { name: MCP_SERVER_NAME, title: 'AASC', version: MCP_SERVER_VERSION },
    { capabilities: CAPABILITIES, instructions: centralInstructions(self.kind, MCP_MAX_PHASE) },
  );
  server.server.onerror = (err) => {
    log.debug('mcp', `MCP session error for central ${self.centralId}: ${err.message}`);
  };
  answerEmptyLists(server);
  const tools = toolsFor(self, MCP_MAX_PHASE, (deps.tools ?? allTools)());
  const offered = new Map<string, OfferedTool>();
  for (const tool of tools) {
    offered.set(tool.name, registerTool(server, tool, self.centralId, deps));
  }
  answerToolCalls(server, offered, self.centralId, deps);
  registerResources(server, self, tools, deps);
  registerPrompts(server, tools, sessionCompleter(self.centralId, deps));
  return server;
}
