// resources.ts — gives one central's MCP server its resources: the 18 of the catalog (resourceDefs.ts), those its
// tools allow. Each is registered as a resource template, so `resources/templates/list` shows every one, with a
// listing for the five that have no variable (`resources/list`). A read is the backing tool's answer: its fenced
// text, and its data as JSON beside it. `resources/subscribe` and `unsubscribe` are answered here too
// (resourceSubscriptions.ts).
//
// A read runs the tool through runTool.ts, the way a tool call does (as the central, in the context callContext.ts
// builds), after the same argument check, so what the central may see and how text another session wrote is fenced
// are the tool's own doing. A refusal is a JSON-RPC error: -32602 for what the caller got wrong or may not have
// (INVALID, NOT_FOUND, NOT_IN_SCOPE), -32603 for the rest (UNAVAILABLE, UPSTREAM); its `data` is the tool's refusal
// envelope `{ ok: false, code, message, hint }`, and its text carries the code and the hint, as a tool's error text
// does. A resource the central is not offered is not registered at all, so the SDK answers it "not found".
//
// TOKEN TRAP: the SDK hands every handler `extra.requestInfo.headers`, `Authorization: Bearer <the central's token>`
// among them. Nothing from `extra` is used here but `extra.signal`; never pass `extra`, `requestInfo` or `authInfo` on.

import { ResourceTemplate, type McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
  ErrorCode,
  McpError,
  SubscribeRequestSchema,
  UnsubscribeRequestSchema,
  type ReadResourceResult,
} from '@modelcontextprotocol/sdk/types.js';
import log from '../logger.js';
import { sessionCompleter } from './completion.js';
import type { ToolDef } from './registry.js';
import { offerResources, type OfferedResource } from './resourceDefs.js';
import { createResourceSubscriptions } from './resourceSubscriptions.js';
import { checkedArgs, parseResourceUri } from './resourceUri.js';
import { runTool, upstreamFailure } from './runTool.js';
import type { McpDeps } from './server.js';
import { ToolError, type CentralRecord, type ToolErrorCode } from './types.js';

const TASKS_HINT = 'Until then, read what a session answered at aasc://sessions/{id}/answer.';
const FILE_HINT =
  'Only a skill has files; read aasc://resources/{id} for any other resource, or call resource_list for ids.';

/** The refusals that are about what the caller asked for; the rest are about AASC being unable to answer. */
const CALLERS_FAULT: ReadonlySet<ToolErrorCode> = new Set(['INVALID', 'NOT_FOUND', 'NOT_IN_SCOPE']);

/** A ToolError as the JSON-RPC error a resource read or a subscription answers with. */
function refusal(err: ToolError, hint: string | undefined): McpError {
  const body = { ok: false, code: err.code, message: err.message, ...(hint ? { hint } : {}) };
  return new McpError(
    CALLERS_FAULT.has(err.code) ? ErrorCode.InvalidParams : ErrorCode.InternalError,
    `${err.code}: ${err.message}${hint ? `\nHint: ${hint}` : ''}`,
    body,
  );
}

/**
 * Whatever went wrong, as an McpError. Anything that is not a ToolError is logged in full and answered in the fixed
 * words of every unexpected failure (`upstreamFailure`, the same a tool call gets).
 */
function asMcpError(
  err: unknown,
  what: string,
  centralId: string,
  def?: OfferedResource['def'],
): McpError {
  if (err instanceof McpError) return err;
  if (err instanceof ToolError) {
    const hint = err.code === 'NOT_FOUND' && def?.name === 'resource_file' ? FILE_HINT : err.hint;
    return refusal(err, hint);
  }
  const failure = upstreamFailure(what, centralId, err);
  return refusal(failure, failure.hint);
}

// ---------------------------------------------------------------------------
// A read
// ---------------------------------------------------------------------------

/** What a tool answered, as the two parts of a resource: its text for the model, its data as JSON. */
function contentsOf(uri: string, data: unknown, summary: string): ReadResourceResult {
  return {
    contents: [
      { uri, mimeType: 'text/plain', text: summary },
      { uri, mimeType: 'application/json', text: JSON.stringify(data) ?? 'null' },
    ],
  };
}

async function readResource(
  offered: OfferedResource,
  uri: URL,
  centralId: string,
  deps: McpDeps,
  signal: AbortSignal,
): Promise<ReadResourceResult> {
  const { def, tool } = offered;
  try {
    const { vars } = parseResourceUri([offered], uri.href);
    if (tool === null) {
      throw new ToolError(
        'UNAVAILABLE',
        def.unavailable ?? 'This resource is not available yet.',
        TASKS_HINT,
      );
    }
    const args = await checkedArgs(offered, vars);
    const { data, summary } = await runTool(tool, args, { centralId, deps, signal, via: 'read' });
    return contentsOf(uri.href, data, summary);
  } catch (err) {
    throw asMcpError(err, `Reading ${def.name}`, centralId, def);
  }
}

// ---------------------------------------------------------------------------
// Registering them
// ---------------------------------------------------------------------------

/**
 * Registers the resources `central` is offered on its MCP server, and answers its subscriptions. `tools` are the
 * tools it was given at this build's phase; `deps.resourceDebounceMs` is how long a burst of changes waits.
 * Must run before the server is connected: it registers capabilities (completion) and request handlers.
 */
export function registerResources(
  server: McpServer,
  central: CentralRecord,
  tools: readonly ToolDef[],
  deps: McpDeps,
): void {
  const { centralId } = central;
  const offered = offerResources(central, tools);
  const completeSession = sessionCompleter(centralId, deps);

  for (const resource of offered) {
    const { def } = resource;
    // A URI with no variable is one resource: list it. The others are listed by completion, not enumerated.
    const listed = def.uri.includes('{')
      ? undefined
      : () => ({ resources: [{ uri: def.uri, name: def.name }] });
    const template = new ResourceTemplate(def.uri, {
      list: listed,
      ...(def.follows === 'session' ? { complete: { id: completeSession } } : {}),
    });
    server.registerResource(
      def.name,
      template,
      { title: def.title, description: def.description, mimeType: 'text/plain' },
      (uri, _variables, extra) => readResource(resource, uri, centralId, deps, extra.signal),
    );
  }

  const subscriptions = createResourceSubscriptions({
    centralId,
    deps,
    offered,
    notify: (uri) => {
      server.server.sendResourceUpdated({ uri }).catch((err: unknown) => {
        log.debug(
          'mcp',
          `Central ${centralId}: a resource update was not delivered: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    },
    ...(deps.resourceDebounceMs === undefined ? {} : { debounceMs: deps.resourceDebounceMs }),
  });
  server.server.setRequestHandler(SubscribeRequestSchema, async (request) => {
    try {
      await subscriptions.subscribe(request.params.uri);
    } catch (err) {
      throw asMcpError(err, 'Following a resource', centralId);
    }
    return {};
  });
  server.server.setRequestHandler(UnsubscribeRequestSchema, async (request) => {
    subscriptions.unsubscribe(request.params.uri);
    return {};
  });
  // The MCP session ended (a DELETE, a revoked central, the idle sweep): stop listening and drop what is waiting.
  const previous = server.server.onclose;
  server.server.onclose = () => {
    previous?.();
    subscriptions.close();
  };
}
