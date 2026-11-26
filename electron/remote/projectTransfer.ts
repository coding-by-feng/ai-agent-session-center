/**
 * Copy / Move a project to a paired computer (docs/plans/project-transfer.md): main's half.
 *
 * This computer's own server holds the plan and reads the files; the target's server stages and
 * checks them. Main stands between the two: it already holds the paired computer's credentials,
 * so no server ever sees the other's session. Pure: every network call and the Trash come in as deps.
 *
 *   local  GET  /plan/:id/items
 *   remote POST /incoming                        (same id again resumes)
 *   remote GET  /incoming/:id   every 2 s         while it waits for Allow there
 *   local  GET  /plan/:id/pack?items=R  ──pipe──► remote PUT /incoming/:id/pack?items=R
 *   local  POST /plan/:id/refresh                 when files changed while being sent (twice at most)
 *   remote POST /incoming/:id/commit
 *   move:  local POST /plan/:id/move-check → Trash → local POST /moved
 */
import type {
  CommitResult, IncomingStatus, PackResult, TransferItem, TransferMode, TransferOutcome, TransferPlanInfo,
  TransferProgress, TransferStage,
} from '../../src/types/projectTransfer.js'

export type StreamFetch = (url: string, init: RequestInit & { duplex?: 'half' }) => Promise<Response>

export interface TransferDeps {
  fetch: StreamFetch
  /** Put a path in the system Trash (shell.trashItem); throws when it can't. */
  trash(path: string): Promise<void>
  /** Does a path exist on this computer? */
  exists(path: string): Promise<boolean>
  sleep(ms: number, signal: AbortSignal): Promise<void>
  now(): number
}

export interface TransferRun {
  transferId: string
  /** This computer's server: `http://127.0.0.1:<port>`, and the dashboard window's session (a password may be set). */
  local: { origin: string; sessionToken: string | null }
  /** The paired computer, signed in over Tailscale or HTTPS. */
  remote: { origin: string; token: string; name: string }
  planId: string
  destination: string
  mode: TransferMode
  signal: AbortSignal
  onProgress(progress: TransferProgress): void
}

export class TransferFailed extends Error {
  constructor(message: string, readonly code: string, readonly resumable: boolean) {
    super(message)
  }
}

export const ALLOW_POLL_MS = 2_000
export const ALLOW_WAIT_MS = 15 * 60_000
export const PACK_MAX_BYTES = 64 * 1024 * 1024
export const PACK_MAX_FILES = 2_000
/** Rounds of "send what is missing": the first, then up to two after a fresh scan. */
const MAX_ROUNDS = 3

/** `0-5,7,9-12` for ascending, unique indexes (the server's pack.ts reads it). */
export function formatRanges(indexes: readonly number[]): string {
  const parts: string[] = []
  let i = 0
  while (i < indexes.length) {
    let j = i
    while (j + 1 < indexes.length && indexes[j + 1] === indexes[j] + 1) j++
    parts.push(i === j ? String(indexes[i]) : `${indexes[i]}-${indexes[j]}`)
    i = j + 1
  }
  return parts.join(',')
}

/** Missing files in plan order, cut into packs of at most PACK_MAX_BYTES / PACK_MAX_FILES (a big file alone). */
export function packsOf(items: readonly TransferItem[], have: ReadonlySet<number>): number[][] {
  const packs: number[][] = []
  let cur: number[] = []
  let bytes = 0
  for (const it of items) {
    if (it.kind !== 'file' || have.has(it.i)) continue
    if (cur.length > 0 && (bytes + it.size > PACK_MAX_BYTES || cur.length >= PACK_MAX_FILES)) {
      packs.push(cur)
      cur = []
      bytes = 0
    }
    cur.push(it.i)
    bytes += it.size
  }
  if (cur.length) packs.push(cur)
  return packs
}

interface Envelope<T> {
  status: number
  data: T | null
  error: string | null
  code: string | null
}

async function envelope<T>(res: Response): Promise<Envelope<T>> {
  let body: unknown = null
  try {
    body = await res.json()
  } catch {
    body = null
  }
  const b = (body && typeof body === 'object' ? body : {}) as { success?: unknown; data?: unknown; error?: unknown; code?: unknown }
  return {
    status: res.status,
    data: b.success === true ? (b.data as T) : null,
    error: typeof b.error === 'string' ? b.error : null,
    code: typeof b.code === 'string' ? b.code : null,
  }
}

const OFFLINE = (name: string): TransferFailed =>
  new TransferFailed(`Lost the connection to ${name}. Resume when it is back.`, 'offline', true)

export function createTransferClient(deps: TransferDeps, run: TransferRun) {
  const { local, remote, signal } = run

  const localHeaders = (json: boolean): Record<string, string> => ({
    Accept: 'application/json',
    Origin: local.origin,
    ...(json ? { 'Content-Type': 'application/json' } : {}),
    ...(local.sessionToken ? { Cookie: `auth_token=${local.sessionToken}` } : {}),
  })
  const remoteHeaders = (contentType: string | null): Record<string, string> => ({
    Accept: 'application/json',
    Authorization: `Bearer ${remote.token}`,
    ...(contentType ? { 'Content-Type': contentType } : {}),
    ...(remote.origin.startsWith('https:') ? { Origin: remote.origin } : {}),
  })

  async function askLocal<T>(method: string, path: string, body?: unknown): Promise<T> {
    let res: Response
    try {
      res = await deps.fetch(`${local.origin}/api/project-transfer${path}`, {
        method, headers: localHeaders(body !== undefined), body: body === undefined ? undefined : JSON.stringify(body),
        redirect: 'manual', signal,
      })
    } catch (err) {
      if (signal.aborted) throw new TransferFailed('Stopped.', 'cancelled', true)
      throw new TransferFailed(`This computer's AASC did not answer: ${(err as Error).message}`, 'local', true)
    }
    const e = await envelope<T>(res)
    if (e.data === null && res.status !== 200) throw new TransferFailed(e.error ?? `This computer refused (${res.status}).`, e.code ?? 'local', e.code !== 'agents_working')
    return e.data as T
  }

  async function askRemote<T>(method: string, path: string, body?: unknown): Promise<Envelope<T>> {
    try {
      const res = await deps.fetch(`${remote.origin}/api/project-transfer/incoming${path}`, {
        method, headers: remoteHeaders(body === undefined ? null : 'application/json'),
        body: body === undefined ? undefined : JSON.stringify(body), redirect: 'manual', signal,
      })
      return await envelope<T>(res)
    } catch {
      if (signal.aborted) throw new TransferFailed('Stopped.', 'cancelled', true)
      throw OFFLINE(remote.name)
    }
  }

  function refused(e: Envelope<unknown>): TransferFailed {
    if (e.status === 413) return new TransferFailed(`${remote.name} refused a plan that large. Leave out node_modules or split the project.`, 'too_large', false)
    const resumable = !['destination_exists', 'path_not_allowed', 'declined', 'insecure_channel', 'computer_only', 'invalid_plan'].includes(e.code ?? '')
    return new TransferFailed(e.error ?? `${remote.name} refused (${e.status}).`, e.code ?? 'remote', resumable)
  }

  let totals = { files: 0, bytes: 0 }
  let sent = { files: 0, bytes: 0 }
  const progress = (stage: TransferStage, message: string | null = null): void => {
    run.onProgress({
      transferId: run.transferId, stage, message,
      sentFiles: sent.files, totalFiles: totals.files, sentBytes: sent.bytes, totalBytes: totals.bytes,
    })
  }

  async function begin(planId: string): Promise<{ items: TransferItem[]; root: string; status: IncomingStatus }> {
    const { root, items } = await askLocal<{ root: string; items: TransferItem[] }>('GET', `/plan/${planId}/items`)
    const projectName = root.split('/').filter(Boolean).pop() ?? 'project'
    const e = await askRemote<IncomingStatus>('POST', '', { id: run.transferId, projectName, destination: run.destination, sourceRoot: root, items })
    if (!e.data) throw refused(e)
    const files = items.filter((it) => it.kind === 'file')
    totals = { files: files.length, bytes: files.reduce((n, it) => n + it.size, 0) }
    const have = new Set(e.data.have)
    const arrived = files.filter((it) => have.has(it.i))
    sent = { files: arrived.length, bytes: arrived.reduce((n, it) => n + it.size, 0) }
    return { items, root, status: e.data }
  }

  async function waitForAllow(status: IncomingStatus): Promise<IncomingStatus> {
    const started = deps.now()
    let cur = status
    while (cur.state === 'awaiting-allow') {
      progress('waiting-allow', `Waiting for Allow on ${remote.name}…`)
      if (deps.now() - started > ALLOW_WAIT_MS) {
        throw new TransferFailed(`Nobody pressed Allow on ${remote.name}. Try again when someone is there.`, 'allow_timeout', true)
      }
      await deps.sleep(ALLOW_POLL_MS, signal)
      const e = await askRemote<IncomingStatus>('GET', `/${run.transferId}`)
      if (!e.data) throw refused(e)
      cur = e.data
    }
    if (cur.state === 'declined') throw new TransferFailed(`${remote.name} declined the transfer.`, 'declined', false)
    if (cur.state !== 'receiving') throw new TransferFailed(`${remote.name} is not taking the transfer.`, cur.state, false)
    return cur
  }

  /** One pack: the local server's bytes piped to the target as they are read. */
  async function sendPack(planId: string, items: readonly TransferItem[], pack: number[]): Promise<PackResult> {
    const ranges = formatRanges(pack)
    let source: Response
    try {
      source = await deps.fetch(`${local.origin}/api/project-transfer/plan/${planId}/pack?items=${ranges}`, {
        method: 'GET', headers: localHeaders(false), redirect: 'manual', signal,
      })
    } catch {
      if (signal.aborted) throw new TransferFailed('Stopped.', 'cancelled', true)
      throw new TransferFailed('This computer stopped reading the project.', 'local', true)
    }
    if (source.status !== 200 || !source.body) {
      const e = await envelope(source)
      throw new TransferFailed(e.error ?? 'This computer could not read the project.', e.code ?? 'local', true)
    }
    const baseBytes = sent.bytes
    let lastReport = 0
    let counted = 0
    const counter = new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        counted += chunk.byteLength
        if (counted - lastReport > 4 * 1024 * 1024) {
          lastReport = counted
          sent = { ...sent, bytes: baseBytes + counted }
          progress('sending', null)
        }
        controller.enqueue(chunk)
      },
    })
    let res: Response
    try {
      res = await deps.fetch(`${remote.origin}/api/project-transfer/incoming/${run.transferId}/pack?items=${ranges}`, {
        method: 'PUT', headers: remoteHeaders('application/octet-stream'), body: source.body.pipeThrough(counter),
        duplex: 'half', redirect: 'manual', signal,
      })
    } catch {
      if (signal.aborted) throw new TransferFailed('Stopped.', 'cancelled', true)
      throw OFFLINE(remote.name)
    }
    const e = await envelope<PackResult>(res)
    if (!e.data) throw refused(e)
    const byIndex = new Map(items.map((it) => [it.i, it]))
    const got = e.data.received.map((i) => byIndex.get(i)).filter((it): it is TransferItem => !!it)
    sent = { files: sent.files + got.length, bytes: baseBytes + got.reduce((n, it) => n + it.size, 0) }
    progress('sending', null)
    return e.data
  }

  async function commit(): Promise<CommitResult | 'incomplete'> {
    progress('committing', 'Putting it in place…')
    const e = await askRemote<CommitResult>('POST', `/${run.transferId}/commit`)
    if (e.data) return e.data
    if (e.code === 'incomplete') return 'incomplete'
    throw refused(e)
  }

  async function move(planId: string, commitResult: CommitResult): Promise<Pick<TransferOutcome, 'moved' | 'moveMessage'>> {
    progress('moving', 'Moving this folder to the Trash…')
    let check: { root: string; trash: string[]; note?: string | null }
    try {
      check = await askLocal('POST', `/plan/${planId}/move-check`)
    } catch (err) {
      return { moved: false, moveMessage: (err as Error).message }
    }
    for (const path of check.trash) {
      if (!(await deps.exists(path))) continue
      try {
        await deps.trash(path)
      } catch (err) {
        return { moved: false, moveMessage: `The copy is complete, but ${path} could not go to the Trash: ${(err as Error).message}` }
      }
    }
    // The marker is only the "Moved to …" line on this computer; the move itself is done.
    await askLocal('POST', '/moved', { root: check.root, computer: remote.name, destination: commitResult.destination }).catch(() => null)
    return { moved: true, moveMessage: check.note ?? null }
  }

  /** The whole transfer. Throws TransferFailed; the id stays valid for a resume when `resumable`. */
  async function runAll(): Promise<TransferOutcome> {
    progress('connecting', `Connecting to ${remote.name}…`)
    let planId = run.planId
    let { items, status } = await begin(planId)
    status = await waitForAllow(status)
    let have = new Set(status.have)
    for (let round = 1; ; round++) {
      let changed = 0
      for (const pack of packsOf(items, have)) {
        const result = await sendPack(planId, items, pack)
        for (const i of result.received) have.add(i)
        changed += result.failed.length
        if (result.received.length + result.failed.length < pack.length) break // the pack was cut short: send the rest again
      }
      if (changed === 0 && packsOf(items, have).length === 0) {
        const done = await commit()
        if (done !== 'incomplete') {
          const outcome: TransferOutcome = { transferId: run.transferId, commit: done, moved: null, moveMessage: null }
          if (run.mode === 'move') Object.assign(outcome, await move(planId, done))
          // Frees the plan's temporary files; the server also drops plans after 6 hours.
          await askLocal('DELETE', `/plan/${planId}`).catch(() => null)
          progress('done', null)
          return outcome
        }
      }
      if (round >= MAX_ROUNDS) {
        throw new TransferFailed(
          `${changed || 'Some'} files kept changing while they were sent (an agent may be working there). Resume when it is quiet.`,
          'changing', true,
        )
      }
      // Files changed under us: measure again and tell the target, which keeps whatever still matches.
      const fresh = await askLocal<TransferPlanInfo>('POST', `/plan/${planId}/refresh`)
      planId = fresh.planId
      ;({ items, status } = await begin(planId))
      have = new Set(status.have)
    }
  }

  return { runAll }
}

/** Ask the target to drop what it staged for a transfer (Discard). */
export async function discardRemote(deps: Pick<TransferDeps, 'fetch'>, remote: TransferRun['remote'], transferId: string): Promise<boolean> {
  try {
    const res = await deps.fetch(`${remote.origin}/api/project-transfer/incoming/${transferId}`, {
      method: 'DELETE',
      headers: { Accept: 'application/json', Authorization: `Bearer ${remote.token}`, ...(remote.origin.startsWith('https:') ? { Origin: remote.origin } : {}) },
      redirect: 'manual',
    })
    return res.status === 200 || res.status === 404
  } catch {
    return false
  }
}
