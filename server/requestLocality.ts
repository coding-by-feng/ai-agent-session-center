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
import { isIP, type Socket } from 'net';
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

/**
 * A top-level GET navigation in a browser on this machine, to the main listener: checks 1–4 of
 * isLocalRequest, and no Origin (a navigation sends none), but NOT Sec-Fetch-Site, because a
 * redirect from another site (Google → AASC Cloud → here) is cross-site by definition. ONLY for a
 * route that acts on nothing but a secret it handed out itself: the Google sign-in callback
 * (AASC-61), which does nothing without the 256-bit state of a sign-in this process started.
 */
export function isLocalNavigation(req: LocalityRequest): boolean {
  const socket = req.socket as Socket | undefined;
  if (socket && remoteOnlySockets.has(socket)) return false;
  if (hasForwardingHeaders(req.headers)) return false;
  if (!isLoopbackAddress(req.ip || socket?.remoteAddress || '')) return false;
  const host = hostHeaderName(typeof req.headers?.host === 'string' ? req.headers.host : undefined);
  return host !== null && LOOPBACK_HOSTNAMES.has(host) && req.headers?.origin === undefined;
}

/**
 * Rate-limit keys made from a trusted proxy's X-Forwarded-For entry carry this prefix, so
 * authManager can give them a shared ceiling on top of their own buckets.
 */
export const PROXIED_KEY_PREFIX = 'proxied:';

/** Whether a proxy that sets X-Forwarded-For sits in front of the remote-only listener. Off by default. */
let trustForwardedFor = false;

/** Set once at start from resolveTrustForwardedFor (index.ts). */
export function setTrustForwardedFor(on: boolean): void {
  trustForwardedFor = on;
}

/** `AASC_TRUST_PROXY=1` / `0` wins over `"trustForwardedFor": true` in server-config.json; anything else is off. */
export function resolveTrustForwardedFor(envValue: string | undefined, configValue: unknown): boolean {
  if (envValue === '1') return true;
  if (envValue === '0') return false;
  return configValue === true;
}

/**
 * The address a per-client rate limit buckets by: login, and the phone's /pair, /challenge and
 * /session (terminal-editions plan §7.6).
 *
 * Behind a reverse proxy (Caddy in front of the remote-only listener) every client connects from
 * 127.0.0.1, so one bucket for everyone let five bad passwords from anyone lock every device out.
 * When the owner says such a proxy is there (AASC_TRUST_PROXY=1 / trustForwardedFor), a request on
 * a remote-only socket is bucketed by the LAST X-Forwarded-For entry: the one the proxy appended for
 * the peer it saw, which the client can't choose (it can only prepend).
 *
 * Off by default (security review H1): without a proxy that sets the header, a local account, or a
 * relay that passes headers through (ssh -R, socat, frp), would name a new "client" on every try and
 * guess the password without limit. Even when on, these keys carry PROXIED_KEY_PREFIX and share an
 * aggregate ceiling in authManager.
 *
 * Everywhere else the header is ignored, as before: anyone can send it to the main listener.
 * This is a bucket key, never a locality signal: isLocalRequest still refuses every forwarded request.
 */
export function rateLimitAddress(req: LocalityRequest): string {
  const socket = req.socket as Socket | undefined;
  const peer = req.ip || socket?.remoteAddress || 'unknown';
  if (!trustForwardedFor || !socket || !remoteOnlySockets.has(socket)) return peer;
  const header = req.headers?.['x-forwarded-for'];
  // Node joins repeated X-Forwarded-For headers with ", ", so the last entry is last either way.
  const raw = Array.isArray(header) ? header.join(', ') : header;
  const last = raw?.split(',').pop()?.trim() ?? '';
  return isIP(last) ? `${PROXIED_KEY_PREFIX}${last}` : peer;
}
