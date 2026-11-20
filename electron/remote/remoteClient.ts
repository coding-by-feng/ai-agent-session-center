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
import { isHostedOrigin, isPrivateLanAddress, isPublicAddress, isTailnetAddress, type RemotePairingLink } from './pairingLinkRules.js'

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
  httpsOrigin?: string | null
  publicAddress?: string | null
  port: number
}

export interface RemoteCredentials {
  deviceId: string
  deviceToken: string
}

export type Via = 'lan' | 'tailnet' | 'public' | 'https'

export const TRY_TIMEOUT_MS = 3_000
/** GET /api/sessions can be a few hundred KB over Tailscale: a longer budget than a handshake. */
export const SESSIONS_TIMEOUT_MS = 8_000
/** The largest answer read from a remote's pairing and sign-in routes. */
export const HANDSHAKE_MAX_BYTES = 64 * 1024
/** The largest GET /api/sessions answer read for the shared count. */
export const SESSIONS_MAX_BYTES = 8 * 1024 * 1024

/** = server/mobile/deviceAuth.ts PATHS_PROOF_PREFIX: /paths proof is over this + nonce + ':' + tailnet ('-') + ':' + port. */
export const PATHS_PROOF_PREFIX = 'aasc-paths:'
/** = server/mobile/deviceAuth.ts WHO_TAG_PREFIX: this computer names itself with its key over this + nonce, never its id. */
export const WHO_TAG_PREFIX = 'aasc-who:'
/** = server/mobile/deviceAuth.ts MAC_PROOF_PREFIX: the machine's proof is over this + nonce + ':' + the address it was reached at. */
export const MAC_PROOF_PREFIX = 'aasc-mac:'

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
  if (target.httpsOrigin !== undefined && target.httpsOrigin !== null) return isHostedOrigin(target.httpsOrigin) ? [{via: 'https', origin: target.httpsOrigin}] : []
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
export async function readCapped(res: FetchResponse, maxBytes: number): Promise<string> {
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

/** The deadline of a call passed (the body read included): the request may have arrived, and nothing came back in time. */
export class RequestTimedOut extends Error {}

/**
 * One HTTP call with its own deadline and size cap (the body read included). Throws on network failure, an oversized
 * answer, or RequestTimedOut once the deadline passed.
 * `sameOrigin` names the request's own origin in `Origin`, as an https one always does: this computer's own server
 * (accountDirectory.ts) judges a local request by it.
 */
async function call(
  deps: RemoteClientDeps, method: 'GET' | 'POST', url: string,
  opts: { body?: unknown; bearer?: string; cookie?: string; timeoutMs?: number; maxBytes?: number; sameOrigin?: boolean } = {},
): Promise<Answer> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? deps.timeoutMs ?? TRY_TIMEOUT_MS)
  try {
    const headers: Record<string, string> = { Accept: 'application/json' }
    if (opts.sameOrigin || new URL(url).protocol === 'https:') headers.Origin = new URL(url).origin
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json'
    if (opts.bearer) headers.Authorization = `Bearer ${opts.bearer}`
    if (opts.cookie) headers.Cookie = opts.cookie
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
  } catch (err) {
    throw controller.signal.aborted ? new RequestTimedOut() : err
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
  if (target.httpsOrigin) return `No answer from ${target.httpsOrigin}. Check your internet connection and the order status, then retry.`
  const addrs = [target.lan, target.tailnet, target.publicAddress].filter(Boolean).join(' or ')
  const reach = target.publicAddress
    ? 'is its port open to this computer, or is this computer on the same network or Tailscale?'
    : 'is this computer on the same network or Tailscale?'
  return `No answer from ${addrs || 'that computer'} on port ${target.port}. Is AASC running there, and ${reach}`
}

export type PairResult =
  | { ok: true; deviceId: string; deviceToken: string; confirmCode: string; via: Via; approved?: boolean }
  | { ok: false; error: string }

/** Redeem the link's one-time code: the remote makes a pending device for this computer. */
export async function pair(deps: RemoteClientDeps, link: RemotePairingLink, label: string): Promise<PairResult> {
  const target = { httpsOrigin: link.httpsOrigin, lan: link.lan, tailnet: link.tailnet, publicAddress: link.publicAddress ?? null, port: link.port }
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
  return { ok: true, deviceId, deviceToken, confirmCode, via: hit.via, ...(field(a.data, ['data', 'status']) === 'active' ? { approved: true } : {}) }
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

/**
 * `host:port` of the origin dialled, with the port a URL leaves out (`http://h:80` has port ''); null when it isn't
 * one. What a machine's proof and its sealed account answer (accessSeal.ts) must name.
 */
export function dialledAddress(origin: string): string | null {
  try {
    const url = new URL(origin)
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null
    return `${url.hostname}:${url.port || (url.protocol === 'https:' ? '443' : '80')}`
  } catch {
    return null
  }
}

/**
 * What a machine proved about itself at an address (verifyMachineProof). `mismatch` and `none`: something answered,
 * with a proof for another address or with none. `silent`: nothing answered at all.
 */
export type MachineProof = 'verified' | 'mismatch' | 'none' | 'silent'

/**
 * How much a sign-in asks of the machine's proof (plan 18, contract C):
 *   required  a record made through the account: the machine proves itself at an address before this computer
 *             answers a challenge there, on any path; nothing is sent or used without a verified proof.
 *   skip      a record paired by link: no proof is asked for, as before plan 18. While a missing proof is tolerated
 *             the check stops no active attacker (a box answers 404), and a released machine binds its proof to its
 *             socket address, which is not the one dialled behind a forwarded port or userspace Tailscale: there it
 *             could only refuse records that work.
 */
export type ProofRule = 'required' | 'skip'

/**
 * Does what answers at `origin` hold this computer's key, and sit at the address this computer dialled? The machine
 * proves it over a nonce chosen here and over its own address as the request reached it (POST /identify,
 * deviceAuth.macProof, the proof the phone's LAN rescan uses): a box that passes the question on to the machine gets a
 * proof for the machine's address, not for its own. This computer names itself by a tag that changes with every nonce,
 * never by its device id. Only a record the machine's owner allowed is vouched for: one still waiting for Allow, or
 * removed there, gets a decoy and reads as `mismatch`. Never throws.
 */
export async function verifyMachineProof(deps: RemoteClientDeps, origin: string, creds: RemoteCredentials): Promise<MachineProof> {
  try {
    const nonce = deps.randomHex(32)
    const address = dialledAddress(origin)
    if (!HEX64.test(nonce) || !address) return 'silent' // nothing was asked
    const tag = deviceProof(creds.deviceToken, `${WHO_TAG_PREFIX}${nonce}`)
    const a = await call(deps, 'POST', `${origin}/api/mobile/identify`, { body: { tag, nonce } })
    const proof = field(a.data, ['data', 'proof'])
    if (a.status !== 200 || typeof proof !== 'string' || !HEX64.test(proof)) return 'none'
    return sameHex(proof, deviceProof(creds.deviceToken, `${MAC_PROOF_PREFIX}${nonce}:${address}`)) ? 'verified' : 'mismatch'
  } catch {
    return 'silent'
  }
}

/**
 * May the address at `origin` be trusted with this computer's session? The one place the rule lives: `required`
 * takes nothing but a verified proof (a wrong one and a missing one both refuse), `skip` asks nothing. Never throws.
 */
export async function machineProved(
  deps: RemoteClientDeps, origin: string, creds: RemoteCredentials, rule: ProofRule,
): Promise<boolean> {
  if (rule === 'skip') return true
  return (await verifyMachineProof(deps, origin, creds)) === 'verified'
}

export type SignInResult =
  | { state: 'ok'; token: string; expiresIn: number; origin: string; via: Via }
  | { state: 'pending'; origin: string; via: Via }
  /** `verified`: DEVICE_REVOKED (the remote checked the proof); otherwise it doesn't know this device. */
  | { state: 'revoked'; verified: boolean; origin: string; via: Via }
  | { state: 'offline'; message: string }
  | { state: 'error'; message: string }

/**
 * A sign-in that asked for the machine's proof first. `unverified`: something answered, but nothing proved it is the
 * machine at the address dialled (`origin`: the first that answered wrongly), so no sign-in was sent anywhere.
 */
export type ProvedSignInResult = SignInResult | { state: 'unverified'; origin: string; via: Via }

/**
 * The session step: answer the nonce at `origin` and read what comes back. A network failure here is `offline`, not
 * a reason to answer another address's nonce.
 */
async function openSession(
  deps: RemoteClientDeps, target: RemoteTarget, origin: string, via: Via, body: { deviceId: string; nonce: string; proof: string },
): Promise<SignInResult> {
  let a: Answer
  try {
    a = await call(deps, 'POST', `${origin}/api/mobile/session`, { body })
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

/**
 * The sign-in of a record made through the account (plan 18, contract C): prove first, then sign in. At each address
 * the machine must prove itself BEFORE this computer asks for a challenge, and the sign-in then goes to that same
 * address. An address with a wrong proof or none gets no challenge and no sign-in proof, so a box that passes
 * requests on to the machine is never handed a session; the next address is tried (nothing was spent there).
 *
 * The price: a record still waiting for Allow, or removed on the machine, is not vouched for either, so it reads as
 * `unverified` here and this computer no longer hears "pending" or "removed" from the machine itself.
 */
async function provedSignIn(deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials): Promise<ProvedSignInResult> {
  let wrong: { origin: string; via: Via } | null = null
  for (const { via, origin } of addressPlan(target)) {
    const proof = await verifyMachineProof(deps, origin, creds)
    if (proof === 'silent') continue
    if (proof !== 'verified') {
      wrong ??= { origin, via }
      continue
    }
    let proven: Awaited<ReturnType<typeof provenBody>>
    try {
      proven = await provenBody(deps, origin, creds)
    } catch {
      continue // gone quiet since its proof: the next address
    }
    if (proven.ok === false) {
      return { state: 'error', message: commonRefusal(proven.answer) ?? `Sign-in failed (${proven.answer.status}).` }
    }
    return openSession(deps, target, origin, via, proven.body)
  }
  return wrong ? { state: 'unverified', ...wrong } : { state: 'offline', message: unreachableMessage(target) }
}

/**
 * Sign in to a remote. With no rule (or `skip`): challenge → proof → session at the first address that answers, as
 * before plan 18; this is a record paired by link, and the `aasc` client. With `required`: provedSignIn.
 */
export function signIn(deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials): Promise<SignInResult>
export function signIn(
  deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials, proof: ProofRule,
): Promise<ProvedSignInResult>
export async function signIn(
  deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials, proof: ProofRule = 'skip',
): Promise<ProvedSignInResult> {
  if (proof === 'required') return provedSignIn(deps, target, creds)
  // Only the challenge picks the address: once one answers, the session goes to the same one.
  const hit = await firstAnswer(target, (origin) => provenBody(deps, origin, creds))
  if (!hit) return { state: 'offline', message: unreachableMessage(target) }
  const { origin, via } = hit
  if (hit.value.ok === false) {
    return { state: 'error', message: commonRefusal(hit.value.answer) ?? `Sign-in failed (${hit.value.answer.status}).` }
  }
  return openSession(deps, target, origin, via, hit.value.body)
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

/**
 * This computer removes itself from the remote. True only when the remote confirmed it. Never throws. With `required`
 * (a record made through the account) the challenge is answered only at an address where the machine proved itself.
 */
export async function unpair(
  deps: RemoteClientDeps, target: RemoteTarget, creds: RemoteCredentials, proof: ProofRule = 'skip',
): Promise<boolean> {
  const hit = await firstAnswer(target, async (origin) => {
    if (!(await machineProved(deps, origin, creds, proof))) throw new NotAasc() // not the machine, as far as it proved: the next address
    const proven = await provenBody(deps, origin, creds)
    if (!proven.ok) return false
    const a = await call(deps, 'POST', `${origin}/api/mobile/unpair`, { body: proven.body })
    return a.status === 200
  })
  return hit?.value ?? false
}

/** = SessionStatus (src/types/session.ts): a session waiting on the person, for an approval or for an answer. */
export const NEEDS_YOU_STATUSES: ReadonlySet<string> = new Set(['approval', 'input'])

/** What the list of shared sessions comes to: how many there are, and how many of them wait on the person. */
export interface SharedCounts {
  sharedSessions: number
  needsYou: number
}

/**
 * How many sessions the remote shares with this computer, and how many of those wait on the person: GET /api/sessions
 * answers an object keyed by session id, already filtered to what this device may see. A session without a readable
 * `status` is shared but waits on nobody. Only the two counts leave this function: nothing of a session is kept.
 * Null when it doesn't answer as expected. Never throws.
 */
export async function sharedCounts(deps: RemoteClientDeps, origin: string, sessionToken: string): Promise<SharedCounts | null> {
  try {
    const a = await call(deps, 'GET', `${origin}/api/sessions`, { bearer: sessionToken, timeoutMs: SESSIONS_TIMEOUT_MS, maxBytes: SESSIONS_MAX_BYTES })
    if (a.status !== 200 || !a.data || typeof a.data !== 'object') return null
    const sessions: unknown[] = Array.isArray(a.data) ? a.data : Object.values(a.data)
    const needsYou = sessions.filter((session) => {
      const status = field(session, ['status'])
      return typeof status === 'string' && NEEDS_YOU_STATUSES.has(status)
    }).length
    return { sharedSessions: sessions.length, needsYou }
  } catch {
    return null
  }
}

export type RemoteSessionState = 'signed-in' | 'signed-out' | 'no-password' | 'no-answer'

/**
 * Is this session still good? Asks without signing in: a sign-in mints a session, and the remote keeps only the newest
 * few per computer, so asking that way would end the very session being asked about. Anything but a clear answer from
 * AASC is `no-answer`, never `signed-out`. `no-password`: the remote calls everyone authenticated, yet refuses remote
 * requests until it has one, so no session can be good. Never throws.
 */
export async function remoteSessionState(deps: RemoteClientDeps, origin: string, sessionToken: string | null): Promise<RemoteSessionState> {
  try {
    const a = await call(deps, 'GET', `${origin}/api/auth/status`, sessionToken ? { cookie: `auth_token=${sessionToken}` } : {})
    if (a.status !== 200) return 'no-answer'
    if (field(a.data, ['passwordRequired']) === false) return 'no-password'
    const authenticated = field(a.data, ['authenticated'])
    if (authenticated === true) return 'signed-in'
    return authenticated === false ? 'signed-out' : 'no-answer'
  } catch {
    return 'no-answer'
  }
}

/** For accountDirectory.ts, which makes the same kind of call: capped, timed, redirects never followed. */
export { call as requestJson, field as jsonField, aascAnswer, commonRefusal, NotAasc }
export type { Answer as JsonAnswer }
