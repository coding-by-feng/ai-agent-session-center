# Authentication System

## Function
Optional password-based authentication for the dashboard, protecting API endpoints and WebSocket connections.

## Purpose
Prevents unauthorized access when the dashboard is exposed on a network (not just localhost).

## Source Files
| File | Role |
|------|------|
| `server/authManager.ts` (~11KB, 326 lines) | Password hashing, token management, middleware |
| `server/serverConfig.ts` (~1KB) | Reads data/server-config.json (or APP_USER_DATA/server-config.json in Electron); provides passwordHash and other server defaults |
| `server/index.ts` | Auth endpoints (`/api/auth/status\|login\|refresh\|logout`, index.ts:106-173), `Set-Cookie` construction, WS origin + token gate (index.ts:207-236), `startTokenCleanup()` wiring, public-bind security warning |

## Remote access requires a password (Aug 2026)

`authMiddleware` (`server/authManager.ts`) and the WebSocket gate
(`server/index.ts`) are **two-dimensional**: they branch on origin as well as
on whether a password is configured.

| Origin | Password configured | Result |
|--------|---------------------|--------|
| loopback | no  | **allow** — the Electron app and a local browser tab stay password-free |
| loopback | yes | validate token (401 if bad) |
| remote   | no  | **403** `REMOTE_PASSWORD_REQUIRED` / WS `close(4003)` |
| remote   | yes | validate token (401 if bad) |

Before this, both gates opened with `if (!isPasswordEnabled()) → allow`, so an
install with no `passwordHash` — the default — served every `/api` route and
the full session WebSocket to anyone who could reach the port: session
content, PTY write, session kill. The server binds `0.0.0.0` and printed a
`SECURITY: ... DANGEROUS` warning at startup, then answered the request
anyway. That warning is now an informational notice, because the claim it made
("anyone on the network has full access") is no longer true — leaving a false
alarm in place trains the reader to ignore the next real one.

Three rules hold this up:

1. **Use `isLoopbackAddress`** (`presenceManager.ts`) — the same predicate
   already backing the 🖥/📱 device split — never a second hand-rolled string
   compare. It normalises `::ffff:` and accepts `127.0.0.1` / `::1`.
   (`localhostOnlyMiddleware` still carries its own inline copy; worth
   unifying.)
2. **An unknown/empty address fails CLOSED**, i.e. is treated as remote. For a
   security gate that is the correct direction. It is also why a test fixture
   built as `{ headers: {} }` — no address at all — is now rejected: that
   fixture gained a loopback address rather than the rule being loosened.
3. **The no-password refusal is 403, not 401.** A 401 invites a login prompt,
   and no credential exists that would satisfy it because none has been
   configured. The body carries an actionable message naming
   `npm run set-password`.

`GET /api/config` additionally returns `passwordEnabled` (the boolean only,
never the hash) so `DevicePresenceChip` can explain *why* a phone cannot
connect, instead of showing a stale warning after a password has been set.

### Setting the password: `npm run set-password`, never `npm run setup`

`scripts/set-password.mjs` is the supported way to set or clear the password,
and every user-facing message names it. It exists because **the setup wizard
writes to a file a packaged app never reads**: `hooks/setup-wizard.js`
hard-codes `<repo>/data/server-config.json`, while a packaged Electron app
reads `$APP_USER_DATA/server-config.json` (`serverConfig.ts`). Directing an
installed-app user at the wizard makes them set a password that has no effect,
which presents as "the password doesn't work" with nothing logged anywhere.

The script resolves the same path the app does, and writes the repo config too
when one exists, so a dev `npm start` and the installed app cannot disagree
about whether a password is set. Three properties are load-bearing:

- **The password is prompted, never an argument.** A password in `argv` lands
  in shell history and in `ps` output for every user on the machine.
- **The non-TTY path must hold ONE readline for the whole run.** Creating and
  closing one per prompt ends `process.stdin`, so the confirm read never
  resolves — the script prints `Confirm:` and exits having written nothing,
  with no error. That was a real defect caught only by an end-to-end run.
- **Write-to-temp + `renameSync`, with the temp file created `mode 0o600`.**
  `rename` is atomic, so a crash cannot truncate the config and take the user's
  port/CLI settings with it; the mode is set before the file holds the hash and
  is preserved across the rename.

`--status` reports both config paths; `--clear` removes the password (which
returns the server to localhost-only, since remote access is then refused).

Covered by `test/authRemoteGate.test.ts` — both axes, including IPv4-mapped
(`::ffff:192.168.x.x`) forms and the fail-closed case.

## Implementation

### Disabled by Default
- `isPasswordEnabled()` returns `Boolean(config.passwordHash)` — auth is fully off until a password hash is set in server-config.json
- When disabled: `authMiddleware` calls `next()` immediately, `/api/auth/status` reports `authenticated: true`, login/refresh return `{ success: true }`, and the WebSocket skips token validation

### Public-Bind Warning
- On startup (`index.ts` onReady, ~line 336): if auth is enabled it logs `Password protection ENABLED -- login required (1h token TTL)`.
- If auth is **disabled** AND the listen address is `0.0.0.0` or `::`, it emits a boxed `log.info` block stating that remote devices are BLOCKED (403 / ws 4003), that localhost retains full access, and naming `npm run set-password`. It warns only — it does not refuse to bind, and no longer needs to: the remote gate above is what actually closes the §Purpose scenario, so this is now informational rather than the sole guard. (It was previously a `log.error` reading "Server is publicly accessible WITHOUT a password!", which became false once the gate landed — a false alarm left in place trains the user to ignore a real one.)

### Password Hashing
- `hashPassword()`: crypto.scryptSync, salt=randomBytes(16).hex, hash=scryptSync(password, salt, SCRYPT_KEYLEN=64).hex
- Stored as "salt:hash" (both hex)
- **`hashPassword()` is exported but has no server-side caller** — the stored hash is written by the setup wizard, which carries a **duplicate implementation** (`hooks/setup-wizard.js:60`) because it runs before the TS server loads. The two MUST stay algorithm-identical (scrypt, 16-byte hex salt, keylen 64, `salt:hash`) or every existing password stops verifying. `verifyPassword()` is the live read path (`index.ts:135`).

### Verification
- `verifyPassword()` uses crypto.timingSafeEqual (prevents timing attacks); returns false if stored value is missing/has no `:` or length mismatch
- `validatePasswordComplexity()`: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special character (`[^A-Za-z0-9]`); returns `{ valid, errors[] }`. **Currently an exported helper with no callers** — the live paths validate independently against the same rules: `hooks/setup-wizard.js` (`validatePassword`, its own inline copy) and `ConfigureStep.tsx:23` (`passwordSchema` zod chain). Rule changes must be made in all three or the wizard and the UI drift apart.

### Login Rate Limiting
- `LOGIN_MAX_ATTEMPTS = 5` per `LOGIN_WINDOW_MS = 15 min` per IP, tracked in `loginAttempts` Map<ip, {count, windowStart}>
- `checkLoginRateLimit(ip)` returns remaining lockout seconds (0 if not locked); `recordLoginAttempt(ip)` on failed login; `clearLoginAttempts(ip)` on success
- `/api/auth/login` returns 429 with `retryAfter` (seconds) when locked out

### Auth Endpoints (defined in `server/index.ts`, all bypass `authMiddleware`)
- `GET /api/auth/status` → `{ passwordRequired, authenticated }`
- `POST /api/auth/login` → verifies password, sets cookie, returns `{ success, expiresIn }`; 401 wrong password, 400 missing, 429 rate-limited
- `POST /api/auth/refresh` → rotates token via `refreshToken()`, resets cookie; 401 if expired/invalid
- `POST /api/auth/logout` → `removeToken()` + clears cookie (Max-Age=0)

### Token Management
- `createToken()`: 32 random bytes hex (64 chars), TTL `TOKEN_TTL_MS = 1h`
- Stored in-memory `tokens` Map<token, {createdAt}>
- `refreshToken(oldToken)` — validates then revokes old, issues new (returns null if invalid/expired)
- `getTokenTTL(token)` — remaining TTL in milliseconds (0 if invalid)
- `removeToken(token)` — deletes a token (logout)
- Expired tokens removed lazily on `validateToken()` + periodic cleanup every 15min (also prunes expired login buckets)

### Token Extraction Priority (`extractToken()`)
1. Cookie `auth_token` (via `parseCookieToken()`)
2. `Authorization: Bearer <token>` header
3. `?token=` query param (used by WebSocket only)

### Protected Routes
- `app.use('/api', authMiddleware, apiRouter)` — all `/api/*` except the unprotected `/api/auth/*` and `/api/hooks` (which are registered before the auth middleware)
- `authMiddleware` returns 401 `{ error: 'Unauthorized' }` when token invalid and auth is enabled

### WebSocket Authentication (wired in `server/index.ts`)
- Origin validation first: foreign-origin or unparseable-origin connections rejected with code `4003` (CSWSH protection)
- If password enabled: token taken from cookie (preferred) else `extractToken()`; invalid token rejected with code `4001` "Unauthorized"

### Cookie Settings
- `auth_token=<token>; HttpOnly; SameSite=Strict; Path=/; Max-Age=TOKEN_TTL_SECONDS (3600)`
- `; Secure` appended when the request is HTTPS (`req.secure` or `x-forwarded-proto: https`)
- `TOKEN_TTL_SECONDS = TOKEN_TTL_MS / 1000` exported for the Max-Age value

### Unprotected Endpoints
- `/api/auth/*` (status/login/logout/refresh)
- `/api/hooks` (hooks must work without login, restricted to localhost via `localhostOnlyMiddleware` + `hookRateLimitMiddleware`)
- Static files (Vite-built SPA) and the SPA fallback route

### Export Inventory (`authManager.ts`)
Each is described in its own section above — this is the complete list, not a re-description:
`hashPassword`, `verifyPassword`, `validatePasswordComplexity`, `createToken`, `validateToken`, `refreshToken`, `getTokenTTL`, `removeToken`, `isPasswordEnabled`, `parseCookieToken`, `extractToken`, `authMiddleware`, `localhostOnlyMiddleware`, `checkLoginRateLimit`, `recordLoginAttempt`, `clearLoginAttempts`, `startTokenCleanup`, `stopTokenCleanup`, `TOKEN_TTL_SECONDS`, `REMOTE_REQUIRES_PASSWORD` (the actionable message returned on the no-password remote 403, naming `npm run set-password`), `PasswordValidation` (interface).

### Localhost Restriction
- `localhostOnlyMiddleware` blocks non-loopback IPs from hook endpoints (403 `{ error: 'Hook endpoint restricted to localhost' }`)
- Allows 127.0.0.1, ::1, ::ffff:127.0.0.1, localhost

## Dependencies & Connections

### Depends On
- `server/serverConfig.ts` — reads passwordHash from config

### Depended On By
- [API Endpoints](./api-endpoints.md) — auth middleware on all protected routes
- [WebSocket Manager](./websocket-manager.md) — token validation on WS connection (wired in `server/index.ts`)
- [Auth UI](../frontend/auth-ui.md) — login screen + `useAuth` hook (login/logout/refresh/token management)

### Shared Resources
- Token Map
- server-config.json

## Change Risks
- Breaking auth middleware locks out all users or (worse) opens all endpoints
- The WS handler prefers the cookie then falls back to `extractToken()` (query param); removing the `?token=` query branch breaks browser WS auth that can't send the cookie
- Auth is off entirely when `config.passwordHash` is null — any check that assumes auth is always on is wrong
- Modifying cookie settings affects cross-site behavior; the `Secure` flag is only added over HTTPS
- `/api/auth/*` and `/api/hooks` must stay registered before `authMiddleware`, or they become inaccessible


## Per-session remote visibility (deny by default)

The password gate decides *who may connect*. This decides *what they see once
connected*: a session reaches a device other than the host machine only if it
has been explicitly shared. Localhost is unaffected — the desktop app sees
everything, always.

`server/sessionVisibility.ts` is the single rule
(`canSeeSession(isLocalClient, session)`), kept pure so both the HTTP and
WebSocket boundaries can use it without importing each other.

### The flag is `remoteVisible`, not `hidden`

Deliberate inversion. A `hidden` flag reads as `false` on every row written
before the feature existed, which would expose the entire backlog on the day it
shipped. Storing "may be seen" makes the absent/NULL state the safe one, so a
pre-existing session and a brand-new one are both hidden until someone acts.
The SQLite column follows the same logic: `remote_visible INTEGER DEFAULT 0`.

### Six paths, not one

Filtering the session list alone yields a feature that only appears to work:

| Path | Why it leaks |
|---|---|
| WS snapshot on connect | Largest single leak — every session's full state |
| `SESSION_UPDATE` broadcast | Without it, the next status change re-adds the card |
| `GET /api/sessions` | The list itself |
| 17 × `/sessions/:id/*` | Includes `kill`, `fork`, `resume` — *control*, not just reads |
| **`TERMINAL_SUBSCRIBE`** | Keyed by `terminalId`, **not** session id — streams live PTY output of a session whose card is invisible |
| **`/db/sessions`, `/db/search`, `/db/prompts`** | A **second store**: hiding a live session does nothing for its recorded prompt text |

The REST side is gated by one `router.use('/sessions/:id', requireVisibleSession)`
rather than 17 per-route checks — a per-site check is only as good as the newest
route, and the routes here can destroy a session.

### Rules that hold it up

1. **A hidden session returns 404, not 403.** A remote client must not be able
   to distinguish "no such session" from "hidden from you", or the status code
   becomes an oracle for enumerating session ids.
2. **An unresolvable subject fails closed.** A terminal with no owning session
   (an ops shell, or a PTY whose first hook has not landed) is denied to remote
   clients. An **archived** session has no in-memory record to carry the flag
   and so resolves to hidden — deliberately: it can no longer be opted in
   through the UI, so treating "no live record" as permissive would create a
   growing body of permanently readable history that no control can revoke.
3. **`PUT /sessions/:id/remote-visible` is localhost-only** (403 otherwise).
   Anything that can reach the port must not be able to grant itself access.

`isLoopbackAddress` (`presenceManager.ts`) is the shared predicate for "this
machine" — the same one behind the auth gate and the 🖥/📱 device split. Never
add a second address comparison.

### UI

📡 **HOST ONLY** / **SHARED** in `SessionControlBar`. The WS snapshot also
carries `hiddenCount` so a remote device can report "18 hidden" rather than
appearing broken with a near-empty dashboard.

Covered by `test/sessionVisibility.test.ts` (14 tests), including the
permissive-default regression: flipping `=== true` to `!== false` turns 5 red.


## The periodic re-login (fixed Aug 2026)

**Symptom:** the dashboard demanded the password again roughly every hour.

**Cause:** the silent refresh was gated, twice over, on a token that can never
exist. The session lives in an `HttpOnly` cookie — `/api/auth/login` sets it
via `Set-Cookie` and responds `{ success, expiresIn }` with **no `token`
field** — so `getStoredToken()` is always `null`. Two places required one
anyway:

1. `checkAuth` only scheduled the refresh when `getStoredToken()` was truthy,
   so **the refresh timer was never armed at all**.
2. `doRefreshToken` returned early on `if (!token) return null`, and then
   only counted a refresh as successful when the response carried
   `data.token` — which the server never sends.

`TOKEN_TTL_MS` is an **absolute** lifetime, not an idle timeout: `validateToken`
compares a fixed `createdAt` and never slides it. So the token expired exactly
one hour after login regardless of activity, and the next `/api/auth/status`
returned `authenticated: false` → login screen.

**Fix:** authenticate the refresh the way the rest of the app already does —
via the cookie. `doRefreshToken` sends the request unconditionally
(`credentials: 'same-origin'`), and treats `res.ok && data.success` as success;
`Authorization` and `data.token` are still honoured when present but no longer
required. The scheduling gate dropped its `getStoredToken()` condition.

**Why not "return the token in the response body" instead:** that was the first
plan, and it is the wrong half to change. The cookie is `HttpOnly` precisely so
the token is unreachable from JS; handing it back in the body would undo that
for no benefit. The WebSocket already appends `?token=` only when one exists —
it has been `null` all along and the handshake authenticates by cookie — which
confirms cookie-only is the design the app was already running on.

Covered by `src/hooks/useAuth.test.ts`, which drives the real hook through its
real timer (the "was a refresh scheduled at all" half is only observable from
outside). Reverting either half turns 2 tests red, and the genuine-rejection
path is asserted separately so an expired session still forces a re-login.
