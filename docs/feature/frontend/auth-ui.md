# Auth UI (Login Screen)

## Function
Single-field password login screen rendered before the main app when the server requires auth. Autofocuses the input, submits via `onLogin`, surfaces errors inline.

## Purpose
The server-side auth layer (see [authentication.md](../server/authentication.md)) protects all API/WS traffic with a password and in-memory tokens. This component is the frontend gate that gathers that password on boot.

## Source Files
| File | Role |
|------|------|
| `src/components/auth/LoginScreen.tsx` | Login form, submit handler, error display |
| `src/hooks/useAuth.ts` | Token management, login/logout, auth state |
| `src/hooks/useAuth.test.ts` | Unit tests |
| `src/styles/modules/Login.module.css` | Form styling |

## Implementation
- **Props**: `onLogin(password) → Promise<{success, error?}>` — caller owns the network request and token storage.
- **Focus**: `useEffect` focuses the password input on mount.
- **Submit**: blocks empty password, sets `submitting` during request, shows returned `error` or fallback `"Authentication failed"`.
- **State**: local `password`, `error`, `submitting`; no Zustand coupling.
- **Token lifetime**: server-side in-memory only (no persistent token storage — see known-issues.md); frontend stores the token in memory via `useAuth` and attaches it to HTTP/WS requests.

## Dependencies & Connections

### Depends On
- [Authentication](../server/authentication.md) — server-side password check, token issuance, middleware

### Depended On By
- App boot flow — rendered instead of main app when unauthenticated
- All API calls and WebSocket handshakes via `useAuth` token

### Shared Resources
- Password prompt only; token lives in `useAuth` hook state

## Change Risks
- Dropping the auto-focus effect hurts keyboard-only login flow
- Persisting the token to localStorage without XSS hardening would break the current security posture
- Changing `onLogin` contract (shape of return value) silently breaks error display
