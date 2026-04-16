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

### Password Hashing
- crypto.scryptSync, salt=randomBytes(16).hex, hash=scrypt(password, salt, 64).hex
- Stored as "salt:hash"

### Verification
- crypto.timingSafeEqual (prevents timing attacks)
- Password complexity: min 8 chars, at least 1 uppercase, 1 lowercase, 1 digit, 1 special character

### Login Rate Limiting
- 5 attempts per 15 minutes per IP
- Returns remaining lockout seconds when rate limited
- Cleared on successful login

### Token Management
- Token: 32 random bytes hex (64 chars), TTL 1h
- Stored in-memory Map<token, {createdAt}>
- refreshToken(oldToken) — revokes old, issues new (returns null if invalid/expired)
- getTokenTTL(token) — remaining TTL in milliseconds
- Expired tokens: removed lazily on validateToken() + periodic cleanup every 15min

### Token Extraction Priority
1. Cookie auth_token
2. Authorization Bearer header
3. ?token= query param

### Protected Routes
- All /api/* except /api/auth/* and /api/hooks

### WebSocket Authentication
- Token validated on connection, rejected with code 4001

### Cookie Settings
- HttpOnly; SameSite=Strict; Path=/; Max-Age=3600 (1h, matches TOKEN_TTL_SECONDS)

### Unprotected Endpoints
- /api/auth/* (login/logout/status)
- /api/hooks (hooks must work without login, restricted to localhost via localhostOnlyMiddleware)
- Static files

### Additional Exports
- `startTokenCleanup()` / `stopTokenCleanup()` — manage the periodic expired-token cleanup timer
- `validatePasswordComplexity()` — validates password meets complexity requirements
- `parseCookieToken()` — extracts auth_token from Cookie header
- `extractToken()` — extracts token from cookie, Authorization header, or query param (in priority order)

### Localhost Restriction
- localhostOnlyMiddleware blocks non-loopback IPs from hook endpoints
- Allows 127.0.0.1, ::1, ::ffff:127.0.0.1, localhost

## Dependencies & Connections

### Depends On
- `server/serverConfig.ts` — reads passwordHash from config

### Depended On By
- [API Endpoints](./api-endpoints.md) — auth middleware on all protected routes
- [WebSocket Manager](./websocket-manager.md) — token validation on WS connection
- Frontend useAuth hook — login/logout/token management

### Shared Resources
- Token Map
- server-config.json

## Change Risks
- Breaking auth middleware locks out all users or (worse) opens all endpoints
- Changing token extraction priority can break WebSocket auth (which uses query param)
- Modifying cookie settings affects cross-site behavior
