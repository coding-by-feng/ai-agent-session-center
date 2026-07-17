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
| `src/hooks/useAuth.test.ts` | Unit tests for `authFetch` / `getAuthToken` |
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
- **Token storage**: persisted in `localStorage` under key `auth_token` (`TOKEN_KEY`). `getStoredToken` / `storeToken` / `clearToken` wrap it in try/catch so storage failures degrade gracefully. (The *server*-side token registry is in-memory; the server also sets an HttpOnly `auth_token` cookie — see authentication.md.)
- **Status check on mount** (`checkAuth`): polls `GET /api/auth/status` with retry — `MAX_RETRIES = 8`, `RETRY_DELAY_MS = 800`, per-request `AbortController` timeout of `3000ms`. If `!passwordRequired || authenticated` → authenticated (no login needed); otherwise `needsLogin = true`. All retries exhausted → show login.
- **Silent refresh** (`scheduleRefresh` / `doRefreshToken`): schedules `POST /api/auth/refresh` to run `REFRESH_BUFFER_MS = 5 * 60 * 1000` (5 min) before expiry, clamped to a minimum of `30_000ms`. On success stores the new token and re-schedules for `3600`s; on failure clears the token and forces re-login. After login the refresh is scheduled from the server-provided `expiresIn`; after a passing status check it is hardcoded to `3600`.
- **login**: `POST /api/auth/login` with `{ password }`; on success stores `data.token` (if present), clears `needsLogin`, and schedules refresh from `data.expiresIn`. Network failure returns `{ success: false, error: 'Connection error -- is the server running?' }`.
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
- Token lives in `localStorage`, not memory — anything reading/writing `auth_token` directly couples to that key; changing the key name breaks `authFetch`, `getAuthToken`, and the hook simultaneously.
- The refresh loop depends on the server returning `expiresIn` (seconds) from `/api/auth/login` and `/api/auth/refresh`; dropping it leaves login working but disables silent refresh.
- Dropping the auto-focus / re-focus effect hurts keyboard-only login flow.
- Changing the `onLogin` return shape (`{ success, error? }`) silently breaks error display.
- The `ws-auth-failed` event name is a contract between `wsClient` and `useAuth`; renaming one side without the other leaves stale tokens after a WS auth failure.
