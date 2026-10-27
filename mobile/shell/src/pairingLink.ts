// pairingLink.ts — read the QR / link the desktop shows (AASC-17).
//
// https://aasc.work/pair#v=2&name=…&lan=…&ts=…&p=…&mc=…
// Everything here came from a camera or a tapped link, so every field is
// validated before the shell touches the network with it.
//
// AASC-52: the link carries the Mac's code only. A QR from before also had a
// backend code (`be`, `bc`, `md`); those are ignored: anyone who photographed
// the QR could redeem that half. The backend code now comes from the Mac after
// it allows this phone (backendLink.ts).

export interface PairingLink {
  version: 2;
  name: string;
  lan: string | null;
  tailnet: string | null;
  port: number;
  macCode: string;
}

const LINK_ORIGIN = 'https://aasc.work';
const LINK_PATH = '/pair';
const MAC_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;
/** The backend must live under aasc.work; nothing can point the phone anywhere else. */
const BACKEND_HOST = /^(?:[a-z0-9-]+\.)*aasc\.work$/;

/** Checked before every backend call: a host must be under aasc.work. */
export function isBackendHost(host: string | null | undefined): boolean {
  return typeof host === 'string' && BACKEND_HOST.test(host);
}

/**
 * Four octets in canonical form: each `0`, or digits with no leading zero. The URL parser the phone dials
 * through reads a leading-zero octet as octal, so `010.1.1.1` would pass as private 10.x here yet be dialled
 * as 8.1.1.1. An address that passes is therefore dialled exactly as written.
 */
function ipv4(raw: string | null): number[] | null {
  if (!raw) return null;
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(raw);
  if (!m) return null;
  const parts = m.slice(1).map(Number);
  return parts.every((n) => n <= 255) ? parts : null;
}

/** RFC 1918 private ranges and link-local: the only plain-HTTP LAN targets allowed. */
export function isPrivateLanAddress(raw: string | null): boolean {
  const ip = ipv4(raw);
  if (!ip) return false;
  const [a, b] = ip;
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

/** Tailscale's CGNAT range 100.64.0.0/10. */
export function isTailnetAddress(raw: string | null): boolean {
  const ip = ipv4(raw);
  return !!ip && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127;
}

function fragmentOf(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed.startsWith('v=')) return trimmed; // a bare fragment typed or pasted
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }
  if (url.origin !== LINK_ORIGIN || url.pathname !== LINK_PATH || !url.hash) return null;
  return url.hash.slice(1);
}

export function parsePairingLink(input: string): PairingLink | null {
  const read = readPairingLink(input);
  return read.ok ? read.link : null;
}

/**
 * Why a link was refused (Oct 27 2026): a real pairing code whose only addresses the phone won't dial
 * (a public server address, say) used to read "That QR isn’t an AASC pairing code" and sent people back
 * to the same QR. `address` is the refused `lan`, or null when the code named none.
 */
export type PairingLinkRead =
  | { ok: true; link: PairingLink }
  | { ok: false; why: 'not-a-pairing-link' }
  | { ok: false; why: 'no-usable-address'; address: string | null };

export function readPairingLink(input: string): PairingLinkRead {
  const notALink = { ok: false, why: 'not-a-pairing-link' } as const;
  const fragment = fragmentOf(input);
  if (!fragment) return notALink;
  const p = new URLSearchParams(fragment);
  if (p.get('v') !== '2') return notALink;

  const name = (p.get('name') ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80);
  const lan = p.get('lan');
  const tailnet = p.get('ts');
  const port = Number(p.get('p'));
  const macCode = p.get('mc') ?? '';

  if (!name) return notALink;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return notALink;
  if (!MAC_CODE.test(macCode)) return notALink;
  const lanOk = lan !== null && isPrivateLanAddress(lan);
  const tsOk = tailnet !== null && isTailnetAddress(tailnet);
  // A bad address is not ignored, it's refused: the whole link.
  if (lan !== null && !lanOk) return { ok: false, why: 'no-usable-address', address: lan.slice(0, 64) };
  if (tailnet !== null && !tsOk) return { ok: false, why: 'no-usable-address', address: tailnet.slice(0, 64) };
  if (!lanOk && !tsOk) return { ok: false, why: 'no-usable-address', address: null };

  return { ok: true, link: { version: 2, name, lan: lanOk ? lan : null, tailnet: tsOk ? tailnet : null, port, macCode } };
}

/** What the pair screen says about a link it refused. */
export function pairingLinkRefusal(read: Exclude<PairingLinkRead, { ok: true }>, notALinkMessage: string): string {
  if (read.why === 'not-a-pairing-link') return notALinkMessage;
  const named = read.address ? `This pairing code names ${read.address}, which` : 'This pairing code names no address';
  const tail = read.address ? ' the app can’t reach.' : ' the app can reach.';
  return `${named}${tail} Put the computer on the same Wi-Fi as this phone, or sign both in to Tailscale, then show a new code.`;
}
