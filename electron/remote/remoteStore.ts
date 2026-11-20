/**
 * The computers this app is paired with (Remote computers, Oct 28 2026):
 * `<userData>/remote-computers.json`, mode 0600, written whole to a temp file and
 * renamed over the old one so a crash never leaves half a file.
 *
 * Each record holds its device token encrypted with the OS keychain (Electron
 * `safeStorage`, injected so tests run without Electron). With no keychain there is
 * nowhere safe to keep a key that signs in to another computer, so `add` refuses
 * rather than writing it in the clear. `list()`/`get()` never return the token; only
 * `credentials()` does, for the main process to sign in with.
 *
 * Plan 18: a record also says how it was made (`origin`: by a pairing `link`, or through
 * the AASC Cloud `account`, which then names the machine there in `backendDeviceId`).
 * A record from before plan 18 has neither field and reads as paired by link.
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { RemoteComputer } from '../../src/types/electron.js'
import { CLOUD_METADATA_ADDRESS, isHostedOrigin, isPrivateLanAddress, isPublicAddress, isTailnetAddress } from './pairingLinkRules.js'

export interface RemoteCrypto {
  isAvailable(): boolean
  encrypt(value: string): Buffer
  decrypt(value: Buffer): string
}

export interface RemoteStoreDeps {
  file: string
  crypto: RemoteCrypto
  newId?: () => string
}

interface StoredRemote extends RemoteComputer {
  /** This computer's device id on the remote. */
  deviceId: string
  /** The device token, safeStorage-encrypted, base64. */
  token: string
}

export type NewRemote = Omit<RemoteComputer, 'id'> & { deviceId: string }

/** The machine's device id on the AASC Cloud account: a lowercase UUID, as the backend writes them. */
export const BACKEND_DEVICE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** What `update` may change: never the id, the addresses' port, or the key. */
export type RemotePatch = Partial<Pick<RemoteComputer, 'name' | 'tailnet' | 'status' | 'confirmCode' | 'lastSeenAt'>>

/** Where the account's directory says a machine listens (plan 18): what `refreshAddresses` takes. */
export interface DirectoryAddresses {
  lan: string | null
  tailnet: string | null
  publicAddress: string | null
  port: number
}

/** Every address listed is of its own kind, there is at least one, and the port is one. */
function usableAddresses(a: DirectoryAddresses): boolean {
  if (!Number.isInteger(a.port) || a.port < 1 || a.port > 65535) return false
  if (a.lan !== null && !(isPrivateLanAddress(a.lan) && a.lan !== CLOUD_METADATA_ADDRESS)) return false
  if (a.tailnet !== null && !isTailnetAddress(a.tailnet)) return false
  if (a.publicAddress !== null && !isPublicAddress(a.publicAddress)) return false
  return a.lan !== null || a.tailnet !== null || a.publicAddress !== null
}

export const NO_KEYCHAIN = 'This computer can’t store the pairing key safely (no system keychain).'

/** The id format: a UUID, which is also what remoteWindow's partition name is built from. */
export const REMOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const STATUSES = new Set(['pending', 'active', 'revoked'])
const ORIGINS = new Set(['link', 'account'])
const CANT_SAVE = 'That computer can’t be saved here.'

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === 'string'
}

/** A record read back from disk, or null when any field is the wrong shape. */
function readRecord(raw: unknown): StoredRemote | null {
  if (!raw || typeof raw !== 'object') return null
  const r = raw as Record<string, unknown>
  if (typeof r.id !== 'string' || !REMOTE_ID.test(r.id)) return null
  if (typeof r.name !== 'string' || typeof r.deviceId !== 'string' || typeof r.token !== 'string') return null
  if (!isNullableString(r.lan) || !isNullableString(r.tailnet) || !isNullableString(r.confirmCode)) return null
  if (r.httpsOrigin !== undefined && !isHostedOrigin(r.httpsOrigin)) return null
  if (r.publicAddress !== undefined && !(typeof r.publicAddress === 'string' && isPublicAddress(r.publicAddress))) return null
  if (typeof r.port !== 'number' || typeof r.status !== 'string' || !STATUSES.has(r.status)) return null
  if (typeof r.addedAt !== 'number' || !(r.lastSeenAt === null || typeof r.lastSeenAt === 'number')) return null
  // Plan 18: a record from before it has neither field and was paired by link.
  if (r.origin !== undefined && !(typeof r.origin === 'string' && ORIGINS.has(r.origin))) return null
  if (r.backendDeviceId !== undefined && !(typeof r.backendDeviceId === 'string' && BACKEND_DEVICE_ID.test(r.backendDeviceId))) return null
  if (r.origin === 'account' && r.backendDeviceId === undefined) return null
  return {
    id: r.id, name: r.name, lan: r.lan, tailnet: r.tailnet,
    ...(typeof r.httpsOrigin === 'string' ? { httpsOrigin: r.httpsOrigin } : {}),
    ...(typeof r.publicAddress === 'string' ? { publicAddress: r.publicAddress } : {}),
    port: r.port, status: r.status as RemoteComputer['status'], confirmCode: r.confirmCode,
    addedAt: r.addedAt, lastSeenAt: r.lastSeenAt as number | null,
    origin: r.origin === 'account' ? 'account' : 'link',
    ...(typeof r.backendDeviceId === 'string' ? { backendDeviceId: r.backendDeviceId } : {}),
    deviceId: r.deviceId, token: r.token,
  }
}

function toView(r: StoredRemote): RemoteComputer {
  return {
    id: r.id, name: r.name, lan: r.lan, tailnet: r.tailnet,
    ...(r.httpsOrigin ? { httpsOrigin: r.httpsOrigin } : {}),
    ...(r.publicAddress ? { publicAddress: r.publicAddress } : {}),
    port: r.port, status: r.status, confirmCode: r.confirmCode, addedAt: r.addedAt, lastSeenAt: r.lastSeenAt,
    origin: r.origin ?? 'link',
    ...(r.backendDeviceId ? { backendDeviceId: r.backendDeviceId } : {}),
  }
}

export function createRemoteStore(deps: RemoteStoreDeps) {
  const newId = deps.newId ?? randomUUID
  let cache: StoredRemote[] | null = null

  function load(): StoredRemote[] {
    if (cache) return cache
    let parsed: unknown = null
    try {
      parsed = JSON.parse(readFileSync(deps.file, 'utf8'))
    } catch {
      parsed = null // missing or unreadable: no computers yet
    }
    const items = parsed && typeof parsed === 'object' ? (parsed as { computers?: unknown }).computers : null
    cache = Array.isArray(items) ? items.map(readRecord).filter((r): r is StoredRemote => r !== null) : []
    return cache
  }

  function save(next: StoredRemote[]): void {
    const tmp = `${deps.file}.${process.pid}.${Date.now()}.tmp`
    writeFileSync(tmp, JSON.stringify({ version: 1, computers: next }, null, 2), { mode: 0o600 })
    renameSync(tmp, deps.file)
    // rename keeps the temp file's mode, but an old file created looser is replaced, not reused.
    try { chmodSync(deps.file, 0o600) } catch { /* best effort */ }
    cache = next
  }

  /** Can a pairing key be stored here at all? Checked before pairing, so no remote is left holding a device we can't keep. */
  function canStore(): boolean {
    try { return deps.crypto.isAvailable() } catch { return false }
  }

  return {
    canStore,

    list(): RemoteComputer[] {
      return load().map(toView)
    },

    get(id: string): RemoteComputer | null {
      const r = load().find((x) => x.id === id)
      return r ? toView(r) : null
    },

    /** The device id and token to sign in with; null when unknown or the keychain can't open it. */
    credentials(id: string): { deviceId: string; deviceToken: string } | null {
      const r = load().find((x) => x.id === id)
      if (!r) return null
      try {
        return { deviceId: r.deviceId, deviceToken: deps.crypto.decrypt(Buffer.from(r.token, 'base64')) }
      } catch {
        return null
      }
    },

    /**
     * Save a new pairing. A record made through the account (`origin: 'account'`) replaces the one this computer
     * already has for that machine (`backendDeviceId`), keeping its id: connecting again never makes a second row.
     * A record paired by link is always a new row, as before.
     */
    add(input: NewRemote, deviceToken: string): { ok: true; data: RemoteComputer } | { ok: false; error: string } {
      const viaAccount = input.origin === 'account'
      // An account record names its machine, or the next load would drop it.
      if (viaAccount && !(typeof input.backendDeviceId === 'string' && BACKEND_DEVICE_ID.test(input.backendDeviceId))) {
        return { ok: false, error: CANT_SAVE }
      }
      if (!canStore()) return { ok: false, error: NO_KEYCHAIN }
      let token: string
      try {
        token = deps.crypto.encrypt(deviceToken).toString('base64')
      } catch {
        return { ok: false, error: NO_KEYCHAIN }
      }
      const all = load()
      const old = viaAccount ? all.findIndex((x) => x.origin === 'account' && x.backendDeviceId === input.backendDeviceId) : -1
      const record: StoredRemote = {
        id: old >= 0 ? all[old].id : newId(), name: input.name, lan: input.lan, tailnet: input.tailnet,
        ...(input.httpsOrigin ? { httpsOrigin: input.httpsOrigin } : {}),
        ...(input.publicAddress ? { publicAddress: input.publicAddress } : {}),
        port: input.port,
        status: input.status, confirmCode: input.confirmCode, addedAt: input.addedAt, lastSeenAt: input.lastSeenAt,
        origin: viaAccount ? 'account' : 'link',
        ...(viaAccount ? { backendDeviceId: input.backendDeviceId } : {}),
        deviceId: input.deviceId, token,
      }
      save(old >= 0 ? [...all.slice(0, old), record, ...all.slice(old + 1)] : [...all, record])
      return { ok: true, data: toView(record) }
    },

    update(id: string, patch: RemotePatch): RemoteComputer | null {
      const all = load()
      const i = all.findIndex((x) => x.id === id)
      if (i < 0) return null
      const next = { ...all[i], ...patch }
      save([...all.slice(0, i), next, ...all.slice(i + 1)])
      return toView(next)
    },

    /**
     * Take a machine's addresses from the account's directory (plan 18). Only for a record made through the account:
     * it trusts no address until the machine proves itself there, so a changed hint costs nothing. A record paired by
     * link keeps the addresses of its link (`update` may change its Tailscale address alone, on the machine's signed
     * word). Null, and nothing written, for a link record, an unknown id, or addresses that aren't all of their kind.
     */
    refreshAddresses(id: string, addresses: DirectoryAddresses): RemoteComputer | null {
      const all = load()
      const i = all.findIndex((x) => x.id === id)
      if (i < 0 || all[i].origin !== 'account' || !usableAddresses(addresses)) return null
      const old = all[i]
      if (old.lan === addresses.lan && old.tailnet === addresses.tailnet && (old.publicAddress ?? null) === addresses.publicAddress
        && old.port === addresses.port) {
        return toView(old)
      }
      const { publicAddress: _dropped, ...rest } = old
      const next: StoredRemote = {
        ...rest, lan: addresses.lan, tailnet: addresses.tailnet, port: addresses.port,
        ...(addresses.publicAddress ? { publicAddress: addresses.publicAddress } : {}),
      }
      save([...all.slice(0, i), next, ...all.slice(i + 1)])
      return toView(next)
    },

    remove(id: string): boolean {
      const all = load()
      if (!all.some((x) => x.id === id)) return false
      save(all.filter((x) => x.id !== id))
      return true
    },
  }
}

export type RemoteStore = ReturnType<typeof createRemoteStore>
