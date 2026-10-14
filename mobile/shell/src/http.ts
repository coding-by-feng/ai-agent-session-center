// http.ts — the shell's HTTP shape for calls that need a method or a header (AASC-19).
//
// On the phone this is CapacitorHttp.request({ method, url, headers, data }):
// native HTTP, so no CORS and none of the WebView's cookies. In tests it is a
// fake. Callers never log a header or a body: both can carry a token.
import type { HttpResponse } from './pairingClient.js';

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface HttpRequest {
  method: HttpMethod;
  url: string;
  headers?: Record<string, string>;
  /** JSON body; omitted means no body at all (the backend's DELETE refuses one). */
  body?: unknown;
}

export interface HttpRequester {
  request(req: HttpRequest): Promise<HttpResponse>;
}

/** A nested value of an untrusted JSON answer, or undefined. */
export function field(data: unknown, path: readonly string[]): unknown {
  let cur: unknown = data;
  for (const key of path) {
    if (!cur || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[key];
  }
  return cur;
}

/** The machine-readable error code: the backend's `{ error: { code } }` or the Mac's `{ code }`. */
export function errorCode(data: unknown): string | null {
  const nested = field(data, ['error', 'code']);
  if (typeof nested === 'string') return nested;
  const flat = field(data, ['code']);
  return typeof flat === 'string' ? flat : null;
}

export function bearer(token: string): Record<string, string> {
  return { Authorization: `Bearer ${token}` };
}

/**
 * Bearer + JSON. Set explicitly: CapacitorHttp on Android writes no body without
 * a Content-Type, and both the backend (415) and the Mac (no parsed body) refuse one.
 */
export function jsonHeaders(token: string): Record<string, string> {
  return { ...bearer(token), 'Content-Type': 'application/json' };
}
