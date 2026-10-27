/**
 * IPC for Remote computers (Oct 28 2026): pair this app with another computer's AASC
 * the way the phone does, check on it, and open its own UI in a window.
 *
 * Every argument comes from the renderer, so each is checked by hand here before it
 * reaches the store or the network. Every answer is `{ ok, data } | { ok: false, error }`
 * with a plain sentence: never a stack, a device token or a session token.
 */
import { app, ipcMain, safeStorage, type IpcMainInvokeEvent } from 'electron'
import { randomBytes } from 'crypto'
import os from 'os'
import path from 'path'
import type { RemoteComputer, RemoteComputerCheck, RemoteResult } from '../../src/types/electron.js'
import { readRemotePairingLink } from '../remote/pairingLinkRules.js'
import {
  countShared, fetchPaths, pair, signIn, unpair, unreachableMessage,
  type FetchLike, type RemoteClientDeps, type RemoteTarget, type SignInResult,
} from '../remote/remoteClient.js'
import { createRemoteStore, REMOTE_ID, type RemoteStore } from '../remote/remoteStore.js'
import { focusRemoteWindow, forgetRemoteWindow, isLocalAppSenderUrl, openRemoteWindow } from '../remote/remoteWindow.js'
import { logMainError } from '../crashLogger.js'

const MAX_LINK = 2048
const MAX_NAME = 80
const SOMETHING_WENT_WRONG = 'Something went wrong talking to that computer. Try again.'
const NOT_PAIRED = 'That computer isn’t paired here any more.'
const NOT_THIS_APP = 'Only this app’s own window can manage remote computers.'

let store: RemoteStore | null = null

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
  return { lan: r.lan, tailnet: r.tailnet, port: r.port }
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
function recordSignIn(id: string, result: SignInResult, now: number): void {
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
    port: read.link.port,
    status: 'pending',
    confirmCode: paired.confirmCode,
    addedAt: Date.now(),
    lastSeenAt: null,
    deviceId: paired.deviceId,
  }, paired.deviceToken)
}

async function check(id: unknown): Promise<RemoteResult<RemoteComputerCheck>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  const s = remoteStore()
  const r = s.get(id)
  const creds = s.credentials(id)
  if (!r || !creds) return fail(NOT_PAIRED)
  const result = await signIn(clientDeps, targetOf(r), creds)
  recordSignIn(id, result, Date.now())
  switch (result.state) {
    case 'ok': {
      // A Tailscale address counts only with the remote's proof; a missing one keeps the old.
      const paths = await fetchPaths(clientDeps, result.origin, result.token, creds)
      if (paths?.tailnet && paths.tailnet !== r.tailnet) s.update(id, { tailnet: paths.tailnet })
      const sharedSessions = await countShared(clientDeps, result.origin, result.token)
      return { ok: true, data: { state: 'online', via: result.via, sharedSessions, message: null } }
    }
    case 'pending':
      return { ok: true, data: { state: 'pending', via: result.via, sharedSessions: null, message: pendingMessage(r) } }
    case 'revoked':
      return { ok: true, data: { state: 'revoked', via: result.via, sharedSessions: null, message: revokedMessage(r) } }
    case 'offline':
      return { ok: true, data: { state: 'offline', via: null, sharedSessions: null, message: result.message } }
    case 'error':
      return fail(result.message)
  }
}

async function open(id: unknown): Promise<RemoteResult<null>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  if (focusRemoteWindow(id)) return { ok: true, data: null }
  const s = remoteStore()
  const r = s.get(id)
  const creds = s.credentials(id)
  if (!r || !creds) return fail(NOT_PAIRED)
  const result = await signIn(clientDeps, targetOf(r), creds)
  recordSignIn(id, result, Date.now())
  switch (result.state) {
    case 'ok':
      await openRemoteWindow({ id, name: r.name, origin: result.origin, token: result.token, expiresIn: result.expiresIn })
      return { ok: true, data: null }
    case 'pending':
      return fail(pendingMessage(r))
    case 'revoked':
      return fail(revokedMessage(r))
    case 'offline':
      return fail(result.message || unreachableMessage(targetOf(r)))
    case 'error':
      return fail(result.message)
  }
}

async function remove(id: unknown): Promise<RemoteResult<{ unpairedRemotely: boolean }>> {
  if (!validId(id)) return fail(NOT_PAIRED)
  const s = remoteStore()
  const r = s.get(id)
  if (!r) return fail(NOT_PAIRED)
  const creds = s.credentials(id)
  // Tell the remote when it answers; forget it here either way.
  const unpairedRemotely = creds ? await unpair(clientDeps, targetOf(r), creds) : false
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

/** Only the local dashboard may drive remote computers. */
function fromLocalApp(e: IpcMainInvokeEvent): boolean {
  return isLocalAppSenderUrl(e.senderFrame?.url ?? '')
}

function local<T>(e: IpcMainInvokeEvent, run: () => Promise<RemoteResult<T>>): Promise<RemoteResult<T>> {
  return fromLocalApp(e) ? run() : Promise.resolve(fail(NOT_THIS_APP))
}

export function registerRemoteHandlers(): void {
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
  ipcMain.handle('remote:open', (e, id: unknown) => local(e, () => guarded('open', () => open(id))))
  ipcMain.handle('remote:remove', (e, id: unknown) => local(e, () => guarded('remove', () => remove(id))))
  ipcMain.handle('remote:rename', (e, id: unknown, name: unknown) => local(e, () => guarded('rename', () => rename(id, name))))
}
