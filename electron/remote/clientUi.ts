/**
 * clientUi.ts — the UI a Client edition carries, shown in a remote's window.
 *
 * A remote's window normally shows whatever UI that computer serves, so a Lite Client paired with a Full Mac would look
 * like Full. A Client answers for the page and its files itself and lets everything else reach the remote. The window
 * still loads `http://<remote>:<port>/`, so its origin is the remote's: the sign-in cookie, relative fetches and the
 * WebSocket (which `protocol.handle` never sees) all work unchanged, and the server needs no change.
 *
 * Electron's `protocol.handle` rebuilds each request's headers before any handler runs and throws on a non-ASCII value,
 * which fails the request. The dashboard's device name ("Mac · Chrome") is on every call, so `HEADER_GUARD_SCRIPT` makes
 * outgoing values ASCII in the page. It lives here, not in src/, so Full and Lite send what they always sent.
 *
 * Three things a request loses by passing through the main process, each put back or closed here:
 * - `Origin`, which also turns Sec-Fetch-Site from same-origin into none: `forwardedHeaders` states it again.
 * - The page's CSP and the window's will-redirect policy over a redirect the main process would follow on its own, so
 *   a forwarded request fails on any redirect instead. The server issues none.
 * - The server's security headers on the page, since the server no longer sends the page: `UI_SECURITY_HEADERS`.
 *
 * The page no longer proves the remote is there either, so a page load asks (`reachable`): without that, a reload with
 * the remote off would end on a password form that can't succeed.
 *
 * The UI and the server can now be different versions, which nothing else in AASC allows. A Client older than its
 * server may meet an API it doesn't know. See docs/feature/electron/client-editions.md.
 *
 * Everything but `serveBundledUi` is free of Electron and tested in test/clientUi.test.ts.
 */
import type { BrowserWindow, Session } from 'electron'
import { readFile } from 'fs/promises'
import path from 'path'

/** The home page's address. A custom scheme gives it an identity no remote or local page can have. */
export const CLIENT_HOME_SCHEME = 'aasc-client'
const CLIENT_HOME_HOST = 'home'
export const CLIENT_HOME_URL = `${CLIENT_HOME_SCHEME}://${CLIENT_HOME_HOST}/`
const HOME_PAGE = 'client-home.html'

/** A copy of the headers in server/index.ts; test/clientUi.test.ts fails if the two differ. */
export const UI_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'X-XSS-Protection': '1; mode=block',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Content-Security-Policy': "default-src 'self'; script-src 'self' blob: 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; connect-src 'self' https://cdn.jsdelivr.net; img-src 'self' data: blob:; font-src 'self' data: https://cdn.jsdelivr.net; worker-src 'self' blob:; frame-src 'self' blob:",
}

/** The home page only talks to the main process, so it may load its own files and reach nothing else. */
const HOME_SECURITY_HEADERS: Readonly<Record<string, string>> = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-src 'none'; base-uri 'none'; form-action 'none'",
}

/** Where the page loads the guard from. Not a path the server has, and allowed by the page's CSP (`script-src 'self'`). */
export const HEADER_GUARD_PATH = '/__aasc-client/header-guard.js'

/**
 * Wraps `window.fetch` before the dashboard's bundle does, so its identity headers pass through here last. A request
 * with nothing to change goes through untouched. The name on the remote's list keeps its readable form: the WebSocket
 * sends it as JSON.
 */
export const HEADER_GUARD_SCRIPT = `(() => {
  const send = window.fetch;
  const toAscii = (value) => value.replace(/[^\\x20-\\x7e]+/g, '-');
  window.fetch = async (input, init) => {
    const source = init?.headers ?? (input instanceof Request ? input.headers : undefined);
    if (!source) return send(input, init);
    const headers = new Headers(source);
    const unsafe = [...headers].filter(([, value]) => toAscii(value) !== value);
    if (unsafe.length === 0) return send(input, init);
    for (const [name, value] of unsafe) headers.set(name, toAscii(value));
    return send(input, { ...init, headers });
  };
})();
`

/** The page, loading the guard first. A plain script runs before the bundle's deferred module. */
export function withHeaderGuard(html: string): string {
  const tag = `<script src="${HEADER_GUARD_PATH}"></script>`
  return html.includes('<head>') ? html.replace('<head>', `<head>${tag}`) : `${tag}${html}`
}

const CONTENT_TYPES: Readonly<Record<string, string>> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.txt': 'text/plain; charset=utf-8',
}

/** Is this the remote's to answer? Everything else a GET can ask for is the page or one of its files. */
export function isServerPath(pathname: string): boolean {
  return pathname === '/api' || pathname.startsWith('/api/')
    || pathname === '/mcp' || pathname.startsWith('/mcp/')
    || pathname === '/ws'
}

/** The file a path names inside `root`, or null when it isn't one. Decoded before checking: `%2e%2e%2f` is `../`. */
export function uiFileFor(root: string, pathname: string, indexName = 'index.html'): string | null {
  let decoded: string
  try {
    decoded = decodeURIComponent(pathname)
  } catch {
    return null
  }
  if (decoded.includes('\0') || decoded.includes('\\')) return null
  const base = path.resolve(root)
  const file = path.resolve(base, decoded === '/' ? indexName : decoded.replace(/^\/+/, ''))
  return file.startsWith(base + path.sep) ? file : null
}

export function uiContentType(file: string): string {
  return CONTENT_TYPES[path.extname(file).toLowerCase()] ?? 'application/octet-stream'
}

export function forwardedHeaders(headers: Headers, origin: string): Headers {
  const next = new Headers(headers)
  next.set('origin', origin)
  return next
}

export interface UiHandlerDeps {
  /** The remote's address right now: it can change between one open and the next. */
  origin: () => string
  root: string
  read: (file: string) => Promise<Buffer>
  forward: (request: Request) => Promise<Response>
  /** Does the remote answer? Asked before giving a page, never for its files. Absent means assume it does. */
  reachable?: () => Promise<boolean>
}

/** The page a window gets while its remote doesn't answer. It tries again by itself, so it needs no script. */
const OFFLINE_PAGE = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="refresh" content="5">
<meta name="color-scheme" content="light dark">
<title>Can’t reach this computer</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; font: 15px/1.5 system-ui, sans-serif; text-align: center; }
  main { max-width: 32rem; padding: 2rem; }
  h1 { font-size: 1.25rem; margin: 0 0 0.5rem; }
  p { margin: 0 0 1rem; }
</style>
</head>
<body>
<main>
<h1>This computer isn’t answering</h1>
<p>Trying again every few seconds. It may be asleep, or off this network.</p>
<p><a href="">Try now</a></p>
<p>To choose another computer, use File ▸ Computers…</p>
</main>
</body>
</html>
`

function offlineResponse(method: string): Response {
  return new Response(method === 'HEAD' ? null : OFFLINE_PAGE, {
    status: 503,
    headers: { ...UI_SECURITY_HEADERS, 'Content-Type': 'text/html; charset=utf-8' },
  })
}

async function answers(reachable: UiHandlerDeps['reachable']): Promise<boolean> {
  if (!reachable) return true
  try {
    return await reachable()
  } catch {
    return false
  }
}

function fileResponse(body: Buffer | string, file: string, method: string, security: Readonly<Record<string, string>>): Response {
  const headers = { ...security, 'Content-Type': uiContentType(file) }
  return new Response(method === 'HEAD' ? null : typeof body === 'string' ? body : new Uint8Array(body), { headers })
}

/** A file from the bundle, or index.html for an app route, as the server's SPA fallback does. */
async function uiResponse(deps: UiHandlerDeps, pathname: string, method: string): Promise<Response> {
  if (pathname === HEADER_GUARD_PATH) return fileResponse(HEADER_GUARD_SCRIPT, HEADER_GUARD_PATH, method, UI_SECURITY_HEADERS)
  const index = path.join(path.resolve(deps.root), 'index.html')
  const file = uiFileFor(deps.root, pathname)
  for (const candidate of file && file !== index ? [file, index] : [index]) {
    try {
      const body = await deps.read(candidate)
      if (candidate !== index) return fileResponse(body, candidate, method, UI_SECURITY_HEADERS)
      if (!(await answers(deps.reachable))) return offlineResponse(method)
      return fileResponse(withHeaderGuard(body.toString('utf8')), candidate, method, UI_SECURITY_HEADERS)
    } catch {
      // Missing, or a folder: an app route falls through to index.html.
    }
  }
  return new Response('This app’s files are missing. Install it again.', { status: 500 })
}

/** On every forwarded response, so one opened as a page runs no script: a Client only ever runs the UI it carries. */
export const FORWARDED_CSP = "sandbox; default-src 'none'"

/**
 * Types a browser would run if a page pointed at them. The page's CSP allows its own origin, which forwarded paths
 * share, so the type is the last thing between an injected `<script src="/api/…">` and the remote's code. Matched by
 * prefix, so `text/javascript1.5` counts too. SVG stays: an `<img>` runs nothing, and opened as a page FORWARDED_CSP does.
 */
const ACTIVE_TYPE = /^\s*(text\/html|application\/xhtml\+xml|text\/css|application\/wasm|(text|application)\/(x-)?(java|ecma)script|text\/(jscript|livescript))/i

/** A browser reads the last type it can parse, so one in a list counts wherever it sits. */
function isActiveType(contentType: string): boolean {
  return contentType.split(',').some((type) => ACTIVE_TYPE.test(type))
}

function asData(response: Response): Response {
  const headers = new Headers(response.headers)
  headers.set('Content-Security-Policy', FORWARDED_CSP)
  headers.set('X-Content-Type-Options', 'nosniff')
  headers.set('X-Frame-Options', 'DENY')
  if (isActiveType(headers.get('content-type') ?? '')) headers.set('Content-Type', 'text/plain; charset=utf-8')
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers })
}

/**
 * May this window save this URL? Its own origin only: blobs the UI made, and files from its remote such as the PDF
 * toolbar's Download. Anything else can only be there if something got into the page.
 */
export function isOwnDownload(url: string, origin: string): boolean {
  try {
    // A blob URL's origin is the page that made it.
    return new URL(url).origin === new URL(origin).origin
  } catch {
    return false
  }
}

export function createUiHandler(deps: UiHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    const origin = new URL(deps.origin()).origin
    // Never forwarded: from the main process it would lose Origin, escape CORS and follow redirects to file://, so a
    // hostile remote's page could drive a local AASC on this computer. The bundled UI needs no other http address.
    if (url.origin !== origin) return Response.error()
    if ((request.method === 'GET' || request.method === 'HEAD') && !isServerPath(url.pathname)) {
      return uiResponse(deps, url.pathname, request.method)
    }
    // no-store: nothing of the remote's stays on this disk, so forgetting a computer leaves nothing behind.
    return asData(await deps.forward(new Request(request, { headers: forwardedHeaders(request.headers, origin), redirect: 'error', cache: 'no-store' })))
  }
}

export interface HomeHandlerDeps {
  root: string
  read: (file: string) => Promise<Buffer>
}

export function createHomeHandler(deps: HomeHandlerDeps): (request: Request) => Promise<Response> {
  return async (request) => {
    const url = new URL(request.url)
    const file = url.hostname === CLIENT_HOME_HOST ? uiFileFor(deps.root, url.pathname, HOME_PAGE) : null
    if (!file) return new Response('Not found', { status: 404 })
    try {
      return fileResponse(await deps.read(file), file, request.method, HOME_SECURITY_HEADERS)
    } catch {
      return new Response('Not found', { status: 404 })
    }
  }
}

/** Is an IPC call from a Client's own home page? A Client has no local dashboard for the usual rule to accept. */
export function isClientHomeSenderUrl(url: string): boolean {
  try {
    const u = new URL(url)
    return u.protocol === `${CLIENT_HOME_SCHEME}:` && u.hostname === CLIENT_HOME_HOST
  } catch {
    return false
  }
}

// ── Electron side ───────────────────────────────────────────────────────────

/** How long a page waits to hear from its remote before saying it can't. */
const REACHABLE_TIMEOUT_MS = 3_000
const AUTH_COOKIE = 'auth_token'

const served = new WeakMap<Session, { origin: string }>()

/**
 * The computer moved (home network to Tailscale, say). A window left at the old address could only fail, since the
 * handler refuses it, while its socket would go on handing the cookie to whoever holds that address next.
 */
async function leaveAddress(ses: Session, previous: string, windows: BrowserWindow[]): Promise<void> {
  for (const win of windows) {
    if (!win.isDestroyed() && win.webContents.session === ses) win.close()
  }
  try {
    await ses.cookies.remove(`${previous}/`, AUTH_COOKIE)
  } catch {
    // Already gone. A fresh cookie is about to go in at the new address either way.
  }
}

/** Serve the bundle on this remote's partition. A later open may name a new address: the handler follows it. */
export async function serveBundledUi(ses: Session, origin: string, root: string, windows: () => BrowserWindow[]): Promise<void> {
  const current = served.get(ses)
  if (current) {
    const previous = current.origin
    current.origin = origin
    if (new URL(previous).origin !== new URL(origin).origin) await leaveAddress(ses, previous, windows())
    return
  }
  const state = { origin }
  served.set(ses, state)
  ses.on('will-download', (event, item) => {
    if (!isOwnDownload(item.getURL(), state.origin)) event.preventDefault()
  })
  const handler = createUiHandler({
    origin: () => state.origin,
    root,
    read: (file) => readFile(file),
    forward: (request) => ses.fetch(request, { bypassCustomProtocolHandlers: true }),
    reachable: async () => {
      const url = `${new URL(state.origin).origin}/api/auth/status`
      const res = await ses.fetch(url, { bypassCustomProtocolHandlers: true, signal: AbortSignal.timeout(REACHABLE_TIMEOUT_MS) })
      return res.ok
    },
  })
  ses.protocol.handle('http', handler)
  ses.protocol.handle('https', handler)
}
