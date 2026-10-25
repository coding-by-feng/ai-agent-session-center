// client.ts — the loopback client MCP tools use to reach AASC's own /api routes.
//
// A tool does not re-implement a route: it calls it over http://127.0.0.1:<port>/api, stamped with
// the central's presence id (`x-aasc-client-id: mcp:<centralId>`) and, when a dashboard password
// is set, a token from internalAuth.ts. Validation, visibility rules, broadcasts and side effects
// stay exactly what the dashboard gets.
//
// The client never throws: a refused or failed call comes back as `{ ok: false, ... }`, so a tool
// handles one shape. It never unwraps either. Routes answer `{ success, data }`, `{ ok, ... }` or a
// bare value, and the tool layer decides what each one means.

const LOOPBACK_HOST = '127.0.0.1';
const API_PREFIX = '/api';
const CLIENT_ID_HEADER = 'x-aasc-client-id';

/** What a call came back with. */
export interface InternalResponse<T = unknown> {
  /** True for a 2xx answer. */
  ok: boolean;
  /** The HTTP status; 0 when no answer arrived (the call was refused here or the network failed). */
  status: number;
  /**
   * The JSON body, parsed and whole (nothing unwrapped); null when it was empty or not JSON.
   * When `ok` is false this is the route's error body, not a `T`.
   */
  data: T | null;
  /**
   * Null on success. On failure the route's `error`, else its `message`, else `HTTP <status>`;
   * at status 0 the message of what went wrong.
   */
  error: string | null;
}

export type InternalQuery = Record<string, string | number | boolean | undefined>;

/** What one call may add to the request. */
export interface InternalCallOptions {
  /**
   * Extra headers, for a route that asks for more than who is calling: the cloud routes read the account and
   * connection a caller reviewed from `x-aasc-cloud-*` (or `x-aasc-notes-*`) headers. Exactly six names are sent
   * (`x-aasc-cloud-` and `x-aasc-notes-`, each with `backend`, `account` and `generation`); any other header, any
   * other `x-aasc-` one included, is dropped, because the server reads some of them as who is calling (the
   * presence label is a device's name). None can replace the client id, the token or the content type: those are
   * the client's own. A value with a line break is dropped.
   */
  headers?: Readonly<Record<string, string>>;
  /**
   * Ends the call when it aborts (a tool passes `ctx.signal`, so a call the central cancelled stops waiting on the
   * route). An aborted call comes back as a failure at status 0, like any other.
   */
  signal?: AbortSignal;
}

export interface InternalClient {
  /** Parameters whose value is `undefined` are left out. */
  get<T>(path: string, query?: InternalQuery, options?: InternalCallOptions): Promise<InternalResponse<T>>;
  /** A write sends `body` as JSON; without one (or with null) it sends no body at all. */
  post<T>(path: string, body?: unknown, options?: InternalCallOptions): Promise<InternalResponse<T>>;
  put<T>(path: string, body?: unknown, options?: InternalCallOptions): Promise<InternalResponse<T>>;
  patch<T>(path: string, body?: unknown, options?: InternalCallOptions): Promise<InternalResponse<T>>;
  del<T>(path: string, body?: unknown, options?: InternalCallOptions): Promise<InternalResponse<T>>;
}

export interface InternalClientOptions {
  /** The port AASC listens on, read on every call (it is chosen at startup). */
  port: () => number;
  /** Sent as it is in `x-aasc-client-id`; a central's calls pass `mcp:<centralId>`. */
  clientId: string;
  /** The `/api` token to send, read on every call; null sends none (no dashboard password). */
  authToken: () => string | null;
  /** Defaults to the global `fetch`; tests inject a spy. */
  fetchImpl?: typeof fetch;
}

function failure<T>(error: string): InternalResponse<T> {
  return { ok: false, status: 0, data: null, error };
}

/** A failure's message, with the cause Node hides behind its bare "fetch failed". */
function describeFailure(err: unknown): string {
  if (!(err instanceof Error)) return String(err);
  const detail = err.cause instanceof Error ? err.cause.message : '';
  return detail ? `${err.message}: ${detail}` : err.message;
}

/**
 * `http://127.0.0.1:<port>/api<path>?<query>`, or a throw when `path` would leave /api. The URL
 * parser resolves `..` segments (written as `%2e%2e` too), so an id such as `..` could otherwise
 * climb out of /api onto another route.
 */
function buildUrl(port: number, path: string, query?: InternalQuery): string {
  const rooted = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`http://${LOOPBACK_HOST}:${port}${API_PREFIX}${rooted}`);
  if (url.pathname !== API_PREFIX && !url.pathname.startsWith(`${API_PREFIX}/`)) {
    throw new Error(`Path leaves ${API_PREFIX}: ${path}`);
  }
  for (const [key, value] of Object.entries(query ?? {})) {
    if (value !== undefined) url.searchParams.set(key, String(value));
  }
  return url.toString();
}

/** The six binding headers a call may add: the reviewed cloud connection, and the one the notes and aliases read. */
const BINDING_HEADER = /^x-aasc-(?:cloud|notes)-(?:backend|account|generation)$/;

/**
 * The extra headers a call may send: exactly the six binding headers, names lower-cased. They go into the request first,
 * so the client's own `x-aasc-client-id`, token and content type, written after them, always win (test/mcp/client.test.ts
 * holds it to that, and to refusing every other `x-aasc-` name).
 */
function extraHeaders(options: InternalCallOptions | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(options?.headers ?? {})) {
    const key = name.toLowerCase();
    if (!BINDING_HEADER.test(key)) continue;
    if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value)) continue;
    out[key] = value;
  }
  return out;
}

function buildInit(
  method: string,
  clientId: string,
  token: string | null,
  body: unknown,
  options?: InternalCallOptions,
): RequestInit {
  const json = body === undefined || body === null ? undefined : JSON.stringify(body);
  return {
    method,
    // A route that redirects is a failed call; following it could send the request elsewhere.
    redirect: 'manual',
    headers: {
      // First, so nothing below can be replaced by it.
      ...extraHeaders(options),
      accept: 'application/json',
      [CLIENT_ID_HEADER]: clientId,
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(json !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(json !== undefined ? { body: json } : {}),
    ...(options?.signal ? { signal: options.signal } : {}),
  };
}

/** The JSON in `text`, or null when it is empty or not JSON (an HTML error page, plain text). */
function parseJson(text: string): unknown {
  if (text === '') return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/** The route's own complaint: its `error`, else its `message` (non-empty text only), else the status. */
function errorText(body: unknown, status: number): string {
  if (typeof body === 'object' && body !== null && !Array.isArray(body)) {
    const { error, message } = body as { error?: unknown; message?: unknown };
    for (const candidate of [error, message]) {
      if (typeof candidate === 'string' && candidate !== '') return candidate;
    }
  }
  return `HTTP ${status}`;
}

async function readResponse<T>(response: Response): Promise<InternalResponse<T>> {
  const data = parseJson(await response.text()) as T | null;
  if (response.ok) return { ok: true, status: response.status, data, error: null };
  return { ok: false, status: response.status, data, error: errorText(data, response.status) };
}

export function createInternalClient(opts: InternalClientOptions): InternalClient {
  async function request<T>(
    method: string,
    path: string,
    query?: InternalQuery,
    body?: unknown,
    options?: InternalCallOptions,
  ): Promise<InternalResponse<T>> {
    try {
      const url = buildUrl(opts.port(), path, query);
      const init = buildInit(method, opts.clientId, opts.authToken(), body, options);
      const response = await (opts.fetchImpl ?? fetch)(url, init);
      return await readResponse<T>(response);
    } catch (err) {
      return failure<T>(describeFailure(err));
    }
  }

  return {
    get: <T>(path: string, query?: InternalQuery, options?: InternalCallOptions) =>
      request<T>('GET', path, query, undefined, options),
    post: <T>(path: string, body?: unknown, options?: InternalCallOptions) =>
      request<T>('POST', path, undefined, body, options),
    put: <T>(path: string, body?: unknown, options?: InternalCallOptions) =>
      request<T>('PUT', path, undefined, body, options),
    patch: <T>(path: string, body?: unknown, options?: InternalCallOptions) =>
      request<T>('PATCH', path, undefined, body, options),
    del: <T>(path: string, body?: unknown, options?: InternalCallOptions) =>
      request<T>('DELETE', path, undefined, body, options),
  };
}
