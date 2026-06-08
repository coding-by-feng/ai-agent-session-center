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

## Implementation

### Disabled by Default
- `isPasswordEnabled()` returns `Boolean(config.passwordHash)` — auth is fully off until a password hash is set in server-config.json
- When disabled: `authMiddleware` calls `next()` immediately, `/api/auth/status` reports `authenticated: true`, login/refresh return `{ success: true }`, and the WebSocket skips token validation

### Password Hashing
- `hashPassword()`: crypto.scryptSync, salt=randomBytes(16).hex, hash=scryptSync(password, salt, SCRYPT_KEYLEN=64).hex
- Stored as "salt:hash" (both hex)

### Verification
- `verifyPassword()` uses crypto.timingSafeEqual (prevents timing attacks); returns false if stored value is missing/has no `:` or length mismatch
- `validatePasswordComplexity()`: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special character (`[^A-Za-z0-9]`); returns `{ valid, errors[] }`

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

### Additional Exports
- `startTokenCleanup()` / `stopTokenCleanup()` — manage the periodic expired-token cleanup timer (every 15min)
- `hashPassword()` / `verifyPassword()` — scrypt hash + timing-safe verify
- `createToken()` / `removeToken()` / `getTokenTTL()` — token lifecycle helpers
- `isPasswordEnabled()` — true when `config.passwordHash` is set
- `validatePasswordComplexity()` — validates password meets complexity requirements
- `parseCookieToken()` — extracts `auth_token` from Cookie header
- `extractToken()` — extracts token from cookie, Authorization header, or query param (in priority order)
- `TOKEN_TTL_SECONDS` constant (cookie Max-Age)

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
