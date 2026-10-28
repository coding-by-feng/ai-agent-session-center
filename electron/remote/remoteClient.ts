/**
 * This computer's calls to another computer's AASC (Remote computers, Oct 28 2026).
 *
 * It pairs exactly like the phone shell (mobile/shell/src/pairingClient.ts), with
 * `platform: 'desktop'`: redeem the link's one-time code for a device id + token,
 * then every sign-in answers a single-use nonce with
 * HMAC-SHA256(key = SHA-256(token), nonce), so the token itself never travels again
 * and a sniffed exchange on the home network can't be replayed.
 *
 * Pure: fetch, the clock and the random source are injected, so tests never touch
 * the network. Plain HTTP goes only to addresses pairingLinkRules.ts validated
 * (private LAN or Tailscale, or a public IPv4 the link named in `pub=`, tried last), redirects are never followed (a 3xx is just a failed
 * answer), each try gives up after a few seconds, and no token is ever put in an
 * error message.
 */
import { createHash, createHmac, timingSafeEqual } from 'crypto'
import { isPrivateLanAddress, isPublicAddress, isTailnetAddress, type RemotePairingLink } from './pairingLinkRules.js'

/** The slice of a fetch Response this client reads. */
export interface FetchResponse {
  status: number
  text(): Promise<string>
  /** Read in chunks when present, so an oversized answer is cut off, not buffered whole. */
  body?: ReadableStream<Uint8Array> | null
}

export type FetchLike = (url: string, init: {
  method: string
  headers: Record<string, string>
  body?: string
  redirect: 'manual'
  signal: AbortSignal
}) => Promise<FetchResponse>

export interface RemoteClientDeps {
  fetch: FetchLike
  /** `n` random bytes as lowercase hex (crypto.randomBytes in the app). */
  randomHex(n: number): string
  /** Per-try budget for each address; default TRY_TIMEOUT_MS. */
  timeoutMs?: number
}

/** Where a remote listens: its addresses from the link (tailnet maybe refreshed by /paths). */
export interface RemoteTarget {
  lan: string | null
  tailnet: string | null
  /** A public IPv4 from the link's `pub=` (Oct 28 2026): plain HTTP over the Internet, so tried last. */
  publicAddress?: string | null
  port: number
}

export interface RemoteCredentials {
  deviceId: string
  deviceToken: string
}

export type Via = 'lan' | 'tailnet' | 'public'

export const TRY_TIMEOUT_MS = 3_000
/** GET /api/sessions can be a few hundred KB over Tailscale: a longer budget than a handshake. */
export const SESSIONS_TIMEOUT_MS = 8_000
/** The largest answer read from a remote's pairing and sign-in routes. */
export const HANDSHAKE_MAX_BYTES = 64 * 1024
/** The largest GET /api/sessions answer read for the shared count. */
export const SESSIONS_MAX_BYTES = 8 * 1024 * 1024

/** = server/mobile/deviceAuth.ts PATHS_PROOF_PREFIX: /paths proof is over this + nonce + ':' + tailnet ('-') + ':' + port. */
export const PATHS_PROOF_PREFIX = 'aasc-paths:'

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
/** A sign-in nonce as the remote issues them (its DeviceProof schema): base64url, no ':'. */
const SIGN_IN_NONCE = /^[A-Za-z0-9_-]{16,64}$/
const HEX64 = /^[0-9a-f]{64}$/

/** HMAC-SHA256(key = raw SHA-256(deviceToken), message), hex: deviceAuth.proofForToken. */
export function deviceProof(deviceToken: string, message: string): string {
  const key = createHash('sha256').update(deviceToken).digest()
  return createHmac('sha256', key).update(message).digest('hex')
}

function sameHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  return timingSafeEqual(Buffer.from(a), Buffer.from(b))
}

/** The addresses to try, in order: the home network first (fast, direct), then Tailscale, then a public address. */
export function addressPlan(target: RemoteTarget): { via: Via; origin: string }[] {
  const plan: { via: Via; origin: string }[] = []
  if (!Number.isInteger(target.port) || target.port < 1 || target.port > 65535) return plan
  if (target.lan && isPrivateLanAddress(target.lan)) plan.push({ via: 'lan', origin: `http://${target.lan}:${target.port}` })
  if (target.tailnet && isTailnetAddress(target.tailnet)) plan.push({ via: 'tailnet', origin: `http://${target.tailnet}:${target.port}` })
  if (target.publicAddress && isPublicAddress(target.publicAddress)) {
    plan.push({ via: 'public', origin: `http://${target.publicAddress}:${target.port}` })
  }
  return plan
}

interface Answer {
  status: number
  data: unknown
}

/** Walk a parsed JSON body; undefined when any step is missing. */
function field(data: unknown, pathParts: string[]): unknown {
  let cur: unknown = data
  for (const key of pathParts) {
    if (!cur || typeof cur !== 'object') return undefined
    cur = (cur as Record<string, unknown>)[key]
  }
  return cur
}

/** A body as text, refusing (throwing) past `maxBytes` before it is all held in memory. */
async function readCapped(res: FetchResponse, maxBytes: number): Promise<string> {
  if (!res.body) {
    const text = await res.text()
    if (Buffer.byteLength(text) > maxBytes) throw new Error('answer too large')
    return text
  }
  const reader = res.body.getReader()
  const chunks: Uint8Array[] = []
  let size = 0
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    size += value.byteLength
    if (size > maxBytes) {
      void reader.cancel()
      throw new Error('answer too large')
    }
    chunks.push(value)
  }
  return Buffer.concat(chunks).toString('utf8')
}

/** One HTTP call with its own deadline and size cap (the body read included). Throws on network failure, timeout or an oversized answer. */
async function call(
  deps: RemoteClientDeps, method: 'GET' | 'POST', url: string,
  opts: { body?: unknown; bearer?: string; timeoutMs?: number; maxBytes?: number } = {},
): Promise<Answer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? deps.timeoutMs ?? TRY_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
    const res = await deps.fetch(url, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      redirect: 'manual',
      signal: controller.signal,
    })
    const text = await readCapped(res, opts.maxBytes ?? HANDSHAKE_MAX_BYTES)
    let data: unknown = null
    try { data = text ? JSON.parse(text) : null } catch { data = null }
    return { status: res.status, data }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * Try `fn` at each address in turn until one answers. A network error, a timeout or an
 * answer that isn't AASC's JSON (`NotAasc`: some other box now holds that LAN address)
 * moves on to the next; an AASC refusal does not (that computer did answer, and asking
 * again elsewhere could spend a one-time code twice).
 */
class NotAasc extends Error {}

/** Throw NotAasc unless the body parsed as a JSON object, as every AASC answer does. */
function aascAnswer(a: Answer): Answer {
  if (!a.data || typeof a.data !== 'object' || Array.isArray(a.data)) throw new NotAasc()
  return a
}

async function firstAnswer<T>(
  target: RemoteTarget, fn: (origin: string) => Promise<T>,
): Promise<{ via: Via; origin: string; value: T } | null> {
  for (const { via, origin } of addressPlan(target)) {
    try {
      return { via, origin, value: await fn(origin) }
    } catch {
      // unreachable here: try the next address
    }
  }
  return null
}

const RATE_LIMITED = 'That computer refused too many attempts from here. Wait a few minutes and try again.'
const NO_PASSWORD = 'That computer has no dashboard password, so it accepts no remote devices. Set one there first.'

/** A refusal every public pairing route can give, as a sentence; null when it's none of these. */
function commonRefusal(a: Answer): string | null {
  if (a.status === 429) return RATE_LIMITED
  if (a.status === 403 && field(a.data, ['code']) === 'REMOTE_PASSWORD_REQUIRED') return NO_PASSWORD
  if (a.status >= 300 && a.status < 400) return 'That address answered with a redirect, which isn’t AASC. Check the link.'
  return null
}

export function unreachableMessage(target: RemoteTarget): string {
  const addrs = [target.lan, target.tailnet, target.publicAddress].filter(Boolean).join(' or ')
  const reach = target.publicAddress
    ? 'is its port open to this computer, or is this computer on the same network or Tailscale?'
    : 'is this computer on the same network or Tailscale?'
  return `No answer from ${addrs || 'that computer'} on port ${target.port}. Is AASC running there, and ${reach}`
}

export type PairResult =
  | { ok: true; deviceId: string; deviceToken: string; confirmCode: string; via: Via }
  | { ok: false; error: string }

/** Redeem the link's one-time code: the remote makes a pending device for this computer. */
export async function pair(deps: RemoteClientDeps, link: RemotePairingLink, label: string): Promise<PairResult> {
  const target = { lan: link.lan, tailnet: link.tailnet, publicAddress: link.publicAddress ?? null, port: link.port }
  const hit = await firstAnswer(target, async (origin) => aascAnswer(await call(deps, 'POST', `${origin}/api/mobile/pair`, {
    body: { code: link.macCode, label: label.slice(0, 200) || 'Computer', platform: 'desktop' },
  })))
  if (!hit) return { ok: false, error: unreachableMessage(target) }
  const a = hit.value
  if (a.status !== 201) {
    const refusal = commonRefusal(a)
    if (refusal) return { ok: false, error: refusal }
    if (field(a.data, ['code']) === 'INVALID_PAIRING_CODE') {
      return { ok: false, error: 'That pairing link expired or was already used. Show a new one on the other computer.' }
    }
    if (a.status === 400) return { ok: false, error: 'That computer’s AASC is too old to pair with another computer. Update it first.' }
    return { ok: false, error: `Pairing failed (${a.status}).` }
  }
  const deviceId = field(a.data, ['data', 'deviceId'])
  const deviceToken = field(a.data, ['data', 'deviceToken'])
  const confirmCode = field(a.data, ['data', 'confirmCode'])
  if (typeof deviceId !== 'string' || !UUID.test(deviceId)
    || typeof deviceToken !== 'string' || deviceToken.length < 20 || deviceToken.length > 512
    || typeof confirmCode !== 'string' || !/^\d{6}$/.test(confirmCode)) {
    return { ok: false, error: 'That computer sent an unexpected answer.' }
  }
  return { ok: true, deviceId, deviceToken, confirmCode, via: hit.via }
}

/** Ask for a nonce and answer it: the body for /session or /unpair. Null with a reason when the challenge is refused. */
async function provenBody(
  deps: RemoteClientDeps, origin: string, creds: RemoteCredentials,
): Promise<{ ok: true; body: { deviceId: string; nonce: string; proof: string } } | { ok: false; answer: Answer }> {
  const a = aascAnswer(await call(deps, 'POST', `${origin}/api/mobile/challenge`, { body: { deviceId: creds.deviceId } }))
  const nonce = field(a.data, ['data', 'nonce'])
  if (a.status !== 200 || typeof nonce !== 'string' || !SIGN_IN_NONCE.test(nonce)) return { ok: false, answer: a }
  return { ok: true, body: { deviceId: creds.deviceId, nonce, proof: deviceProof(creds.deviceToken, nonce) } }
}

export type SignInResult =
  | { state: 'ok'; token: string; expiresIn: number; origin: string; via: Via }
  | { state: 'pending'; origin: string; via: Via }
  /** `verified`: DEVICE_REVOKED (the remote checked the proof); otherwise it doesn't know this device. */
  | { state: 'revoked'; verified: boolean; origin: string; via: Via }
  | { state: 'offline'; message: string }
  | { state: 'error'; message: string }

/** Challenge → proof → session, at the first address that answers. */
export async function signIn(deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials): Promise<SignInResult> {
  // Only the challenge picks the address: once one answers, the session goes to the same one.
  const hit = await firstAnswer(target, (origin) => provenBody(deps, origin, creds))
  if (!hit) return { state: 'offline', message: unreachableMessage(target) }
  const { origin, via } = hit
  if (hit.value.ok === false) {
    return { state: 'error', message: commonRefusal(hit.value.answer) ?? `Sign-in failed (${hit.value.answer.status}).` }
  }
  let a: Answer
  try {
    a = await call(deps, 'POST', `${origin}/api/mobile/session`, { body: hit.value.body })
  } catch {
    return { state: 'offline', message: unreachableMessage(target) }
  }
  const code = field(a.data, ['code'])
  if (a.status === 200) {
    const token = field(a.data, ['data', 'token'])
    const expiresIn = field(a.data, ['data', 'expiresIn'])
    if (typeof token !== 'string' || !/^[A-Za-z0-9_-]{16,512}$/.test(token)) {
      return { state: 'error', message: 'That computer sent an unexpected answer.' }
    }
    const ttl = typeof expiresIn === 'number' && Number.isFinite(expiresIn) && expiresIn > 0 ? Math.min(expiresIn, 86_400) : 3_600
    return { state: 'ok', token, expiresIn: ttl, origin, via }
  }
  if (a.status === 403 && code === 'DEVICE_PENDING') return { state: 'pending', origin, via }
  if (a.status === 401 && (code === 'DEVICE_REVOKED' || code === 'DEVICE_UNKNOWN')) {
    return { state: 'revoked', verified: code === 'DEVICE_REVOKED', origin, via }
  }
  return { state: 'error', message: commonRefusal(a) ?? `Sign-in failed (${a.status}).` }
}

/** What the remote proves about its own addresses (POST /paths). */
export interface RemotePaths {
  tailnet: string | null
  port: number
}

/**
 * Ask a signed-in remote for its Tailscale address. The answer crosses plain HTTP on
 * the home network, where a box could rewrite it, so it counts only with the remote's
 * proof over a nonce chosen here: this device's key over PATHS_PROOF_PREFIX + nonce +
 * ':' + address ('-' for none) + ':' + port. Anything else is null and nothing is
 * saved. Never throws.
 */
export async function fetchPaths(
  deps: RemoteClientDeps, origin: string, sessionToken: string, creds: RemoteCredentials,
): Promise<RemotePaths | null> {
  try {
    const nonce = deps.randomHex(32)
    if (!HEX64.test(nonce)) return null
    const a = await call(deps, 'POST', `${origin}/api/mobile/paths`, { body: { nonce }, bearer: sessionToken })
    if (a.status !== 200) return null
    const tailnet = field(a.data, ['data', 'tailnet'])
    const port = field(a.data, ['data', 'port'])
    const proof = field(a.data, ['data', 'proof'])
    if (tailnet !== null && (typeof tailnet !== 'string' || !isTailnetAddress(tailnet))) return null
    if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) return null
    if (typeof proof !== 'string' || !HEX64.test(proof)) return null
    const expected = deviceProof(creds.deviceToken, `${PATHS_PROOF_PREFIX}${nonce}:${tailnet ?? '-'}:${port}`)
    return sameHex(proof, expected) ? { tailnet: tailnet as string | null, port } : null
  } catch {
    return null
  }
}

/** This computer removes itself from the remote. True only when the remote confirmed it. Never throws. */
export async function unpair(deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials): Promise<boolean> {
  const hit = await firstAnswer(target, async (origin) => {
    const proven = await provenBody(deps, origin, creds)
    if (!proven.ok) return false
    const a = await call(deps, 'POST', `${origin}/api/mobile/unpair`, { body: proven.body })
    return a.status === 200
  })
  return hit?.value ?? false
}

/**
 * How many sessions the remote shares with this computer: GET /api/sessions answers
 * an object keyed by session id, already filtered to what this device may see.
 * Null when it doesn't answer as expected. Never throws.
 */
export async function countShared(deps: RemoteClientDeps, origin: string, sessionToken: string): Promise<number | null> {
  try {
    const a = await call(deps, 'GET', `${origin}/api/sessions`, { bearer: sessionToken, timeoutMs: SESSIONS_TIMEOUT_MS, maxBytes: SESSIONS_MAX_BYTES })
    if (a.status !== 200 || !a.data || typeof a.data !== 'object') return null
    return Array.isArray(a.data) ? a.data.length : Object.keys(a.data).length
  } catch {
    return null
  }
}
