# Auth UI (Login Screen + Client Token Hook)

## Function
Client-side half of the password auth layer: a single-field login form (`LoginScreen`) plus the `useAuth` hook that checks auth status, logs in/out, persists the token in `localStorage`, silently refreshes it before expiry, and the `authFetch`/`getAuthToken` helpers that attach the token to HTTP/WS traffic.

## Purpose
The server-side auth layer (see [authentication.md](../server/authentication.md)) protects all `/api` and WS traffic with a password, in-memory tokens, and an HttpOnly cookie. This module is the frontend counterpart that obtains the password, holds the resulting bearer token, and keeps it fresh.

> **Why the gate exists:** `AuthGate` (`src/App.tsx`) is the *only* mount point for both `LoginScreen` and the `useAuth` hook. It previously was a stub that rendered `<Dashboard token={null} />` directly — on a password-protected server that meant the WS handshake was closed with `4001`, the client gave up reconnecting, and the app bricked with no login UI and no workspace restore. When no password is configured (the default), `needsLogin` stays false and the gate behaves exactly like the old stub (Dashboard with a null/absent token).

## Source Files
| File | Role |
|------|------|
| `src/components/auth/LoginScreen.tsx` | Login form, submit handler, inline error display |
| `src/hooks/useAuth.ts` | `useAuth` hook (status check, login/logout, token persistence, silent refresh) + exported `authFetch` / `getAuthToken` helpers |
| `src/hooks/useAuth.test.ts` | Unit tests for `authFetch` / `getAuthToken`, plus a regression suite (`useAuth — silent refresh keeps a cookie-only session alive`) driving the real hook through fake timers to prove the cookie-driven refresh actually fires with no token in `localStorage` |
| `src/styles/modules/Login.module.css` | Form styling |

## Implementation

### AuthGate (`src/App.tsx`)
The mount point that picks one of three branches from `useAuth()`:
- `loading` → an inline "Connecting…" splash (centred, `#0a0a1a` background, JetBrains Mono). Because the status check retries up to `MAX_RETRIES = 8` times at `RETRY_DELAY_MS = 800`, this is what users see for up to ~6.4s against a slow or absent server.
- `needsLogin` → `<LoginScreen onLogin={login} />`.
- otherwise → `<Dashboard token={token} />`, which prop-drills the token into `useWebSocket(token)`.

### LoginScreen (`LoginScreen.tsx`)
- **Props**: `onLogin(password) → Promise<{ success: boolean; error?: string }>` — caller owns the network request and token storage.
- **Focus**: `useEffect` focuses the password input on mount, and re-focuses it after a failed attempt.
- **Submit**: blocks empty password with `"Please enter a password"`; sets `submitting` during the request; on failure shows the returned `error` or fallback `"Authentication failed"`, clears the password field, and re-focuses. Button label toggles `Login` → `Authenticating...`.
- **State**: local `password`, `error`, `submitting`; no Zustand coupling.
- Header reads `AI Agent Session Center` / `Enter password to continue`.

### useAuth hook (`useAuth.ts`)
- **Token storage is now a legacy/best-effort path, not the real session.** `getStoredToken` / `storeToken` / `clearToken` wrap `localStorage['auth_token']` (`TOKEN_KEY`) in try/catch so storage failures degrade gracefully, and the `Authorization` header is still sent when a token happens to be stored — but `/api/auth/login` and `/api/auth/refresh` set the session ONLY as an HttpOnly `auth_token` cookie and respond `{ success, expiresIn }` with **no `token` field**, so under the current server nothing ever actually reaches `localStorage` in normal operation. `data.token` is merely *tolerated* if a deployment happens to return one.
- **Status check on mount** (`checkAuth`): polls `GET /api/auth/status` with retry — `MAX_RETRIES = 8`, `RETRY_DELAY_MS = 800`, per-request `AbortController` timeout of `3000ms`. If `!passwordRequired || authenticated` → authenticated (no login needed); otherwise `needsLogin = true`. All retries exhausted → show login.
- **Silent refresh is cookie-driven** (`scheduleRefresh` / `doRefreshToken`): schedules `POST /api/auth/refresh` (`credentials: 'same-origin'`, so the HttpOnly cookie rides along automatically) to run `REFRESH_BUFFER_MS = 5 * 60 * 1000` (5 min) before expiry, clamped to a minimum of `30_000ms`. Success is `res.ok && data.success` — a returned `data.token` is stored if present but is not required; state re-reads `getStoredToken()` and re-schedules for a hardcoded `3600`s. On failure (server genuinely rejects the refresh) it clears the token and forces re-login. After login the refresh is scheduled from the server-provided `expiresIn`; after a passing status check it is hardcoded to `3600`.
  - **Why cookie-driven, not token-gated (fixed bug):** this used to `return null` when `getStoredToken()` was empty and only counted a refresh as successful if the response carried `data.token` — but neither condition can ever hold, since login never puts a token in `localStorage` to begin with. The refresh was therefore never even scheduled/sent, the ~1h token TTL (`REFRESH_BUFFER_MS` before it) always expired, and the next status check bounced the user back to the login screen — the "periodic password prompt every ~55 minutes" bug. The fix authenticates the same way the rest of the app already does (the same-origin cookie), rather than requiring a JS-readable copy of a value that's HttpOnly precisely so JS *can't* read it.
- **login**: `POST /api/auth/login` with `{ password }`; on success stores `data.token` (if present — see above, in practice normally absent), clears `needsLogin`, and schedules refresh from `data.expiresIn`. Network failure returns `{ success: false, error: 'Connection error -- is the server running?' }`.
- **logout**: clears the refresh timer, clears the local token, fires `POST /api/auth/logout` (to clear the server cookie), and sets `needsLogin = true`.
- **WS auth-failure bridge**: listens for the `ws-auth-failed` DOM `CustomEvent` (dispatched by `wsClient` on WebSocket close code `4001`); on receipt it clears the timer + token and forces re-login.

### Helpers (`authFetch` / `getAuthToken`)
- `authFetch(input, init?)`: if a stored token exists and the request has no `Authorization` header yet, adds `Authorization: Bearer <token>`; otherwise passes through untouched. Used by HistoryView for protected fetches.
- `getAuthToken()`: returns the stored token (or `null`). Currently has **no in-app consumer** (only covered by `useAuth.test.ts`) — the WS handshake token is prop-drilled from `useAuth`'s returned `token` through `Dashboard` → `useWebSocket(token)` → `wsClient` (`url.searchParams.set('token', this.options.token)`), not read from this helper.

## Dependencies & Connections

### Depends On
- [Authentication](../server/authentication.md) — server-side password check, token issuance/refresh/revoke, `authMiddleware`, status endpoint, rate limiting
- [WebSocket Client](./websocket-client.md) — dispatches the `ws-auth-failed` event on close code `4001`; consumes the token via its `options.token`

### Depended On By
- [Views & Routing](./views-routing.md) — `App` boot flow: `AuthGate` calls `useAuth()` and renders `<LoginScreen>` when `needsLogin`, else `<Dashboard token={token} />`
- HistoryView and other protected fetches via `authFetch`
- [WebSocket Client](./websocket-client.md) — WS handshake attaches the token from `useAuth()` (prop-drilled via `Dashboard` → `useWebSocket(token)`) to the connection URL

### Shared Resources
- `localStorage['auth_token']` — the bearer token, shared across `authFetch`, `getAuthToken`, and the `useAuth` hook
- `ws-auth-failed` DOM CustomEvent — cross-module signal from `wsClient` to `useAuth`

## Change Risks
- `AuthGate` is the **only** mount point for both `LoginScreen` and `useAuth`. Reverting it to a stub that renders `<Dashboard token={null} />` re-bricks password-protected servers: the WS handshake closes with `4001`, reconnect gives up, and there is no login UI to recover through.
- **The real session is the HttpOnly cookie, not `localStorage`.** `/api/auth/login` and `/api/auth/refresh` return no `token` field under the current server, so `getStoredToken()` is normally `null` and `authFetch`'s `Authorization` header normally never attaches — same-origin requests authenticate via the cookie alone. Anything reading/writing `auth_token` directly still couples to that key (renaming it breaks `authFetch`/`getAuthToken`/the hook simultaneously), but don't assume a non-null `token` from `useAuth()` — reintroducing that assumption anywhere is what caused the "periodic password prompt" bug (see Implementation).
- **Re-gating `doRefreshToken` on a stored token** (`if (!token) return null`) reintroduces the periodic-re-login bug: login never populates `localStorage`, so the refresh would never even be attempted and the ~1h cookie TTL would always lapse first. The refresh loop reads `expiresIn` from `/api/auth/login`'s response only for the *first* scheduling; the recurring reschedule inside `doRefreshToken`'s own success path is hardcoded to `3600`s and does not read `/api/auth/refresh`'s response for it.
- Dropping the auto-focus / re-focus effect hurts keyboard-only login flow.
- Changing the `onLogin` return shape (`{ success, error? }`) silently breaks error display.
- The `ws-auth-failed` event name is a contract between `wsClient` and `useAuth`; renaming one side without the other leaves stale tokens after a WS auth failure.
