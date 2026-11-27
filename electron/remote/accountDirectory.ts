/**
 * "One account, all devices" on the client desktop (plan 18, stage 2): list the computers on this computer's AASC
 * Cloud account, and connect to one with a ticket instead of a pairing link.
 *
 * This computer never talks to the backend itself. Its own AASC server holds the account connection, so the main
 * process asks that server on loopback (`/api/resources/cloud/machines`), the way its own page would: a loopback
 * address, its own origin, and the dashboard window's session when this computer has a password.
 *
 * Connecting, in order:
 *   1. read the directory again (an address is never taken from the page) and find the machine;
 *   2. try the machine's addresses in the usual order (home network, Tailscale, public). At each, first a cheap
 *      probe anyone may make (GET /api/auth/status, 3 s): an address where no AASC answers, or one with no dashboard
 *      password, is passed over, and the ticket never goes there;
 *   3. at the first address that passes, make an ephemeral P-256 key pair and ask the local server for a ticket bound
 *      to it (60 s, one use), which comes with a seal secret; then POST <address>/api/mobile/enroll-computer, with
 *      15 s of its own, since the machine asks the backend before it answers. `NOT_THIS_MACHINE`, or a connection
 *      that fails outright, moves on to the next address with the SAME ticket (that box redeemed nothing). Anything
 *      else stops, a request that got no answer in time included: the machine may have spent the ticket, and a
 *      one-use ticket is never sent again;
 *   4. open the sealed answer with the address dialled here (accessSeal.ts). An answer that doesn't open came from
 *      something else, or through a box passing the request on, and nothing is kept.
 * The caller stores the device (remoteStore.ts); from there check / open / remove work as for a computer paired by link.
 *
 * Pure, like remoteClient.ts: fetch and the random source are injected. The ticket, the seal secret, the private key
 * and the device token never go into an error message or a log; only the device token is returned, to be encrypted.
 */
import type { AccountMachine } from '../../src/types/electron.js'
import { newClientKey, openSealedAccess, B64U43, type ClientKey, type SealedAccess } from './accessSeal.js'
import { CLOUD_METADATA_ADDRESS, isPrivateLanAddress, isPublicAddress, isTailnetAddress } from './pairingLinkRules.js'
import {
  aascAnswer, addressPlan, commonRefusal, dialledAddress, jsonField, remoteSessionState, requestJson, unreachableMessage,
  NotAasc, RequestTimedOut, type JsonAnswer, type RemoteClientDeps, type Via,
} from './remoteClient.js'

/** What these calls need: the remote client's, and the enroll's own budget. */
export interface AccountClientDeps extends RemoteClientDeps {
  /** How long the enroll request may take; default ENROLL_TIMEOUT_MS. */
  enrollTimeoutMs?: number
}

/** This computer's own AASC server. */
export interface LocalServer {
  /** The port it listens on. */
  port: number
  /** The calling dashboard window's session: with a dashboard password set, the server wants one even on loopback. */
  sessionToken?: string | null
}

/** A machine as the directory lists it; the caller adds this computer's own record for it. */
export type DirectoryMachine = Omit<AccountMachine, 'record'>

export type DirectoryRead =
  | { state: 'ok'; machines: DirectoryMachine[] }
  /**
   * signed-out: no account connection. needs-sign-in: signed in before this release. unsupported: AASC Cloud answered,
   * but its backend has no machines service yet. unreachable: no usable answer.
   */
  | { state: 'signed-out' | 'needs-sign-in' | 'unsupported' | 'unreachable' }

/** The backend lists at most 50; a longer list is cut, not refused. */
export const MAX_MACHINES = 64
/** The largest directory answer read: 64 entries are a few tens of KB. */
export const DIRECTORY_MAX_BYTES = 256 * 1024
/** The local server asks the backend before it answers, so it gets longer than an address on the home network. */
export const CLOUD_TIMEOUT_MS = 10_000
/** The enroll request waits on the machine's own round trip to the backend (the redeem), so it gets longer than a probe. */
export const ENROLL_TIMEOUT_MS = 15_000

const MACHINE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const HEX64 = /^[0-9a-f]{64}$/
const WORD = /^[a-z0-9][a-z0-9_-]{0,31}$/
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+_-]{0,31}$/
/** A session token as /api/auth/login issues them; nothing that could start a second cookie or header. */
const SESSION_TOKEN = /^[A-Za-z0-9_-]{16,512}$/
const MAX_NAME = 80

function localOrigin(local: LocalServer): string | null {
  return Number.isInteger(local.port) && local.port >= 1 && local.port <= 65535 ? `http://127.0.0.1:${local.port}` : null
}

/** One call to this computer's own server; never anywhere but loopback. Throws like requestJson. */
function askLocal(
  deps: RemoteClientDeps, origin: string, local: LocalServer, method: 'GET' | 'POST', path: string, body?: unknown,
): Promise<JsonAnswer> {
  const token = local.sessionToken
  return requestJson(deps, method, `${origin}${path}`, {
    ...(body === undefined ? {} : { body }),
    ...(typeof token === 'string' && SESSION_TOKEN.test(token) ? { cookie: `auth_token=${token}` } : {}),
    sameOrigin: true,
    timeoutMs: deps.timeoutMs ?? CLOUD_TIMEOUT_MS,
    maxBytes: DIRECTORY_MAX_BYTES,
  })
}

/** The refusal code, wherever the local server puts it (`error.code`, as its cloud routes do, or `code`). */
function refusalCode(a: JsonAnswer): unknown {
  return jsonField(a.data, ['error', 'code']) ?? jsonField(a.data, ['code'])
}

function word(raw: unknown, shape: RegExp): string | null {
  return typeof raw === 'string' && shape.test(raw) ? raw : null
}

/** A name with control and format (bidi, zero-width) characters out, at most 80 characters. */
function cleanName(raw: string): string {
  return raw.slice(0, 1024).replace(/[\x00-\x1F\x7F\p{Cf}]/gu, '').trim().slice(0, MAX_NAME) || 'Computer'
}

/**
 * The addresses a machine publishes, when every one it lists is of its own kind (the rules a pairing link is read by):
 * the main process dials plain HTTP to them, and a record made through the account takes them over. One address of the
 * wrong kind, or a port that is none, and the entry shows no address at all. Null too when it lists none.
 */
function readAddresses(raw: unknown): DirectoryMachine['addresses'] {
  if (!raw || typeof raw !== 'object') return null
  const p = raw as Record<string, unknown>
  if (typeof p.port !== 'number' || !Number.isInteger(p.port) || p.port < 1 || p.port > 65535) return null
  const absent = (v: unknown): boolean => v === null || v === undefined
  const lanOk = typeof p.lan === 'string' && isPrivateLanAddress(p.lan) && p.lan !== CLOUD_METADATA_ADDRESS
  const tailnetOk = typeof p.tailnet === 'string' && isTailnetAddress(p.tailnet)
  const publicOk = typeof p.public === 'string' && isPublicAddress(p.public)
  if ((!absent(p.lan) && !lanOk) || (!absent(p.tailnet) && !tailnetOk) || (!absent(p.public) && !publicOk)) return null
  if (!lanOk && !tailnetOk && !publicOk) return null
  return {
    lan: lanOk ? (p.lan as string) : null,
    tailnet: tailnetOk ? (p.tailnet as string) : null,
    publicAddress: publicOk ? (p.public as string) : null,
    port: p.port,
  }
}

function readMachine(raw: unknown): DirectoryMachine | null {
  if (!raw || typeof raw !== 'object') return null
  const m = raw as Record<string, unknown>
  if (typeof m.deviceId !== 'string' || !MACHINE_ID.test(m.deviceId) || typeof m.name !== 'string') return null
  const lastUsed = typeof m.lastUsedAt === 'string' && m.lastUsedAt.length <= 40 ? Date.parse(m.lastUsedAt) : Number.NaN
  return {
    deviceId: m.deviceId,
    name: cleanName(m.name),
    // Values this version doesn't know still pass, as plain words: the backend adds to them.
    platform: word(m.platform, WORD),
    edition: word(m.edition, WORD),
    appVersion: word(m.appVersion, VERSION),
    lastUsedAt: Number.isFinite(lastUsed) ? lastUsed : null,
    current: m.current === true,
    connectable: m.connectable === true,
    relation: m.relation === 'self' ? 'self' : 'other',
    addresses: readAddresses(m.paths),
  }
}

/** The account's computers, from this computer's own server. Never throws: every outcome is a state the UI can show. */
export async function readAccountDirectory(deps: RemoteClientDeps, local: LocalServer): Promise<DirectoryRead> {
  const origin = localOrigin(local)
  if (!origin) return { state: 'unreachable' }
  let a: JsonAnswer
  try {
    a = await askLocal(deps, origin, local, 'GET', '/api/resources/cloud/machines')
  } catch {
    return { state: 'unreachable' }
  }
  if (refusalCode(a) === 'needs_sign_in') return { state: 'needs-sign-in' }
  if (a.status === 409) return { state: 'signed-out' }
  if (a.status === 404 && refusalCode(a) === 'unsupported') return { state: 'unsupported' }
  const list = jsonField(a.data, ['data', 'machines'])
  if (a.status !== 200 || !Array.isArray(list)) return { state: 'unreachable' }
  const machines = list.slice(0, MAX_MACHINES).map(readMachine).filter((m): m is DirectoryMachine => m !== null)
  return { state: 'ok', machines }
}

/** Where a machine listens, as remoteClient's address plan and the store take it. */
export interface AccountTarget {
  lan: string | null
  tailnet: string | null
  publicAddress: string | null
  port: number
}

export type AccountConnectResult =
  | {
    ok: true
    /** The device the machine made for this computer. `deviceToken` goes to the store's encryption and nowhere else. */
    access: SealedAccess
    /** The address that answered, and its kind. */
    origin: string
    via: Via
    name: string
    target: AccountTarget
  }
  | { ok: false; error: string }

const fail = (error: string): AccountConnectResult => ({ ok: false, error })

const SIGNED_OUT = 'Sign in to AASC Cloud on this computer first.'
const UNSUPPORTED = 'AASC Cloud can’t list your account’s computers yet. Connect by link instead.'
const NEEDS_SIGN_IN = 'Sign in to AASC Cloud again on this computer to connect through your account.'
const CLOUD_SILENT = 'AASC Cloud didn’t answer. Try again.'
const GONE = 'That computer is no longer on your AASC Cloud account.'

type TicketResult = { ok: true; ticket: string; sealSecret: string } | { ok: false; error: string }

/** A ticket for (this computer, the machine, this key) and its seal secret, from the local server. */
async function askTicket(
  deps: RemoteClientDeps, origin: string, local: LocalServer, machineId: string, clientKey: string,
): Promise<TicketResult> {
  let a: JsonAnswer
  try {
    a = await askLocal(deps, origin, local, 'POST', `/api/resources/cloud/machines/${machineId}/ticket`, { clientKey })
  } catch {
    return { ok: false, error: CLOUD_SILENT }
  }
  const code = refusalCode(a)
  if (code === 'needs_sign_in') return { ok: false, error: NEEDS_SIGN_IN }
  if (code === 'machine_not_found') return { ok: false, error: GONE }
  if (code === 'rate_limited' || a.status === 429) return { ok: false, error: 'Too many tries. Wait a minute, then try again.' }
  if (a.status === 409) return { ok: false, error: SIGNED_OUT }
  const ticket = jsonField(a.data, ['data', 'ticket'])
  const sealSecret = jsonField(a.data, ['data', 'sealSecret'])
  if ((a.status !== 200 && a.status !== 201) || typeof ticket !== 'string' || !B64U43.test(ticket)
    || typeof sealSecret !== 'string' || !B64U43.test(sealSecret)) {
    return { ok: false, error: CLOUD_SILENT }
  }
  return { ok: true, ticket, sealSecret }
}

/** What a machine's refusal means, as a sentence. Every one of these ends the attempt. */
function refusalMessage(name: string, a: JsonAnswer): string {
  switch (jsonField(a.data, ['code'])) {
    case 'INVALID_TICKET':
      return `${name} refused the sign-in. Try again.`
    case 'CLIENT_REVOKED':
      // Removed on that machine, or this computer's own account sign-in was revoked: a new sign-in is a new device.
      return `${name} removed this computer. Sign in to AASC Cloud again on this computer, then connect, or pair with a link.`
    case 'ACCOUNT_ENROLL_OFF':
      // Device pairing is off there, or "Show this computer to my account" is: the machine answers both with this code.
      return `${name} isn’t accepting connections through your account. On that computer, turn on device pairing and “Show this computer to my account”.`
    case 'BUSY':
      return `${name} has too many computers waiting to connect. Try again in a couple of minutes.`
    case 'ENROLL_BUSY':
      return `${name} is busy connecting another device. Try again in a few seconds.`
    case 'CLOUD_UNAVAILABLE':
      return `${name} couldn’t reach AASC Cloud. Try again in a moment.`
    default:
  }
  if (a.status >= 300 && a.status < 400) return `${name}’s address answered with a redirect, which isn’t AASC.`
  const common = commonRefusal(a)
  if (common) return common
  // An AASC from before plan 18 has no such route, or calls the body invalid.
  if (a.status === 404 || a.status === 400) return `Update AASC on ${name} to connect through your account, or pair with a link.`
  return `Connecting to ${name} failed (${a.status}).`
}

/**
 * Connect this computer to one of the account's machines. `machineId` comes from the page, so it is checked here; the
 * machine's name and addresses come from the directory: `read` when the caller has just read it, else read here.
 * Never throws.
 */
export async function connectThroughAccount(
  deps: AccountClientDeps, local: LocalServer, machineId: string, read?: DirectoryRead,
): Promise<AccountConnectResult> {
  if (typeof machineId !== 'string' || !MACHINE_ID.test(machineId)) return fail(GONE)
  const localAt = localOrigin(local)
  if (!localAt) return fail('AASC is still starting on this computer. Try again in a moment.')

  const directory = read ?? await readAccountDirectory(deps, local)
  if (directory.state === 'signed-out') return fail(SIGNED_OUT)
  if (directory.state === 'needs-sign-in') return fail(NEEDS_SIGN_IN)
  if (directory.state === 'unsupported') return fail(UNSUPPORTED)
  if (directory.state !== 'ok') return fail('Can’t reach AASC Cloud. Try again.')
  const machine = directory.machines.find((m) => m.deviceId === machineId)
  if (!machine) return fail(GONE)
  const { name } = machine
  if (machine.current) return fail('That is this computer.')
  if (!machine.connectable) return fail(`Sign in to AASC Cloud again on ${name}, then connect.`)
  const target: AccountTarget | null = machine.addresses
  const plan = target ? addressPlan(target) : []
  if (!target || plan.length === 0) {
    // The account only knows there is no address, not why (Nov 27 2026): a missing dashboard password is the
    // common cause (the computer publishes nothing without one), so name it beside the setting.
    return fail(`${name} isn’t sharing an address with your account. On ${name}, set a dashboard password and turn on “Show this computer to my account”, or pair with a link.`)
  }

  // One nonce per address, all made before anything is sent: a random source that fails spends no ticket.
  const nonces = plan.map(() => deps.randomHex(32))
  if (!nonces.every((n) => typeof n === 'string' && HEX64.test(n))) return fail('This computer couldn’t start the connection. Try again.')

  let session: { key: ClientKey; ticket: string; sealSecret: string } | null = null
  let noPassword = false
  for (const [i, { via, origin }] of plan.entries()) {
    // The probe: the question anyone may ask, so a dead address costs 3 s and never sees the ticket.
    const there = await remoteSessionState(deps, origin, null)
    if (there === 'no-answer') continue
    if (there === 'no-password') {
      noPassword = true // it would only refuse: an AASC without a password takes no remote device
      continue
    }
    if (!session) {
      const key = newClientKey()
      const ticket = await askTicket(deps, localAt, local, machineId, key.clientKey)
      if (ticket.ok === false) return fail(ticket.error === GONE ? `${name} is no longer on your AASC Cloud account.` : ticket.error)
      session = { key, ticket: ticket.ticket, sealSecret: ticket.sealSecret }
    }
    const nonce = nonces[i]
    let a: JsonAnswer
    try {
      a = aascAnswer(await requestJson(deps, 'POST', `${origin}/api/mobile/enroll-computer`, {
        body: { machineId, ticket: session.ticket, clientKey: session.key.clientKey, nonce },
        timeoutMs: deps.enrollTimeoutMs ?? ENROLL_TIMEOUT_MS,
      }))
    } catch (err) {
      // It answered the probe, took the request, and then nothing usable came back in time: the machine may have
      // redeemed the ticket, so it goes nowhere else.
      if (err instanceof RequestTimedOut || err instanceof NotAasc) return fail(`Couldn’t finish connecting to ${name}. Try again.`)
      continue // the connection failed outright: the same ticket is still good for the next address
    }
    // Another AASC holds that address. It redeemed nothing, so the same ticket goes to the next one.
    if (a.status === 409 && jsonField(a.data, ['code']) === 'NOT_THIS_MACHINE') continue
    if (a.status !== 201) return fail(refusalMessage(name, a))
    const bound = dialledAddress(origin)
    const access = bound ? openSealedAccess(session.key, jsonField(a.data, ['data']), nonce, bound, session.sealSecret) : null
    // Sealed for another address (a box passing the request on) or without the ticket's secret (a box of its own).
    if (!access) return fail(`Something else answered at ${name}’s address. Nothing was saved.`)
    return { ok: true, access, origin, via, name, target }
  }
  if (noPassword) return fail(`The AASC at ${name}’s address has no dashboard password, so it accepts no remote devices. Set one there first.`)
  return fail(`Can’t reach ${name}. ${unreachableMessage(target)}`)
}
