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
//   3. its peer address is loopback.
// Anything else — including an unknown or empty address — is remote. Failing
// closed is the right direction for a security gate.

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
  return isLoopbackAddress(req.ip || socket?.remoteAddress || '');
}
