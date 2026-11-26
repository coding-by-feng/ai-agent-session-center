/**
 * IPC for Remote computers (Oct 28 2026): pair this app with another computer's AASC
 * the way the phone does, check on it, and open its own UI in a window. Plan 18 adds the
 * computers on this computer's AASC Cloud account: list them, and connect to one with no link.
 *
 * Every argument comes from the renderer, so each is checked by hand here before it
 * reaches the store or the network. Every answer is `{ ok, data } | { ok: false, error }`
 * with a plain sentence: never a stack, a device token or a session token.
 */
import { app, ipcMain, safeStorage, shell, type IpcMainInvokeEvent, type Session } from 'electron'
import { randomBytes, randomUUID } from 'crypto'
import { stat } from 'fs/promises'
import os from 'os'
import path from 'path'
import type { AccountDirectory, RemoteComputer, RemoteComputerCheck, RemoteResult } from '../../src/types/electron.js'
import type { TransferStartArgs, TransferStartResult } from '../../src/types/projectTransfer.js'
import { createTransferClient, discardRemote, TransferFailed, type TransferDeps } from '../remote/projectTransfer.js'
import {
  connectThroughAccount, readAccountDirectory, type AccountTarget, type DirectoryMachine, type LocalServer,
} from '../remote/accountDirectory.js'
import { readRemotePairingLink } from '../remote/pairingLinkRules.js'
import {
  addressPlan, fetchPaths, machineProved, pair, remoteSessionState, sharedCounts, signIn, unpair, unreachableMessage,
  type FetchLike, type ProofRule, type ProvedSignInResult, type RemoteClientDeps, type RemoteCredentials, type RemoteTarget,
  type SharedCounts, type Via,
} from '../remote/remoteClient.js'
import { createRemoteStore, BACKEND_DEVICE_ID, NO_KEYCHAIN, REMOTE_ID, type RemoteStore } from '../remote/remoteStore.js'
import {
  closeRemoteWindows, focusRemoteWindow, forgetRemoteWindow, isLocalAppSenderUrl, openRemoteOrigin, openRemoteWindow,
  remoteSessionToken, signBackIn,
} from '../remote/remoteWindow.js'
import { logMainError } from '../crashLogger.js'

const MAX_LINK = 2048
const MAX_NAME = 80
const SOMETHING_WENT_WRONG = 'Something went wrong talking to that computer. Try again.'
const NOT_PAIRED = 'That computer isn’t paired here any more.'
const NOT_THIS_APP = 'Only this app’s own window can manage remote computers.'
const NOT_IN_THIS_EDITION = 'Connecting through an AASC Cloud account isn’t available in this edition.'
const NOT_ON_ACCOUNT = 'That computer isn’t on your AASC Cloud account.'

/**
 * What a Client edition (clientMain.ts) changes. Nothing is passed in Full and Lite, so they keep the local dashboard
 * rule and show the remote's own UI.
 */
export interface RemoteHandlerOptions {
  /**
   * Who may call these channels. The default is the local dashboard, which a Client doesn't have. Passing one also
   * says this app has no AASC server of its own, so the account channels (plan 18: `remote:accountMachines`,
   * `remote:accountConnect`), which ask that server, answer that they aren't in this edition.
   */
  isAppSender?: (url: string) => boolean
  /** Runs on the remote's session before its window's first request. */
  beforeLoad?: (ses: Session, origin: string) => void | Promise<void>
  /** A remote's window opened, or an open one was focused. */
  onOpened?: (id: string) => void
  /**
   * A Client's dashboard is the whole app, so a dead session must not wait for anyone: keepOpenWindowsSignedIn revives
   * one unasked, and `check` leaves that to it. In Full and Lite it can be a log-out the person chose, so only pressing
   * Open revives it.
   */
  keepSignedIn?: boolean
}

let store: RemoteStore | null = null
let handlerOptions: RemoteHandlerOptions = {}

function remoteStore(): RemoteStore {
  if (!store) {
    store = createRemoteStore({
      file: path.join(app.getPath('userData'), 'remote-computers.json'),
      // Linux's 'basic_text' backend is plain obfuscation, so it counts as no keychain (as in main.ts).
      crypto: {
        isAvailable: () => safeStorage.isEncryptionAvailable()
          && (process.platform !== 'linux' || safeStorage.getSelectedStorageBackend() !== 'basic_text'),
        encrypt: (value) => safeStorage.encryptString(value),
        decrypt: (value) => safeStorage.decryptString(value),
      },
    })
  }
  return store
}

const clientDeps: RemoteClientDeps = {
  fetch: ((url, init) => fetch(url, init)) as FetchLike,
  randomHex: (n) => randomBytes(n).toString('hex'),
}

/** This computer's name on the remote's devices list: its hostname without `.local`. */
function thisComputerLabel(): string {
  return os.hostname().replace(/\.local$/i, '').replace(/[\x00-\x1F\x7F\p{Cf}]/gu, '').trim().slice(0, MAX_NAME) || 'Computer'
}

function validId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && REMOTE_ID.test(id)
}

/** A display name: control characters out, trimmed, 1–80 characters; null when invalid. */
function cleanName(name: unknown): string | null {
  if (typeof name !== 'string' || name.length > 1024) return null
  const cleaned = name.replace(/[\x00-\x1F\x7F\p{Cf}]/gu, '').trim()
  return cleaned.length >= 1 && cleaned.length <= MAX_NAME ? cleaned : null
}

function targetOf(r: RemoteComputer): RemoteTarget {
  return { httpsOrigin: r.httpsOrigin, lan: r.lan, tailnet: r.tailnet, publicAddress: r.publicAddress ?? null, port: r.port }
}

function fail<T>(error: string): RemoteResult<T> {
  return { ok: false, error }
}

/** Run a handler; anything thrown becomes a plain sentence, with only its message logged. */
async function guarded<T>(what: string, fn: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  try {
    return await fn()
  } catch (err) {
    logMainError(`remote:${what} failed: ${err instanceof Error ? err.message : String(err)}`)
    return fail(SOMETHING_WENT_WRONG)
  }
}

/** Record what a sign-in learned about the pairing's state. */
function recordSignIn(id: string, result: ProvedSignInResult, now: number): void {
  const s = remoteStore()
  if (result.state === 'ok') s.update(id, { status: 'active', confirmCode: null, lastSeenAt: now })
  else if (result.state === 'pending') s.update(id, { status: 'pending' })
  else if (result.state === 'revoked') s.update(id, { status: 'revoked', confirmCode: null })
}

function pendingMessage(r: RemoteComputer): string {
  const code = r.confirmCode ? ` Check the code there is ${r.confirmCode}.` : ''
  return `Waiting for Allow on ${r.name}.${code}`
}

function revokedMessage(r: RemoteComputer): string {
  return `${r.name} removed this computer. Remove it here and pair again.`
}

/** Something answered, but nothing proved it is that computer at the address dialled (plan 18). */
function impostorMessage(r: RemoteComputer): string {
  return `Something else answered at ${r.name}’s address.`
}

/**
 * What to say when nothing proved itself for a record made through the account. While this computer still waits for
 * Allow the machine vouches for nothing yet, which is all an unproved answer means: the row keeps saying it waits.
 * Otherwise it is the sentence above, which is also all this computer learns once the machine's owner removed it:
 * it sends no sign-in to find out which.
 */
function unprovedMessage(r: RemoteComputer): string {
  return r.status === 'pending' ? pendingMessage(r) : impostorMessage(r)
}

/**
 * What a record asks of the machine's proof: for one made through the account the machine proves itself at an address
 * before this computer answers a challenge there; one paired by link asks for none, exactly as before plan 18.
 */
function proofRule(r: RemoteComputer): ProofRule {
  return r.origin === 'account' ? 'required' : 'skip'
}

async function add(link: unknown): Promise<RemoteResult<RemoteComputer>> {
  if (typeof link !== 'string' || link.length > MAX_LINK) return fail('That isn’t an AASC pairing link.')
  const read = readRemotePairingLink(link)
  if (read.ok === false) return fail(read.error)
  const s = remoteStore()
  // Checked before pairing, so the remote isn't left with a device this computer can't keep.
  if (!s.canStore()) return fail('This computer can’t store the pairing key safely (no system keychain).')
  const paired = await pair(clientDeps, read.link, thisComputerLabel())
  if (paired.ok === false) return fail(paired.error)
  return s.add({
    name: read.link.name,
    lan: read.link.lan,
    tailnet: read.link.tailnet,
    ...(read.link.httpsOrigin ? { httpsOrigin: read.link.httpsOrigin } : {}),
    ...(read.link.publicAddress ? { publicAddress: read.link.publicAddress } : {}),
    port: read.link.port,
    status: paired.approved ? 'active' : 'pending',
    confirmCode: paired.approved ? null : paired.confirmCode,
    addedAt: Date.now(),
    lastSeenAt: null,
    deviceId: paired.deviceId,
  }, paired.deviceToken)
}

/** No list of shared sessions was read: neither count is known. */
const NO_COUNTS = { sharedSessions: null, needsYou: null } as const

/** The two counts of a check answer: how many sessions the remote shares, and how many of them wait on the person. */
function countsOf(counts: SharedCounts | null): Pick<RemoteComputerCheck, 'sharedSessions' | 'needsYou'> {
  return counts ? { sharedSessions: counts.sharedSessions, needsYou: counts.needsYou } : NO_COUNTS
}

/**
 * Check on a computer whose window is open, with that window's own session. A sign-in mints a session and the remote
 * keeps only the newest four per computer, so the list's 30-second check would end the dashboard's session within two
 * minutes. Asking mints nothing, so the computer's other addresses get asked too when the window's goes quiet: it may
 * only have left the home network.
 *
 * Null when a sign-in is the only way to learn more, and costs the window nothing: its session has died and nothing here
 * will revive it (this is how the row learns the remote removed this computer), or the remote has no password.
 */
async function checkOpenWindow(
  r: RemoteComputer, windowOrigin: string, creds: RemoteCredentials,
): Promise<RemoteResult<RemoteComputerCheck> | null> {
  const target = targetOf(r)
  const token = await remoteSessionToken(r.id, windowOrigin)
  // new URL drops :80, so an address is compared by what it parses to, not how the plan spells it.
  const plan = addressPlan(target).map(({ via, origin }) => ({ via, origin: new URL(origin).origin }))
  const origins = [windowOrigin, ...plan.map((address) => address.origin).filter((origin) => origin !== windowOrigin)]
  for (const origin of origins) {
    // The window already talks to its own address. Any other one gets its session only once the machine proved itself there.
    if (origin !== windowOrigin && !(await machineProved(clientDeps, origin, creds, proofRule(r)))) continue
    const state = await remoteSessionState(clientDeps, origin, token)
    if (state === 'no-answer') continue
    if (state === 'no-password' || (state === 'signed-out' && !handlerOptions.keepSignedIn)) return null
    const via = plan.find((address) => address.origin === origin)?.via ?? null
    const counts = state === 'signed-in' && token ? await sharedCounts(clientDeps, origin, token) : null
    return { ok: true, data: { state: 'online', via, ...countsOf(counts), message: null } }
  }
  return { ok: true, data: { state: 'offline', via: null, ...NO_COUNTS, message: unreachableMessage(target) } }
}

/** Sign an open dashboard back in if its session has died: a long sleep, or the remote restarting (tokens are in memory). */
async function revive(id: string): Promise<void> {
  const origin = openRemoteOrigin(id)
  if (!origin) return
  if (await remoteSessionState(clientDeps, origin, await remoteSessionToken(id, origin)) !== 'signed-out') return
  const s = remoteStore()
  const r = s.get(id)
  const creds = s.credentials(id)
  if (!r || !creds) return
  const rule = proofRule(r)
  const result = await signIn(clientDeps, targetOf(r), creds, rule)
  recordSignIn(id, result, Date.now())
  // Closing brings the list back, whose row says what happened.
  if (result.state === 'revoked') closeRemoteWindows(id)
  if (result.state !== 'ok') return
  // On the window's own address: its session is good at any of them, and this one just answered. When the sign-in
  // went to another address, the window's own has proved nothing yet, and the new session is not handed to it unproved.
  if (new URL(result.origin).origin !== origin && !(await machineProved(clientDeps, origin, creds, rule))) return
  await signBackIn(id, origin, result.token, result.expiresIn)
}

/** One round of `revive` over every computer. Never throws, so a timer can keep calling it. */
export async function keepOpenWindowsSignedIn(): Promise<void> {
  for (const r of remoteStore().list()) {
    await guarded('revive', async () => {
      await revive(r.id)
      return { ok: true, data: null }
    })
  }
}

async function check(id: unknown): Promise<RemoteResult<RemoteComputerCheck>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  const s = remoteStore()
  const r = s.get(id)
  const creds = s.credentials(id)
  if (!r || !creds) return fail(NOT_PAIRED)
  const openAt = openRemoteOrigin(id)
  const answered = openAt ? await checkOpenWindow(r, openAt, creds) : null
  if (answered) return answered
  const result = await signIn(clientDeps, targetOf(r), creds, proofRule(r))
  recordSignIn(id, result, Date.now())
  switch (result.state) {
    case 'ok': {
      // A Tailscale address counts only with the remote's proof; a missing one keeps the old.
      const paths = await fetchPaths(clientDeps, result.origin, result.token, creds)
      if (paths?.tailnet && paths.tailnet !== r.tailnet) s.update(id, { tailnet: paths.tailnet })
      const counts = await sharedCounts(clientDeps, result.origin, result.token)
      return { ok: true, data: { state: 'online', via: result.via, ...countsOf(counts), message: null } }
    }
    case 'pending':
      return { ok: true, data: { state: 'pending', via: result.via, ...NO_COUNTS, message: pendingMessage(r) } }
    case 'revoked':
      return { ok: true, data: { state: 'revoked', via: result.via, ...NO_COUNTS, message: revokedMessage(r) } }
    case 'unverified':
      // Nothing proved itself, so nothing was signed in to. A record still waiting for Allow just keeps waiting. An
      // allowed one says `unproved`: its machine did not prove itself, and Connect enrolls again (accountConnect).
      return {
        ok: true,
        data: r.status === 'active'
          ? { state: 'offline', via: null, ...NO_COUNTS, message: impostorMessage(r), unproved: true }
          : { state: r.status === 'pending' ? 'pending' : 'offline', via: null, ...NO_COUNTS, message: unprovedMessage(r) },
      }
    case 'offline':
      return { ok: true, data: { state: 'offline', via: null, ...NO_COUNTS, message: result.message } }
    case 'error':
      return fail(result.message)
  }
}

async function open(id: unknown): Promise<RemoteResult<null>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  if (focusRemoteWindow(id)) {
    await revive(id)
    handlerOptions.onOpened?.(id)
    return { ok: true, data: null }
  }
  const s = remoteStore()
  const r = s.get(id)
  const creds = s.credentials(id)
  if (!r || !creds) return fail(NOT_PAIRED)
  const result = await signIn(clientDeps, targetOf(r), creds, proofRule(r))
  recordSignIn(id, result, Date.now())
  switch (result.state) {
    case 'ok':
      await openRemoteWindow({
        id,
        name: r.name,
        origin: result.origin,
        token: result.token,
        expiresIn: result.expiresIn,
        beforeLoad: handlerOptions.beforeLoad,
      })
      handlerOptions.onOpened?.(id)
      return { ok: true, data: null }
    case 'pending':
      return fail(pendingMessage(r))
    case 'revoked':
      return fail(revokedMessage(r))
    case 'unverified':
      return fail(unprovedMessage(r))
    case 'offline':
      return fail(result.message || unreachableMessage(targetOf(r)))
    case 'error':
      return fail(result.message)
  }
}

const opening = new Map<string, Promise<RemoteResult<null>>>()

/** A second ask while one is under way joins it: both would pass the focus check and open two windows. */
function openOnce(id: unknown): Promise<RemoteResult<null>> {
  if (!validId(id)) return Promise.resolve(fail(NOT_PAIRED))
  const running = opening.get(id)
  if (running) return running
  const run = open(id).finally(() => opening.delete(id))
  opening.set(id, run)
  return run
}

async function remove(id: unknown): Promise<RemoteResult<{ unpairedRemotely: boolean }>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  const s = remoteStore()
  const r = s.get(id)
  if (!r) return fail(NOT_PAIRED)
  const creds = s.credentials(id)
  // Tell the remote when it answers (and, for a record made through the account, proves itself); forget it here either way.
  const unpairedRemotely = creds ? await unpair(clientDeps, targetOf(r), creds, proofRule(r)) : false
  await forgetRemoteWindow(id)
  s.remove(id)
  return { ok: true, data: { unpairedRemotely } }
}

async function rename(id: unknown, name: unknown): Promise<RemoteResult<RemoteComputer>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  const cleaned = cleanName(name)
  if (!cleaned) return fail(`A name is 1 to ${MAX_NAME} characters.`)
  const updated = remoteStore().update(id, { name: cleaned })
  return updated ? { ok: true, data: updated } : fail(NOT_PAIRED)
}

/**
 * This computer's own AASC server, which holds its AASC Cloud connection (plan 18): the port main started it on, and
 * the session of the dashboard window that asked. With a dashboard password set the server wants a session even on
 * loopback, and the page that called this channel already holds one; it goes to 127.0.0.1 and nowhere else.
 */
async function localServer(e: IpcMainInvokeEvent): Promise<LocalServer> {
  const port = Number(process.env.SERVER_PORT || Number.NaN)
  let sessionToken: string | null = null
  try {
    const url = `${new URL(e.senderFrame?.url ?? '').origin}/`
    const [cookie] = await e.sender.session.cookies.get({ url, name: 'auth_token' })
    sessionToken = cookie?.value ?? null
  } catch {
    sessionToken = null // no password, or a window on its way out: the server says so if it wanted one
  }
  return { port, sessionToken }
}

/**
 * Give every record made through the account the addresses the directory now lists for its machine. Such a record
 * trusts no address until the machine proves itself there, so a changed hint costs nothing; a record paired by link is
 * never touched (the store refuses it too). A machine that lists no usable address keeps the record's own.
 */
function followDirectory(machines: DirectoryMachine[]): void {
  const s = remoteStore()
  for (const r of s.list()) {
    if (r.origin !== 'account') continue
    const listed = machines.find((m) => m.deviceId === r.backendDeviceId)
    if (listed?.addresses) s.refreshAddresses(r.id, listed.addresses)
  }
}

/** The account's computers, each with this computer's record for it when it connected through the account. */
async function accountMachines(e: IpcMainInvokeEvent): Promise<RemoteResult<AccountDirectory>> {
  const read = await readAccountDirectory(clientDeps, await localServer(e))
  if (read.state !== 'ok') return { ok: true, data: { state: read.state, machines: [] } }
  followDirectory(read.machines)
  const records = remoteStore().list().filter((r) => r.origin === 'account')
  const machines = read.machines.map((m) => ({ ...m, record: records.find((r) => r.backendDeviceId === m.deviceId) ?? null }))
  return { ok: true, data: { state: 'ok', machines } }
}

function validMachineId(id: unknown): id is string {
  return typeof id === 'string' && id.length <= 64 && BACKEND_DEVICE_ID.test(id)
}

/** The one address that just answered the enroll: its sealed answer proved the machine is there. */
function targetAt(target: AccountTarget, via: Via): RemoteTarget {
  return {
    lan: via === 'lan' ? target.lan : null,
    tailnet: via === 'tailnet' ? target.tailnet : null,
    publicAddress: via === 'public' ? target.publicAddress : null,
    port: target.port,
  }
}

async function accountConnect(e: IpcMainInvokeEvent, machineId: string): Promise<RemoteResult<RemoteComputer>> {
  const s = remoteStore()
  // Checked before a ticket is asked for, so the machine isn't left with a device this computer can't keep.
  if (!s.canStore()) return fail(NO_KEYCHAIN)
  const server = await localServer(e)
  const directory = await readAccountDirectory(clientDeps, server)
  if (directory.state === 'ok') followDirectory(directory.machines)
  // A record the machine accepts, or one still waiting for its Allow, is never traded for a new one: enrolling again
  // would swap a working key for a pending one. It is checked the usual way and answered as it stands. One case starts
  // over: an allowed record for which nothing proves itself any more, where something does answer. The machine's
  // owner removed this computer, or a box sits in the machine's place; this computer can't tell which, and needn't.
  // Only the machine can redeem a ticket, and its answer opens only for the address dialled, so a box gains nothing
  // and the old record stays; and if it was a removal, this is how the row comes back.
  const existing = s.list().find((r) => r.origin === 'account' && r.backendDeviceId === machineId)
  if (existing && existing.status !== 'revoked') {
    const answer = await check(existing.id)
    const unproved = answer.ok && answer.data.unproved === true
    if (!(existing.status === 'active' && unproved)) {
      const now = s.get(existing.id)
      if (!now) return fail(NOT_PAIRED)
      if (existing.status === 'pending') return { ok: true, data: now } // waiting for Allow, or just allowed
      if (answer.ok === false) return fail(answer.error)
      // Nothing answered anywhere: no ticket is spent on a machine that can't be reached.
      if (answer.data.state === 'offline') return fail(answer.data.message ?? unreachableMessage(targetOf(now)))
      return { ok: true, data: now }
    }
  }
  const out = await connectThroughAccount(clientDeps, server, machineId, directory)
  if (out.ok === false) return fail(out.error)
  const creds = { deviceId: out.access.deviceId, deviceToken: out.access.deviceToken }
  const record = {
    name: out.name,
    lan: out.target.lan,
    tailnet: out.target.tailnet,
    ...(out.target.publicAddress ? { publicAddress: out.target.publicAddress } : {}),
    port: out.target.port,
    status: out.access.status,
    confirmCode: out.access.confirmCode,
    addedAt: Date.now(),
    lastSeenAt: null,
    deviceId: out.access.deviceId,
    origin: 'account' as const,
    backendDeviceId: machineId,
  }
  // If the key can't be kept after all, the machine holds a device for nothing: this computer takes itself off again,
  // at the address whose sealed answer just proved the machine is there (a waiting record has no other proof yet).
  const proven = targetAt(out.target, out.via)
  let saved: ReturnType<RemoteStore['add']>
  try {
    saved = s.add(record, out.access.deviceToken)
  } catch (err) {
    await unpair(clientDeps, proven, creds)
    throw err
  }
  if (saved.ok === false) {
    await unpair(clientDeps, proven, creds)
    return fail(saved.error)
  }
  // Allowed at once ("connect without asking"): the machine keeps such a record only once it has signed in.
  if (out.access.status === 'active') {
    recordSignIn(saved.data.id, await signIn(clientDeps, targetOf(saved.data), creds, 'required'), Date.now())
  }
  return { ok: true, data: s.get(saved.data.id) ?? saved.data }
}

const connecting = new Map<string, Promise<RemoteResult<RemoteComputer>>>()

/** A second ask for a machine while one is under way joins it: two tickets would make two devices there. */
function accountConnectOnce(e: IpcMainInvokeEvent, machineId: unknown): Promise<RemoteResult<RemoteComputer>> {
  if (!validMachineId(machineId)) return Promise.resolve(fail(NOT_ON_ACCOUNT))
  const running = connecting.get(machineId)
  if (running) return running
  const run = guarded('accountConnect', () => accountConnect(e, machineId)).finally(() => connecting.delete(machineId))
  connecting.set(machineId, run)
  return run
}

/** Only this app's own page may drive remote computers: the local dashboard, unless a Client says otherwise. */
function fromLocalApp(e: IpcMainInvokeEvent): boolean {
  return (handlerOptions.isAppSender ?? isLocalAppSenderUrl)(e.senderFrame?.url ?? '')
}

/**
 * The account channels ask this computer's own server. A Client has none (it is the edition whose page isn't a local
 * dashboard, so it passes its own sender rule), and answers that they aren't there.
 */
function withLocalServer<T>(e: IpcMainInvokeEvent, run: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  return local(e, () => (handlerOptions.isAppSender ? Promise.resolve(fail<T>(NOT_IN_THIS_EDITION)) : run()))
}

function local<T>(e: IpcMainInvokeEvent, run: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  return fromLocalApp(e) ? run() : Promise.resolve(fail(NOT_THIS_APP))
}

// ---- Copy / Move a project to a paired computer (docs/plans/project-transfer.md) ----

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const NOT_SECURE = (name: string): string =>
  `Projects are sent only over Tailscale or HTTPS, and ${name} has no Tailscale address here. Turn Tailscale on on both computers, then try again.`

/** Running transfers, and which computer each one (running or failed) went to, for Cancel and Discard. */
const runningTransfers = new Map<string, AbortController>()
const transferTargets = new Map<string, string>()

const transferDeps: TransferDeps = {
  fetch: (url, init) => fetch(url, init as RequestInit),
  trash: (p) => shell.trashItem(p),
  exists: (p) => stat(p).then(() => true, () => false),
  sleep: (ms, signal) => new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new TransferFailed('Stopped.', 'cancelled', true)) }, { once: true })
  }),
  now: () => Date.now(),
}

/** Signed in to the computer over Tailscale or HTTPS only: never its home-network or public HTTP address. */
async function secureSession(remoteId: string): Promise<{ origin: string; token: string; name: string } | { error: string }> {
  const s = remoteStore()
  const r = s.get(remoteId)
  const creds = s.credentials(remoteId)
  if (!r || !creds || r.status === 'revoked') return { error: NOT_PAIRED }
  const secure: RemoteTarget = { ...targetOf(r), lan: null, publicAddress: null }
  if (addressPlan(secure).length === 0) return { error: NOT_SECURE(r.name) }
  const result = await signIn(clientDeps, secure, creds, proofRule(r))
  recordSignIn(remoteId, result, Date.now())
  switch (result.state) {
    case 'ok':
      return result.via === 'tailnet' || result.via === 'https'
        ? { origin: result.origin, token: result.token, name: r.name }
        : { error: NOT_SECURE(r.name) }
    case 'pending': return { error: pendingMessage(r) }
    case 'revoked': return { error: revokedMessage(r) }
    case 'unverified': return { error: impostorMessage(r) }
    case 'offline': return { error: result.message }
    case 'error': return { error: result.message }
  }
}

function validTransferArgs(raw: unknown): TransferStartArgs | null {
  if (!raw || typeof raw !== 'object') return null
  const a = raw as Record<string, unknown>
  if (!validId(a.remoteId) || typeof a.planId !== 'string' || !UUID_RE.test(a.planId)) return null
  if (typeof a.destination !== 'string' || !a.destination.startsWith('~/') || a.destination.length > 4096 || a.destination.includes('\0')) return null
  if (a.mode !== 'copy' && a.mode !== 'move') return null
  if (a.transferId !== undefined && (typeof a.transferId !== 'string' || !UUID_RE.test(a.transferId))) return null
  return { remoteId: a.remoteId, planId: a.planId, destination: a.destination, mode: a.mode, transferId: a.transferId as string | undefined }
}

async function projectTransferStart(e: IpcMainInvokeEvent, raw: unknown): Promise<TransferStartResult> {
  const args = validTransferArgs(raw)
  if (!args) return { ok: false, error: 'That transfer is missing something. Close the dialog and try again.' }
  const transferId = args.transferId ?? randomUUID()
  if (runningTransfers.has(transferId)) return { ok: false, error: 'That transfer is already running.' }
  const failure = (error: string, code: string, resumable: boolean): TransferStartResult =>
    ({ ok: false, error, failure: { transferId, error, code, resumable } })
  const controller = new AbortController()
  runningTransfers.set(transferId, controller)
  transferTargets.set(transferId, args.remoteId)
  try {
    const remote = await secureSession(args.remoteId)
    if ('error' in remote) return failure(remote.error, 'sign_in', true)
    const { port, sessionToken } = await localServer(e)
    if (!Number.isInteger(port) || port < 1 || port > 65535) return failure('This computer’s AASC server isn’t running.', 'local', false)
    const client = createTransferClient(transferDeps, {
      transferId,
      local: { origin: `http://127.0.0.1:${port}`, sessionToken },
      remote,
      planId: args.planId,
      destination: args.destination,
      mode: args.mode,
      signal: controller.signal,
      onProgress: (progress) => { if (!e.sender.isDestroyed()) e.sender.send('remote:projectTransferProgress', progress) },
    })
    const outcome = await client.runAll()
    transferTargets.delete(transferId)
    return { ok: true, data: outcome }
  } catch (err) {
    if (err instanceof TransferFailed) return failure(err.message, err.code, err.resumable)
    logMainError(`remote:projectTransferStart failed: ${err instanceof Error ? err.message : String(err)}`)
    return failure(SOMETHING_WENT_WRONG, 'internal', true)
  } finally {
    runningTransfers.delete(transferId)
  }
}

async function projectTransferCancel(transferId: unknown, discard: unknown): Promise<RemoteResult<null>> {
  if (typeof transferId !== 'string' || !UUID_RE.test(transferId)) return fail('No such transfer.')
  runningTransfers.get(transferId)?.abort()
  if (discard !== true) return { ok: true, data: null }
  const remoteId = transferTargets.get(transferId)
  if (!remoteId) return { ok: true, data: null }
  const remote = await secureSession(remoteId)
  if ('error' in remote) return fail(remote.error)
  if (!(await discardRemote(transferDeps, remote, transferId))) return fail(`${remote.name} did not answer. What it received stays there until you try again.`)
  transferTargets.delete(transferId)
  return { ok: true, data: null }
}

export function registerRemoteHandlers(options: RemoteHandlerOptions = {}): void {
  handlerOptions = options
  ipcMain.handle('remote:list', (e) => {
    if (!fromLocalApp(e)) return []
    try {
      return remoteStore().list()
    } catch (err) {
      logMainError(`remote:list failed: ${err instanceof Error ? err.message : String(err)}`)
      return []
    }
  })
  ipcMain.handle('remote:add', (e, link: unknown) => local(e, () => guarded('add', () => add(link))))
  ipcMain.handle('remote:check', (e, id: unknown) => local(e, () => guarded('check', () => check(id))))
  ipcMain.handle('remote:open', (e, id: unknown) => local(e, () => guarded('open', () => openOnce(id))))
  ipcMain.handle('remote:remove', (e, id: unknown) => local(e, () => guarded('remove', () => remove(id))))
  ipcMain.handle('remote:rename', (e, id: unknown, name: unknown) => local(e, () => guarded('rename', () => rename(id, name))))
  ipcMain.handle('remote:accountMachines', (e) => withLocalServer(e, () => guarded('accountMachines', () => accountMachines(e))))
  ipcMain.handle('remote:accountConnect', (e, machineId: unknown) => withLocalServer(e, () => accountConnectOnce(e, machineId)))
  ipcMain.handle('remote:projectTransferStart', (e, args: unknown) =>
    withLocalServer(e, () => projectTransferStart(e, args)) as Promise<TransferStartResult>)
  ipcMain.handle('remote:projectTransferCancel', (e, transferId: unknown, discard: unknown) =>
    local(e, () => guarded('projectTransferCancel', () => projectTransferCancel(transferId, discard))))
}
