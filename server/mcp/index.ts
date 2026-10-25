// index.ts — the /mcp endpoint: MCP's Streamable HTTP transport, stateful, one MCP session per CLI
// connection, every one bound to the central that opened it.
//
//   POST    an `initialize` with no Mcp-Session-Id opens a session: a new transport and a new McpServer
//           built for the calling central (server.ts). Every other POST names its session.
//   GET     the session's event stream (server-to-client messages).
//   DELETE  ends the session.
//
// Every request passes the gate first (gate.ts): the Mac itself, naming itself, with the bearer token of
// a live central. A 401 carries `WWW-Authenticate: Bearer`. The gate's answer says which central is
// calling, and a session answers only that central: another central's token on it is 403. An unknown
// session id is 404, which tells an MCP client to initialize again, and so is a session met with any
// token but the one that opened it. Past MAX_IN_FLIGHT_PER_SESSION requests open on one session, 429.
//
// Sessions end when the client DELETEs them, when their central is revoked or gets a new token (a
// relaunch re-mints it; the registry's `onChange` says so), when one has sat idle for MCP_IDLE_MS with no
// request open (a client holding its event stream open is not idle), and, past
// MAX_SESSIONS_PER_CENTRAL, least recently used first. A session lives no longer than the token that
// opened it.
//
// The token goes no further than the gate: the record it admits is copied with the token blanked
// (`withoutToken`) before the router keeps it, builds a server from it or logs anything about it. A
// session keeps only a one-way print of its token, to notice the token was replaced. Answers here are
// fixed text; nothing the caller sent is echoed.

import { createHash, randomUUID } from 'node:crypto';
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import log from '../logger.js';
import type { CentralRegistry } from './centrals.js';
import { withoutToken } from './callContext.js';
import { createInternalClient, type InternalClient } from './client.js';
import { checkMcpRequest, type GateResult } from './gate.js';
import { internalAuthToken } from './internalAuth.js';
import { getMcpPort } from './runtime.js';
import { buildMcpServer, type McpDeps } from './server.js';
import type { CentralRecord } from './types.js';

export type { McpDeps } from './server.js';

/** A session with no request open for this long is closed. */
export const MCP_IDLE_MS = 30 * 60_000;
/** How often idle sessions are looked for. */
const SWEEP_EVERY_MS = 60_000;
/** One CLI holds one session; this bounds a client that keeps opening new ones. */
export const MAX_SESSIONS_PER_CENTRAL = 8;
/** Requests open on one session at once (a held event stream is one); past it, 429. */
export const MAX_IN_FLIGHT_PER_SESSION = 16;
/** For a router mounted without the app's own parser; the server's global one runs first in production. */
const MAX_BODY = '4mb';

export interface McpRouterOptions {
  idleMs?: number;
  sweepEveryMs?: number;
  maxSessionsPerCentral?: number;
  maxInFlightPerSession?: number;
}

/** The /mcp router, plus what its owner (and a test) needs: closing it, and counting its sessions. */
export type McpRouter = Router & {
  /** Stops the idle sweep and the registry watch, and closes every session. */
  close(): Promise<void>;
  /** Open MCP sessions, of one central or of all. */
  openSessionCount(centralId?: string): number;
};

const describe = (err: unknown): string => (err instanceof Error ? err.message : String(err));

// ---------------------------------------------------------------------------
// Answers
// ---------------------------------------------------------------------------

type Refusal = Extract<GateResult, { ok: false }>;

/** A JSON-RPC error answer: the shape MCP clients read, in the SDK's own form (`id: null`). */
function sendRpcError(
  res: Response,
  status: number,
  code: number,
  message: string,
  data?: Record<string, unknown>,
): void {
  res
    .status(status)
    .json({ jsonrpc: '2.0', error: { code, message, ...(data ? { data } : {}) }, id: null });
}

function refuse(res: Response, refusal: Refusal): void {
  if (refusal.status === 401) {
    res.setHeader(
      'WWW-Authenticate',
      refusal.code === 'BAD_TOKEN'
        ? 'Bearer realm="aasc", error="invalid_token"'
        : 'Bearer realm="aasc"',
    );
  }
  sendRpcError(res, refusal.status, -32000, refusal.message, { code: refusal.code });
}

/** A registry that holds no central: asked by the error handler, the gate can only say who is the Mac. */
const NO_CENTRALS = { byToken: () => null };

/**
 * Errors under /mcp, the app's body parser included: mount it right behind the router
 * (`app.use('/mcp', router, mcpErrorHandler)`). A caller that is not the Mac gets the gate's 403, as
 * for anything else under /mcp; the Mac gets a JSON-RPC error in fixed text, never Express's page with
 * its stack trace or a quote of the body it could not read.
 */
export function mcpErrorHandler(
  err: unknown,
  req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (res.headersSent) {
    next(err);
    return;
  }
  const verdict = checkMcpRequest(req, NO_CENTRALS);
  if (!verdict.ok && verdict.status === 403) {
    refuse(res, verdict);
    return;
  }
  const { type, status } = (err ?? {}) as { type?: unknown; status?: unknown };
  if (type === 'entity.parse.failed') {
    sendRpcError(res, 400, -32700, 'Parse error: Invalid JSON');
  } else if (type === 'entity.too.large') {
    sendRpcError(res, 413, -32000, 'Request body too large');
  } else if (typeof status === 'number' && status >= 400 && status < 500) {
    sendRpcError(res, status, -32600, 'Invalid request');
  } else {
    log.warn('mcp', `A /mcp request failed: ${describe(err)}`);
    sendRpcError(res, 500, -32603, 'Internal error');
  }
}

// ---------------------------------------------------------------------------
// The /api client of a central's tools
// ---------------------------------------------------------------------------

/**
 * The /api client a central's tools use: AASC's own port, the presence id `mcp:<centralId>`, and the
 * internal /api token when a dashboard password is set. A call made before the server has said which
 * port it listens on fails (as `{ ok: false, status: 0 }`); it never throws.
 */
export function centralClient(central: Pick<CentralRecord, 'centralId'>): InternalClient {
  return createInternalClient({
    port: () => {
      const port = getMcpPort();
      if (port === null) throw new Error('AASC has not said which port it listens on yet');
      return port;
    },
    clientId: `mcp:${central.centralId}`,
    authToken: internalAuthToken,
  });
}

// ---------------------------------------------------------------------------
// The open sessions
// ---------------------------------------------------------------------------

/** A one-way print of a token: enough to tell it was replaced, nothing that could be used as one. */
function tokenPrint(token: string): string {
  return createHash('sha256').update(token).digest('base64url');
}

interface SessionEntry {
  centralId: string;
  /** `tokenPrint` of the token that opened it. */
  tokenPrint: string;
  transport: StreamableHTTPServerTransport;
  server: McpServer;
  /** When a request on it last started or ended. */
  lastSeenAt: number;
  /** Requests on it still open; a held event stream is one. */
  inFlight: number;
}

interface SessionBook {
  get(sessionId: string): SessionEntry | undefined;
  /** Files a session that just opened; past the cap, its central's least recently used ones close. */
  add(
    sessionId: string,
    opened: Pick<SessionEntry, 'centralId' | 'tokenPrint' | 'transport' | 'server'>,
  ): void;
  /** A request on the session started (+1) or ended (-1). */
  touch(sessionId: string, delta: 1 | -1): void;
  /** Drops a session its transport closed (a DELETE, or a close from here). */
  forget(sessionId: string, transport: StreamableHTTPServerTransport): void;
  /** Closes the sessions whose central was revoked or has a new token. */
  endStale(): void;
  /** `endStale`, then closes the sessions idle for longer than the limit. */
  sweep(): void;
  count(centralId?: string): number;
  closeAll(): Promise<void>;
}

/** The open MCP sessions by id. An entry is replaced, never edited. */
function createSessionBook(
  registry: Pick<CentralRegistry, 'byId'>,
  now: () => number,
  idleMs: number,
  maxPerCentral: number,
): SessionBook {
  const sessions = new Map<string, SessionEntry>();

  function end(sessionId: string, why: string): void {
    const entry = sessions.get(sessionId);
    if (entry === undefined) return;
    sessions.delete(sessionId);
    log.info('mcp', `Closed an MCP session of central ${entry.centralId}: ${why}`);
    // Closing the server closes its transport, which ends any stream still open.
    entry.server.close().catch((err: unknown) => {
      log.warn('mcp', `Closing an MCP session failed: ${describe(err)}`);
    });
  }

  function enforceCap(centralId: string, newest: string): void {
    const mine = [...sessions].filter(([, entry]) => entry.centralId === centralId);
    if (mine.length <= maxPerCentral) return;
    const oldestFirst = [...mine].sort(([, a], [, b]) => a.lastSeenAt - b.lastSeenAt);
    for (const [id] of oldestFirst.slice(0, mine.length - maxPerCentral)) {
      if (id !== newest) end(id, 'too many open sessions');
    }
  }

  function endStale(): void {
    for (const [id, entry] of [...sessions]) {
      const live = registry.byId(entry.centralId);
      if (live === null) end(id, 'its central was revoked');
      else if (tokenPrint(live.token) !== entry.tokenPrint) end(id, 'its central has a new token');
    }
  }

  return {
    get: (sessionId) => sessions.get(sessionId),
    add(sessionId, opened) {
      sessions.set(sessionId, { ...opened, lastSeenAt: now(), inFlight: 0 });
      log.info('mcp', `Central ${opened.centralId} opened an MCP session`);
      enforceCap(opened.centralId, sessionId);
    },
    touch(sessionId, delta) {
      const entry = sessions.get(sessionId);
      if (entry === undefined) return;
      sessions.set(sessionId, {
        ...entry,
        inFlight: Math.max(0, entry.inFlight + delta),
        lastSeenAt: now(),
      });
    },
    forget(sessionId, transport) {
      if (sessions.get(sessionId)?.transport === transport) sessions.delete(sessionId);
    },
    endStale,
    sweep() {
      endStale();
      const t = now();
      for (const [id, entry] of [...sessions]) {
        if (entry.inFlight === 0 && t - entry.lastSeenAt > idleMs) end(id, 'idle');
      }
    },
    count(centralId) {
      if (centralId === undefined) return sessions.size;
      return [...sessions.values()].filter((entry) => entry.centralId === centralId).length;
    },
    async closeAll() {
      const open = [...sessions.values()];
      sessions.clear();
      await Promise.allSettled(open.map((entry) => entry.server.close()));
    },
  };
}

// ---------------------------------------------------------------------------
// Requests
// ---------------------------------------------------------------------------

/** Where the gate leaves what the handlers may know of the caller: never the token itself. */
interface Caller {
  /** The admitted central, token blanked. */
  central: CentralRecord;
  tokenPrint: string;
}
const CALLER = 'mcpCaller';

/** The gate, run before anything else under /mcp (body parsing included). */
function gate(registry: Pick<CentralRegistry, 'byToken'>) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const verdict = checkMcpRequest(req, registry);
    if (!verdict.ok) {
      log.debug('mcp', `Refused ${req.method} /mcp: ${verdict.code}`);
      refuse(res, verdict);
      return;
    }
    const caller: Caller = {
      central: withoutToken(verdict.central),
      tokenPrint: tokenPrint(verdict.central.token),
    };
    res.locals[CALLER] = caller;
    next();
  };
}

/** The session a request names, or null for none (absent or blank). */
function sessionIdOf(req: Request): string | null {
  const value = req.headers['mcp-session-id'];
  return typeof value === 'string' && value !== '' ? value : null;
}

/** Does this body open a session? (The transport refuses a batch that holds more than the initialize.) */
function isInitializeBody(body: unknown): boolean {
  return Array.isArray(body) ? body.some((m) => isInitializeRequest(m)) : isInitializeRequest(body);
}

export function createMcpRouter(deps: McpDeps, options: McpRouterOptions = {}): McpRouter {
  const book = createSessionBook(
    deps.registry,
    deps.now ?? Date.now,
    options.idleMs ?? MCP_IDLE_MS,
    options.maxSessionsPerCentral ?? MAX_SESSIONS_PER_CENTRAL,
  );
  const maxInFlight = options.maxInFlightPerSession ?? MAX_IN_FLIGHT_PER_SESSION;

  async function openSession(req: Request, res: Response, caller: Caller): Promise<void> {
    const server = buildMcpServer(caller.central, deps);
    const transport: StreamableHTTPServerTransport = new StreamableHTTPServerTransport({
      sessionIdGenerator: randomUUID,
      onsessioninitialized: (sessionId) => {
        book.add(sessionId, {
          centralId: caller.central.centralId,
          tokenPrint: caller.tokenPrint,
          transport,
          server,
        });
      },
      onsessionclosed: (sessionId) => book.forget(sessionId, transport),
    });
    // The server chains its own close handling after this one.
    transport.onclose = () => {
      if (transport.sessionId !== undefined) book.forget(transport.sessionId, transport);
    };
    await server.connect(transport);
    try {
      await transport.handleRequest(req, res, req.body);
    } finally {
      // An initialize the transport turned down (a batch, a bad body) opened no session, so nothing
      // else would ever close this server.
      const id = transport.sessionId;
      if (id === undefined || book.get(id)?.transport !== transport) {
        await server.close().catch(() => undefined);
      }
    }
  }

  async function useSession(
    sessionId: string,
    req: Request,
    res: Response,
    caller: Caller,
  ): Promise<void> {
    const entry = book.get(sessionId);
    if (entry === undefined) {
      sendRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    if (entry.centralId !== caller.central.centralId) {
      sendRpcError(res, 403, -32000, 'This MCP session belongs to another central.');
      return;
    }
    // The registry's onChange closes a session whose central got a new token; this backs it up, so a
    // session never answers a token other than the one that opened it.
    if (entry.tokenPrint !== caller.tokenPrint) {
      sendRpcError(res, 404, -32001, 'Session not found');
      return;
    }
    if (entry.inFlight >= maxInFlight) {
      sendRpcError(
        res,
        429,
        -32000,
        'Too many requests are open on this MCP session; try again shortly.',
      );
      return;
    }
    book.touch(sessionId, 1);
    try {
      await entry.transport.handleRequest(req, res, req.body);
    } finally {
      book.touch(sessionId, -1);
    }
  }

  async function handle(req: Request, res: Response): Promise<void> {
    const caller = res.locals[CALLER] as Caller;
    const sessionId = sessionIdOf(req);
    try {
      if (sessionId !== null) await useSession(sessionId, req, res, caller);
      else if (req.method === 'POST' && isInitializeBody(req.body))
        await openSession(req, res, caller);
      else sendRpcError(res, 400, -32000, 'Bad Request: Mcp-Session-Id header is required');
    } catch (err) {
      log.warn('mcp', `A /mcp request failed: ${describe(err)}`);
      if (!res.headersSent) sendRpcError(res, 500, -32603, 'Internal error');
      else res.end();
    }
  }

  const router = Router();
  router.use(gate(deps.registry));
  // A no-op when the app's own parser has read the body already.
  router.use(express.json({ limit: MAX_BODY }));
  router.post('/', handle);
  router.get('/', handle);
  router.delete('/', handle);
  router.all('/', (_req: Request, res: Response) => {
    res.setHeader('Allow', 'GET, POST, DELETE');
    sendRpcError(res, 405, -32000, 'Method not allowed.');
  });
  router.use((_req: Request, res: Response) => {
    sendRpcError(res, 404, -32000, 'Not found: the MCP endpoint is /mcp');
  });

  const stopWatching = deps.registry.onChange(() => book.endStale());
  const timer = setInterval(() => book.sweep(), options.sweepEveryMs ?? SWEEP_EVERY_MS);
  timer.unref?.();

  return Object.assign(router, {
    async close(): Promise<void> {
      clearInterval(timer);
      stopWatching();
      await book.closeAll();
    },
    openSessionCount: (centralId?: string) => book.count(centralId),
  });
}
