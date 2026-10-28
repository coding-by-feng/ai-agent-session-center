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
 */
import { chmodSync, readFileSync, renameSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import type { RemoteComputer } from '../../src/types/electron.js'
import { isPublicAddress } from './pairingLinkRules.js'

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

/** What `update` may change: never the id, the addresses' port, or the key. */
export type RemotePatch = Partial<Pick<RemoteComputer, 'name' | 'tailnet' | 'status' | 'confirmCode' | 'lastSeenAt'>>

export const NO_KEYCHAIN = 'This computer can’t store the pairing key safely (no system keychain).'

/** The id format: a UUID, which is also what remoteWindow's partition name is built from. */
export const REMOTE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

const STATUSES = new Set(['pending', 'active', 'revoked'])

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
  if (r.publicAddress !== undefined && !(typeof r.publicAddress === 'string' && isPublicAddress(r.publicAddress))) return null
  if (typeof r.port !== 'number' || typeof r.status !== 'string' || !STATUSES.has(r.status)) return null
  if (typeof r.addedAt !== 'number' || !(r.lastSeenAt === null || typeof r.lastSeenAt === 'number')) return null
  return {
    id: r.id, name: r.name, lan: r.lan, tailnet: r.tailnet,
    ...(typeof r.publicAddress === 'string' ? { publicAddress: r.publicAddress } : {}),
    port: r.port, status: r.status as RemoteComputer['status'], confirmCode: r.confirmCode,
    addedAt: r.addedAt, lastSeenAt: r.lastSeenAt as number | null,
    deviceId: r.deviceId, token: r.token,
  }
}

function toView(r: StoredRemote): RemoteComputer {
  return {
    id: r.id, name: r.name, lan: r.lan, tailnet: r.tailnet,
    ...(r.publicAddress ? { publicAddress: r.publicAddress } : {}),
    port: r.port, status: r.status, confirmCode: r.confirmCode, addedAt: r.addedAt, lastSeenAt: r.lastSeenAt,
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

    add(input: NewRemote, deviceToken: string): { ok: true; data: RemoteComputer } | { ok: false; error: string } {
      if (!canStore()) return { ok: false, error: NO_KEYCHAIN }
      let token: string
      try {
        token = deps.crypto.encrypt(deviceToken).toString('base64')
      } catch {
        return { ok: false, error: NO_KEYCHAIN }
      }
      const record: StoredRemote = {
        id: newId(), name: input.name, lan: input.lan, tailnet: input.tailnet,
        ...(input.publicAddress ? { publicAddress: input.publicAddress } : {}),
        port: input.port,
        status: input.status, confirmCode: input.confirmCode, addedAt: input.addedAt, lastSeenAt: input.lastSeenAt,
        deviceId: input.deviceId, token,
      }
      save([...load(), record])
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

    remove(id: string): boolean {
      const all = load()
      if (!all.some((x) => x.id === id)) return false
      save(all.filter((x) => x.id !== id))
      return true
    },
  }
}

export type RemoteStore = ReturnType<typeof createRemoteStore>
