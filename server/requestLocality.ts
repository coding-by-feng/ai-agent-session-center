// requestLocality.ts — the ONLY answer to "is this request the Mac itself?"
//
// "Local" unlocks a lot: no password, every session (hidden ones too), RESOURCES,
// hook ingestion and every localhost-only setting. It used to be decided from
// the TCP peer address alone, at seven separate places. A tunnel or reverse
// proxy running on this machine (Cloudflare Tunnel, ngrok, `tailscale serve`,
// Caddy …) connects from 127.0.0.1, so every visitor of the tunnel's public URL
// was treated as the Mac itself.
//
// A request is local only when ALL of these hold:
//   1. it did not arrive on the remote-only listener (see remoteListener.ts),
//   2. it carries no proxy forwarding header,
//   3. its peer address is loopback,
//   4. it names this machine in Host (localhost / 127.0.0.1 / [::1]),
//   5. any Origin it carries is one of those too, and
//   6. the browser doesn't mark it cross-site.
// 4–6 (AASC-26) stop a web page from passing as the Mac: a DNS-rebinding page
// (its own domain re-resolved to 127.0.0.1) has a loopback socket but names its
// own host, and a cross-site form post carries the foreign Origin. A forward
// that adds no headers AND rewrites Host to loopback is indistinguishable from
// the Mac: point such forwards at the remote-only listener.
// Anything else — including an unknown or empty address or Host — is remote.
// Failing closed is the right direction for a security gate.

import type { IncomingHttpHeaders, Server } from 'http';
import type { Socket } from 'net';
import { isLoopbackAddress } from './presenceManager.js';

/** Sockets accepted by a remote-only listener. Weak, so closed sockets drop out. */
const remoteOnlySockets = new WeakSet<Socket>();

/**
 * Mark every connection a server accepts as remote, whatever address or headers
 * it carries. Tunnels and relays must point at such a listener, never at the
 * main port.
 */
export function markRemoteOnlyServer(server: Server): void {
  server.on('connection', (socket: Socket) => {
    remoteOnlySockets.add(socket);
  });
}

/**
 * Headers a proxy adds on behalf of the real client. Their presence on a
 * loopback connection means the request was relayed from somewhere else.
 * A local client (the desktop app, a browser on this machine, the hook script)
 * never sends them.
 */
export const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-forwarded-port',
  'x-real-ip',
  'x-client-ip',
  'true-client-ip',
  'cf-connecting-ip',
  'cf-ray',
  'cf-visitor',
  'tailscale-user-login',
  'tailscale-user-name',
  'via',
] as const;

export function hasForwardingHeaders(headers: IncomingHttpHeaders | undefined): boolean {
  if (!headers) return false;
  return FORWARDING_HEADERS.some((name) => headers[name] !== undefined);
}

/** Names a browser uses for this machine. A rebinding page's Host is ITS own name, re-resolved to 127.0.0.1. */
export const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Hostname of a Host header (`name`, `name:port`, `[v6]:port`), lowercased; null when malformed. */
export function hostHeaderName(host: string | undefined): string | null {
  const m = /^(\[[0-9a-f:.]+\]|[^:[\]\s]+)(?::\d{1,5})?$/i.exec(host ?? '');
  return m ? m[1].toLowerCase() : null;
}

export function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(origin).hostname.toLowerCase());
  } catch {
    return false; // `null` (sandboxed frame, file://) or garbage
  }
}

/** Host, Origin and Sec-Fetch-Site all say "a page or tool on this machine, talking to itself". */
export function namesThisMachine(headers: IncomingHttpHeaders | undefined): boolean {
  if (!headers) return false;
  const host = hostHeaderName(typeof headers.host === 'string' ? headers.host : undefined);
  if (!host || !LOOPBACK_HOSTNAMES.has(host)) return false;
  const origin = headers.origin;
  if (origin !== undefined && !isLoopbackOrigin(String(origin))) return false;
  return String(headers['sec-fetch-site'] ?? '').toLowerCase() !== 'cross-site';
}

/** The fields this module reads, so Express requests, upgrade requests and test doubles all fit. */
export interface LocalityRequest {
  ip?: string;
  socket?: Socket | { remoteAddress?: string };
  headers?: IncomingHttpHeaders;
}

/** True only for a request made directly from this machine to the main listener. */
export function isLocalRequest(req: LocalityRequest): boolean {
  const socket = req.socket as Socket | undefined;
  if (socket && remoteOnlySockets.has(socket)) return false;
  if (hasForwardingHeaders(req.headers)) return false;
  if (!isLoopbackAddress(req.ip || socket?.remoteAddress || '')) return false;
  return namesThisMachine(req.headers);
}
