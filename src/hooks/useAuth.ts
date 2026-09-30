import { useState, useEffect, useCallback, useRef } from 'react';

const TOKEN_KEY = 'auth_token';

// Refresh token 5 minutes before expiry
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface AuthState {
  token: string | null;
  loading: boolean;
  needsLogin: boolean;
}

interface UseAuthReturn extends AuthState {
  login: (password: string) => Promise<{ success: boolean; error?: string }>;
  logout: () => void;
}

function getStoredToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function storeToken(token: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, token);
  } catch {
    // Ignore storage errors
  }
}

function clearToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Ignore storage errors
  }
}

export function authFetch(
  input: RequestInfo | URL,
  init?: RequestInit,
): Promise<Response> {
  const token = getStoredToken();
  if (token) {
    const headers = new Headers(init?.headers);
    if (!headers.has('Authorization')) {
      headers.set('Authorization', `Bearer ${token}`);
    }
    return fetch(input, { ...init, headers });
  }
  return fetch(input, init);
}

export function getAuthToken(): string | null {
  return getStoredToken();
}

/**
 * Silently refresh the auth session. Returns true when the server accepted it.
 *
 * ## Why this is cookie-driven and returns a boolean
 *
 * This used to require a localStorage token twice over — it returned early on
 * `if (!token) return null`, and then only counted the refresh as successful
 * if the response carried `data.token`. Neither condition can ever hold:
 * `/api/auth/login` sets the token ONLY as an HttpOnly cookie and responds
 * `{ success, expiresIn }` with no `token` field, so nothing ever reaches
 * localStorage. The refresh therefore bailed before even sending the request,
 * the caller read that as "refresh failed", and forced a re-login — roughly
 * every 55 minutes (TOKEN_TTL_MS 1h, minus the 5-minute buffer). That was the
 * periodic password prompt.
 *
 * The fix is to authenticate the way the rest of the app already does: the
 * HttpOnly cookie is sent automatically on this same-origin request, and the
 * server reads it first (`extractToken` prefers the cookie over the
 * Authorization header). Requiring a JS-readable copy would have meant
 * returning the token in the response body, which defeats the point of
 * HttpOnly — the cookie exists precisely so a token is not reachable from JS.
 *
 * The `Authorization` header is still sent when a token happens to be stored,
 * so a deployment that does return one keeps working; and `data.token` is
 * still honoured if present. Neither is required.
 */
async function doRefreshToken(): Promise<boolean> {
  try {
    const token = getStoredToken();
    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      // Explicit, though this is the same-origin default: the whole mechanism
      // depends on the auth_token cookie riding along with this request.
      credentials: 'same-origin',
      headers: {
        'Content-Type': 'application/json',
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
    });
    const data = await res.json();
    if (!res.ok || !data.success) return false;
    // Tolerated, not required — see above.
    if (data.token) storeToken(data.token);
    return true;
  } catch {
    return false;
  }
}

export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    token: getStoredToken(),
    loading: true,
    needsLogin: false,
  });

  const refreshTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** Schedule a token refresh `expiresIn` seconds from now (minus buffer). */
  const scheduleRefresh = useCallback((expiresIn: number) => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);

    // Refresh 5 minutes before expiry, minimum 30 seconds from now
    const delayMs = Math.max((expiresIn * 1000) - REFRESH_BUFFER_MS, 30_000);

    refreshTimerRef.current = setTimeout(async () => {
      const ok = await doRefreshToken();
      if (ok) {
        // The session is renewed via the rotated HttpOnly cookie. `token` is
        // only updated when the server actually returned one — reading it back
        // from storage keeps state in step without inventing a value.
        setState((prev) => ({ ...prev, token: getStoredToken() }));
        // Server returns expiresIn in seconds (3600 for 1h)
        scheduleRefresh(3600);
      } else {
        // Refresh genuinely rejected — force re-login.
        clearToken();
        setState({ token: null, loading: false, needsLogin: true });
      }
    }, delayMs);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      const MAX_RETRIES = 8;
      const RETRY_DELAY_MS = 800;

      for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
        if (cancelled) return;
        try {
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 3000);
          let res: Response;
          try {
            res = await fetch('/api/auth/status', { signal: controller.signal });
          } finally {
            clearTimeout(timeout);
          }
          const data = await res.json();

          if (cancelled) return;

          if (!data.passwordRequired || data.authenticated) {
            setState({ token: getStoredToken(), loading: false, needsLogin: false });
            // NOT gated on getStoredToken(): the session lives in an HttpOnly
            // cookie that JS cannot read, so a stored token never exists and
            // this condition was always false — the refresh was never even
            // SCHEDULED. The token then hit its absolute 1-hour TTL
            // (validateToken compares a fixed createdAt and never slides it),
            // and the next status check returned authenticated:false, which is
            // the password prompt the user saw come back on a cycle.
            if (data.passwordRequired && data.authenticated) {
              scheduleRefresh(3600);
            }
          } else {
            setState({ token: null, loading: false, needsLogin: true });
          }
          return; // success — stop retrying
        } catch {
          if (cancelled) return;
          if (attempt < MAX_RETRIES - 1) {
            await new Promise((r) => setTimeout(r, RETRY_DELAY_MS));
          } else {
            // All retries exhausted — show login screen
            setState({ token: null, loading: false, needsLogin: true });
          }
        }
      }
    }

    checkAuth();

    // Listen for WS auth failures
    function handleAuthFailed() {
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      clearToken();
      setState({ token: null, loading: false, needsLogin: true });
    }
    document.addEventListener('ws-auth-failed', handleAuthFailed);

    return () => {
      cancelled = true;
      if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
      document.removeEventListener('ws-auth-failed', handleAuthFailed);
    };
  }, [scheduleRefresh]);

  const login = useCallback(
    async (password: string): Promise<{ success: boolean; error?: string }> => {
      try {
        const res = await fetch('/api/auth/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password }),
        });
        const data = await res.json();

        if (res.ok && data.success) {
          if (data.token) {
            storeToken(data.token);
          }
          setState({ token: data.token ?? null, loading: false, needsLogin: false });
          // Schedule refresh based on server-provided TTL
          if (data.expiresIn) {
            scheduleRefresh(data.expiresIn);
          }
          return { success: true };
        }
        return { success: false, error: data.error || 'Authentication failed' };
      } catch {
        return { success: false, error: 'Connection error -- is the server running?' };
      }
    },
    [scheduleRefresh],
  );

  const logout = useCallback(() => {
    if (refreshTimerRef.current) clearTimeout(refreshTimerRef.current);
    clearToken();
    // Also tell server to clear the cookie
    fetch('/api/auth/logout', { method: 'POST' }).catch(() => {});
    setState({ token: null, loading: false, needsLogin: true });
  }, []);

  return { ...state, login, logout };
}
