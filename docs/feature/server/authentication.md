# Authentication System

## Function
Optional password-based authentication for the dashboard, protecting API endpoints and WebSocket connections.

## Purpose
Prevents unauthorized access when the dashboard is exposed on a network (not just localhost).

## Source Files
| File | Role |
|------|------|
| `server/authManager.ts` (~9KB) | Password hashing, token management, middleware |
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
`hashPassword`, `verifyPassword`, `validatePasswordComplexity`, `createToken`, `validateToken`, `refreshToken`, `getTokenTTL`, `removeToken`, `isPasswordEnabled`, `parseCookieToken`, `extractToken`, `authMiddleware`, `localhostOnlyMiddleware`, `checkLoginRateLimit`, `recordLoginAttempt`, `clearLoginAttempts`, `startTokenCleanup`, `stopTokenCleanup`, `TOKEN_TTL_SECONDS`, `PasswordValidation` (interface).

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
