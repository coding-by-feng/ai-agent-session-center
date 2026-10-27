/**
 * Read another computer's pairing link (Remote computers, Oct 28 2026).
 *
 *   https://aasc.work/pair#v=2&name=…&lan=…&ts=…&p=…&mc=…   (or the bare `v=2&…` fragment)
 *
 * The same rules as the phone shell's `readPairingLink` (mobile/shell/src/pairingLink.ts):
 * everything here was pasted by a person, and the main process dials plain HTTP to
 * whatever address it names, so only a canonical private (RFC 1918 / link-local) or
 * Tailscale (100.64.0.0/10) IPv4 passes, and one bad address refuses the whole link.
 *
 * Kept import-free: `electron/` cannot import from `mobile/` (tsconfig rootDir), so this
 * is a mirror, and test/remotePairingLink.test.ts runs one table through both.
 */

export interface RemotePairingLink {
  version: 2
  name: string
  lan: string | null
  tailnet: string | null
  port: number
  macCode: string
}

export type RemotePairingLinkRead =
  | { ok: true; link: RemotePairingLink }
  | { ok: false; why: 'not-a-pairing-link'; error: string }
  | { ok: false; why: 'no-usable-address'; address: string | null; error: string }

const LINK_ORIGIN = 'https://aasc.work'
const LINK_PATH = '/pair'
const MAC_CODE = /^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{10}$/

export const NOT_A_PAIRING_LINK =
  'That isn’t an AASC pairing link. Copy the link again from the other computer’s pairing panel.'

/**
 * Four octets in canonical form: each `0`, or digits with no leading zero. A URL parser
 * reads a leading-zero octet as octal, so `010.1.1.1` would pass as private 10.x here
 * yet be dialled as 8.1.1.1. An address that passes is dialled exactly as written.
 */
function ipv4(raw: string | null): number[] | null {
  if (!raw) return null
  const m = /^(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(raw)
  if (!m) return null
  const parts = m.slice(1).map(Number)
  return parts.every((n) => n <= 255) ? parts : null
}

/** RFC 1918 private ranges and link-local: the only plain-HTTP LAN targets allowed. */
export function isPrivateLanAddress(raw: string | null): boolean {
  const ip = ipv4(raw)
  if (!ip) return false
  const [a, b] = ip
  return a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254)
}

/** Tailscale's CGNAT range 100.64.0.0/10. */
export function isTailnetAddress(raw: string | null): boolean {
  const ip = ipv4(raw)
  return !!ip && ip[0] === 100 && ip[1] >= 64 && ip[1] <= 127
}

function fragmentOf(input: string): string | null {
  const trimmed = input.trim()
  if (trimmed.startsWith('v=')) return trimmed // a bare fragment pasted on its own
  let url: URL
  try {
    url = new URL(trimmed)
  } catch {
    return null
  }
  if (url.origin !== LINK_ORIGIN || url.pathname !== LINK_PATH || !url.hash) return null
  return url.hash.slice(1)
}

/** The shell's `pairingLinkRefusal` wording, said of a computer instead of a phone. */
function noAddress(address: string | null): RemotePairingLinkRead {
  const named = address ? `This pairing link names ${address}, which` : 'This pairing link names no address'
  const tail = address ? ' this computer can’t reach.' : ' this computer can reach.'
  return {
    ok: false,
    why: 'no-usable-address',
    address,
    error: `${named}${tail} Put both computers on the same network, or sign both in to Tailscale, then show a new link.`,
  }
}

/** Cloud instance metadata (link-local): never a remote AASC. */
export const CLOUD_METADATA_ADDRESS = '169.254.169.254'

export function readRemotePairingLink(input: string): RemotePairingLinkRead {
  const notALink = { ok: false, why: 'not-a-pairing-link', error: NOT_A_PAIRING_LINK } as const
  if (typeof input !== 'string') return notALink
  const fragment = fragmentOf(input)
  if (!fragment) return notALink
  const p = new URLSearchParams(fragment)
  if (p.get('v') !== '2') return notALink

  const name = (p.get('name') ?? '').replace(/[\x00-\x1F\x7F\p{Cf}]/gu, '').trim().slice(0, 80)
  const lan = p.get('lan')
  const tailnet = p.get('ts')
  const port = Number(p.get('p'))
  const macCode = p.get('mc') ?? ''

  if (!name) return notALink
  if (!Number.isInteger(port) || port < 1 || port > 65535) return notALink
  if (!MAC_CODE.test(macCode)) return notALink
  // Link-local, but the cloud metadata address: a link never sends this computer's name there.
  const lanOk = lan !== null && isPrivateLanAddress(lan) && lan !== CLOUD_METADATA_ADDRESS
  const tsOk = tailnet !== null && isTailnetAddress(tailnet)
  // A bad address is not ignored, it's refused: the whole link.
  if (lan !== null && !lanOk) return noAddress(lan.slice(0, 64))
  if (tailnet !== null && !tsOk) return noAddress(tailnet.slice(0, 64))
  if (!lanOk && !tsOk) return noAddress(null)

  return { ok: true, link: { version: 2, name, lan: lanOk ? lan : null, tailnet: tsOk ? tailnet : null, port, macCode } }
}
