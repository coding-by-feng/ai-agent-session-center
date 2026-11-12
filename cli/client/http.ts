/**
 * `aasc`'s REST calls once it is signed in. Every call carries the identity a dashboard's
 * fetch wrapper adds (src/lib/presenceClient.ts): `X-AASC-Client-Id` and `X-AASC-Client-Label`,
 * plus `X-AASC-Role: cli`. A paired terminal write without the client id is refused with
 * 409 CONTROL_HELD (server/apiRouter.ts, POST /terminals/:id/write).
 *
 * Like remoteClient.ts: redirects are never followed, each call has a deadline, and an
 * answer is cut off past a size cap instead of being buffered whole.
 */
import { request as httpRequest } from 'http';
import { Readable } from 'stream';
import { readCapped, type FetchLike, type FetchResponse } from '../../electron/remote/remoteClient.js';
import { cleanText } from './sanitize.js';

export const API_TIMEOUT_MS = 10_000;
/** GET /api/sessions can be a few hundred KB; = remoteClient's SESSIONS_MAX_BYTES. */
export const API_MAX_BYTES = 8 * 1024 * 1024;

export interface ApiAuth {
  origin: string;
  bearer: string;
  clientId: string;
  label: string;
}

export interface ApiAnswer {
  status: number;
  data: unknown;
}

export type Requester = (method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown) => Promise<ApiAnswer>;

export interface RequesterDeps {
  fetch: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
}

/** The identity headers every `aasc` request and WebSocket upgrade carries. */
export function identityHeaders(auth: Pick<ApiAuth, 'bearer' | 'clientId' | 'label'>): Record<string, string> {
  return {
    Authorization: `Bearer ${auth.bearer}`,
    'X-AASC-Client-Id': auth.clientId,
    'X-AASC-Client-Label': auth.label,
    'X-AASC-Role': 'cli',
  };
}

/** A requester bound to one signed-in server. Throws on network failure, timeout or an oversized answer. */
export function createRequester(deps: RequesterDeps, auth: ApiAuth): Requester {
  return async (method, path, body) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? API_TIMEOUT_MS);
    try {
      const headers: Record<string, string> = { Accept: 'application/json', ...identityHeaders(auth) };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const res = await deps.fetch(`${auth.origin}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual',
        signal: controller.signal,
      });
      const text = await readCapped(res, deps.maxBytes ?? API_MAX_BYTES);
      let data: unknown = null;
      try { data = text ? JSON.parse(text) : null; } catch { data = null; }
      return { status: res.status, data };
    } finally {
      clearTimeout(timer);
    }
  };
}

/** The server's own sentence for a refusal, when it sent one; control characters out. */
export function serverError(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const error = (data as Record<string, unknown>).error;
  return typeof error === 'string' ? cleanText(error).slice(0, 300) : null;
}

export function serverCode(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const code = (data as Record<string, unknown>).code;
  return typeof code === 'string' ? code : null;
}

/**
 * A FetchLike over a Unix socket: the SSH tunnel's local end (`ssh -L <socket>:…`), which
 * only this user can open. Node's fetch can't dial a socket, so this is http.request with
 * `socketPath`. Like fetch with `redirect: 'manual'`, it never follows a redirect; the body
 * is handed over as a stream so readCapped can stop at its cap.
 */
export function unixSocketFetch(socketPath: string): FetchLike {
  return (url, init) => new Promise<FetchResponse>((resolve, reject) => {
    const u = new URL(url);
    const req = httpRequest({
      socketPath,
      method: init.method,
      path: `${u.pathname}${u.search}`,
      // The server sees sshd's loopback connection; Host must name this machine too.
      headers: { ...init.headers, Host: 'localhost' },
      signal: init.signal,
    }, (res) => {
      resolve({
        status: res.statusCode ?? 0,
        text: async () => {
          const chunks: Buffer[] = [];
          for await (const c of res) chunks.push(c as Buffer);
          return Buffer.concat(chunks).toString('utf8');
        },
        body: Readable.toWeb(res) as unknown as ReadableStream<Uint8Array>,
      });
    });
    req.on('error', reject);
    req.end(init.body);
  });
}
