// pairingLink.ts — read the QR / link the desktop shows (AASC-17).
//
// https://aasc.work/pair#v=2&name=…&lan=…&ts=…&p=…&mc=…[&be=…&bc=…]
// Everything here came from a camera or a tapped link, so every field is
// validated before the shell touches the network with it.

export interface PairingLink {
  version: 2;
  name: string;
  lan: string | null;
  tailnet: string | null;
  port: number;
  macCode: string;
  backendHost: string | null;
  backendCode: string | null;
  /** The Mac's own backend device id (`md`): every push it asks for names it (aasc.mac). */
  macDeviceId: string | null;
}

const LINK_ORIGIN = 'https://aasc.work';
const LINK_PATH = '/pair';
const MAC_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/;
const BACKEND_CODE = /^[A-Za-z0-9_-]{16,64}$/;
const MAC_DEVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** The backend must live under aasc.work; a QR can't point the phone anywhere else. */
const BACKEND_HOST = /^(?:[a-z0-9-]+\.)*aasc\.work$/;

/** Checked again before every backend call: a stored host must still be under aasc.work. */
export function isBackendHost(host: string | null | undefined): boolean {
  return typeof host === 'string' && BACKEND_HOST.test(host);
}

function ipv4(raw: string | null): number[] | null {
  if (!raw) return null;
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(raw);
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
  const fragment = fragmentOf(input);
  if (!fragment) return null;
  const p = new URLSearchParams(fragment);
  if (p.get('v') !== '2') return null;

  const name = (p.get('name') ?? '').replace(/[\x00-\x1F\x7F]/g, '').trim().slice(0, 80);
  const lan = p.get('lan');
  const tailnet = p.get('ts');
  const port = Number(p.get('p'));
  const macCode = p.get('mc') ?? '';
  const backendHost = p.get('be');
  const backendCode = p.get('bc');
  const macDeviceId = p.get('md');

  if (!name) return null;
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  if (!MAC_CODE.test(macCode)) return null;
  const lanOk = lan !== null && isPrivateLanAddress(lan);
  const tsOk = tailnet !== null && isTailnetAddress(tailnet);
  if ((lan !== null && !lanOk) || (tailnet !== null && !tsOk)) return null; // a bad address is not ignored, it's refused
  if (!lanOk && !tsOk) return null;
  if ((backendHost === null) !== (backendCode === null)) return null;
  if (backendHost !== null && (!BACKEND_HOST.test(backendHost) || !BACKEND_CODE.test(backendCode ?? ''))) return null;

  return {
    version: 2,
    name,
    lan: lanOk ? lan : null,
    tailnet: tsOk ? tailnet : null,
    port,
    macCode,
    backendHost,
    backendCode,
    // Only with a backend code (it names the Mac's backend device); anything malformed is ignored.
    macDeviceId: backendHost !== null && macDeviceId !== null && MAC_DEVICE_ID.test(macDeviceId) ? macDeviceId : null,
  };
}
