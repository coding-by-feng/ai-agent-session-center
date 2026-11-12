/**
 * portPreflight.ts — Lite's choice of port, made before it loads the server at all.
 *
 * Full's server kills whatever holds its port. Lite never does: another program keeps its port and Lite
 * moves to the next free one for this launch. The move is not saved, because server-config.json is shared
 * with Full, so the next launch tries the usual port first.
 *
 * The one holder Lite will not move away from is another AASC server, such as an older Full with no
 * single-instance lock (singleInstance.ts). Both would use the same data folder and hook queue: db.ts opens
 * sessions.db on import, and startServer marks every open session ended before it listens, which would end
 * all of the running app's sessions. That is also why this runs before the server module loads.
 */
import net from 'net'

/** How many ports past the usual one Lite tries. */
const PORT_TRIES = 20
const MAX_PORT = 65535
/** Long enough for a busy AASC server, whose event loop is never meant to block. */
const HOLDER_ANSWER_MS = 5000

/** The port startServer will choose: the same order as resolvePort in server/portManager.ts. */
export function resolveServerPort(argv: string[], env: NodeJS.ProcessEnv, configJson: string | null): number {
  const flagAt = argv.indexOf('--port')
  const candidates: unknown[] = [flagAt >= 0 ? argv[flagAt + 1] : undefined, env.PORT]
  for (const candidate of candidates) {
    const port = parseInt(String(candidate), 10)
    if (port > 0) return port
  }
  try {
    const port = (JSON.parse(configJson ?? '{}') as { port?: unknown }).port
    if (typeof port === 'number' && port > 0) return port
  } catch { /* an unreadable config falls back to the default, as the server's does */ }
  return 3333
}

/** Only "address in use" counts as busy: any other failure is the server's own to report. */
function canBind(port: number, host?: string): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = net.createServer()
    probe.once('error', (err: NodeJS.ErrnoException) => resolve(err.code !== 'EADDRINUSE'))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, host)
  })
}

/**
 * Every address first, as the server binds, then each loopback address: macOS lets the first succeed beside a
 * listener on 127.0.0.1 or ::1 alone, and the window's localhost could then reach that program instead of Lite.
 */
export async function isPortFree(port: number): Promise<boolean> {
  return (await canBind(port)) && (await canBind(port, '127.0.0.1')) && (await canBind(port, '::1'))
}

/** Does an AASC server hold this port? Its login status answers without a sign-in, in every released version. */
export async function isAascServer(port: number, timeoutMs: number = HOLDER_ANSWER_MS): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/auth/status`, {
      signal: AbortSignal.timeout(timeoutMs),
      redirect: 'error',
    })
    if (!response.ok) return false
    const body = await response.json() as { passwordRequired?: unknown; authenticated?: unknown } | null
    return typeof body?.passwordRequired === 'boolean' && typeof body.authenticated === 'boolean'
  } catch {
    return false // A program that doesn't speak HTTP, or still hasn't answered: not one of ours.
  }
}

export type PortChoice = { port: number } | { stop: string }

/** The port Lite starts on, or the reason it can't start. Nothing here ever touches the program holding a port. */
export async function chooseLitePort(
  wanted: number,
  checks: { isPortFree: (port: number) => Promise<boolean>; isAascServer: (port: number) => Promise<boolean> } = {
    isPortFree,
    isAascServer: (port) => isAascServer(port),
  },
): Promise<PortChoice> {
  if (await checks.isPortFree(wanted)) return { port: wanted }
  if (await checks.isAascServer(wanted)) return { stop: portBusyMessage(wanted) }
  const last = Math.min(wanted + PORT_TRIES, MAX_PORT)
  for (let port = wanted + 1; port <= last; port += 1) {
    if (await checks.isPortFree(port)) return { port }
  }
  return { stop: noFreePortMessage(wanted, last) }
}

export function portBusyMessage(port: number): string {
  return `Port ${port} is in use by another copy of AI Agent Session Center. Quit it, then open Lite again.`
}

export function noFreePortMessage(first: number, last: number): string {
  return `Ports ${first}–${last} are all in use. Quit a program using one of them, then open Lite again.`
}

export function portMovedMessage(wanted: number, port: number): string {
  return `Port ${wanted} is in use, so Lite is using port ${port}`
}
