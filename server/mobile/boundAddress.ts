// boundAddress.ts — the `host:port` an answer of this machine is bound to (plan 18, stage 2).
//
// A computer's sealed account enroll (computerEnroll.ts), a phone's (accountEnroll.ts, plan 17) and the machine's
// proof of itself (/identify) all name an address, and the device accepts them only for the address it dialled
// itself: the cloud never vouches for an address, and a box that passes a request on reaches this machine from
// its own socket, so what comes back names this machine's address, not the box's.
//
// That address is this machine's own on the request's socket (`reachedAt`). Two cases need the request's Host
// header instead, because the socket's address is then not the one the client dialled:
//   (a) a forwarded port: the Host is EXACTLY the public `address:port` this machine publishes. The socket's
//       address is a private one behind the router;
//   (b) Tailscale in userspace: the Host is EXACTLY the Tailscale `address:port` this machine publishes AND the
//       request arrived the way userspace Tailscale delivers one: on a loopback socket, on the very port that is
//       published (it hands the connection to 127.0.0.1 on the port the client dialled), not on the remote-only
//       listener, and with none of a proxy's forwarding headers (requestLocality.ts FORWARDING_HEADERS: Tailscale
//       hands over raw TCP and adds none, while an HTTP reverse proxy pointed at the main port adds them). With a
//       kernel Tailscale the socket's address is the Tailscale address itself, so nothing is needed, and nothing
//       is taken.
// A rewritten Host can then only earn an answer for an address its sender did not dial, which the sender refuses.
//
// And one case where the socket's own address must NOT be answered for, although it is the Host: a request on a
// PRIVATE socket address (RFC 1918, link-local) from a PUBLIC peer. It came through the router's forwarded port,
// so nobody on the home network sent it. A hostile network a client is on can sit at this machine's
// home-network address and pass the request on to that forwarded port; the socket's own address is then the
// very address the client dialled. Such a request earns the published public pair when its Host names exactly
// that (case a), and otherwise UNBOUND, a fixed value no device can have dialled: never `reachedAt`.
// Everything else is as before: a private peer (a client on the home network, this machine itself, a router's
// hairpin, a Docker bridge), a Tailscale or unknown peer, an IPv6 one, a public socket address (a server on the
// internet), loopback.
//
// Why (b) is that narrow: 100.64.0.0/10 is carrier-NAT space as well as Tailscale's, so on some networks a box
// CAN sit at the address a client dials. "Loopback" alone would also be true of the remote-only listener
// (remoteListener.ts) and of any tunnel pointed at it, and those pass the Host through: such a box could relay
// through one and be answered for the Tailscale pair. That listener is on another port and its sockets are
// marked, so both conditions shut it out.
//
// What stays open: a TCP-level tunnel pointed at the MAIN port on loopback looks exactly like userspace
// Tailscale (loopback, the published port, not remote-only, no forwarding header) and is bound the same way.
// Tunnels and relays belong on the remote-only listener, never on the main port (requestLocality.ts says so
// too). For (a), a public address set by hand that has since gone to someone else lets that party relay to the
// real forwarded port; the setting has to be kept true. And the forward is seen only by its peer address: a
// router that rewrites the source of forwarded connections to its own home-network address (some do, and so
// does a NAT in front of a container) hides it, and such a request is answered for the socket address as a
// home-network client's is. So is one whose peer is in carrier-NAT space (100.64.0.0/10), which a Tailscale
// subnet router's clients share. The other way round, a network that routes public addresses to this machine's
// private one without a forward (rare) loses the home-network answer: its clients need the public pair.
//
// The home-network address is NEVER taken from Host. On a direct connection the socket's address already is the
// one dialled; and a private address is the one kind a box on ANOTHER network can hold too, so bound by Host such
// a box could pass a request on by any road that ends on another socket of this machine and get back an answer
// for the very address the client dialled.
//
// Nothing is resolved or normalised: exact `ipv4:port` text, or the bare address on port 80, which an HTTP
// client leaves out of the Host it sends.

import type { Request } from 'express';
import { isPrivateLanAddress, isPublicAddress, isTailnetAddress } from '../networkInfo.js';
import { hasForwardingHeaders, isRemoteOnlySocket } from '../requestLocality.js';

/**
 * What an answer is bound to when no address may be named: the request came through a forwarded port and its
 * Host is not the public pair this machine publishes. Not a `host:port`, so no device can have dialled it.
 */
export const UNBOUND = 'unbound';

/**
 * What this machine publishes that a Host may name: its public address (only with "Public IP" ticked and one
 * known), its Tailscale address (only with Tailscale ticked and connected), and the port other devices dial.
 */
export interface PublishedAddresses {
  public: string | null;
  tailnet: string | null;
  port: number;
}

/** This Mac's own address on the request's socket (IPv4-mapped IPv6 as plain IPv4). */
export function localAddressOf(req: Request): string {
  return (req.socket.localAddress ?? '').replace(/^::ffff:/i, '');
}

/** This Mac's own `address:port` on the request's socket. */
export function reachedAt(req: Request): string {
  return `${localAddressOf(req)}:${req.socket.localPort ?? ''}`;
}

/** The peer's address on the request's socket (IPv4-mapped IPv6 as plain IPv4); '' when it is not known. */
function remoteAddressOf(req: Request): string {
  return (req.socket.remoteAddress ?? '').replace(/^::ffff:/i, '');
}

/** 127.0.0.0/8 or ::1, as canonical text. */
function isLoopback(address: string): boolean {
  if (address === '::1') return true;
  const octets = /^127\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  return octets !== null && octets.slice(1).every((octet) => Number(octet) <= 255);
}

export function boundAddress(input: {
  reachedAt: string;
  /** This machine's own address on the request's socket, without the port. */
  localAddress: string;
  /** This machine's own port on the request's socket; undefined when it is not known. */
  localPort: number | undefined;
  /**
   * The peer's address on the request's socket, as plain IPv4 text; undefined or '' when it is not known. Only
   * a public one changes anything, and anything unreadable is not one.
   */
  remoteAddress: string | undefined;
  /** The request arrived on the remote-only listener (requestLocality.ts), where tunnels and relays end. */
  remoteOnly: boolean;
  /** The request carries one of a proxy's forwarding headers (requestLocality.ts hasForwardingHeaders). */
  forwardingHeaders: boolean;
  /** The request's Host header, as sent. */
  host: string | undefined;
  /** Null while this machine publishes nothing ("Show this computer to my account" off). */
  published: PublishedAddresses | null;
}): string {
  const { host, published } = input;
  // Through the router's forwarded port: the socket's own address is not one this request may be answered for.
  const throughForward = isPrivateLanAddress(input.localAddress) && isPublicAddress(input.remoteAddress ?? '');
  const otherwise = throughForward ? UNBOUND : input.reachedAt;
  if (host === undefined || published === null) return otherwise;
  /** The pair `address:port` when the Host names exactly it. */
  const named = (address: string): string | null => {
    const pair = `${address}:${published.port}`;
    return host === pair || (published.port === 80 && host === address) ? pair : null;
  };
  // Each address is taken only as its own kind, whatever a source says: a private address is never one of them.
  const viaPublic = published.public !== null && isPublicAddress(published.public) ? named(published.public) : null;
  if (viaPublic) return viaPublic;
  // Userspace Tailscale, and nothing that merely ends on loopback: the main listener's own published port, and
  // raw TCP (a proxy that speaks HTTP to the main port says so in its headers).
  const userspaceTailscale = isLoopback(input.localAddress) && input.localPort === published.port
    && !input.remoteOnly && !input.forwardingHeaders;
  const viaTailnet = published.tailnet !== null && isTailnetAddress(published.tailnet) && userspaceTailscale
    ? named(published.tailnet)
    : null;
  return viaTailnet ?? otherwise;
}

/**
 * The request's Host header when it sent exactly one. Node keeps the first Host line and drops the rest, so a
 * request with two would otherwise be read by whichever one its sender put first.
 */
function onlyHost(req: Request): string | undefined {
  let lines = 0;
  for (let i = 0; i < req.rawHeaders.length; i += 2) {
    if (req.rawHeaders[i].toLowerCase() === 'host') lines += 1;
  }
  return lines === 1 ? req.headers.host : undefined;
}

/**
 * `boundAddress` for a request. `published` is asked only when the Host could name a published pair: never when
 * it is the socket address already (no published pair is that), so the usual request (every phone's on the home
 * network) costs no lookup. A lookup that fails counts as nothing published. Every request goes through the one
 * rule, lookup or not: the socket address is not answered for on the way out of a shortcut.
 */
export async function boundAddressOf(
  req: Request,
  published?: () => Promise<PublishedAddresses | null>,
): Promise<string> {
  const reached = reachedAt(req);
  const host = onlyHost(req);
  let now: PublishedAddresses | null = null;
  if (published && host !== undefined && host !== reached) {
    try {
      now = await published();
    } catch {
      now = null;
    }
  }
  return boundAddress({
    reachedAt: reached,
    localAddress: localAddressOf(req),
    localPort: req.socket.localPort,
    remoteAddress: remoteAddressOf(req),
    remoteOnly: isRemoteOnlySocket(req.socket),
    forwardingHeaders: hasForwardingHeaders(req.headers),
    host,
    published: now,
  });
}
