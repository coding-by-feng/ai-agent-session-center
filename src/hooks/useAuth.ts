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
 * Silently refresh the auth token. Returns the new token or null on failure.
 */
async function doRefreshToken(): Promise<string | null> {
  try {
    const token = getStoredToken();
    if (!token) return null;

    const res = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
    });
    const data = await res.json();
    if (res.ok && data.success && data.token) {
      storeToken(data.token);
      return data.token;
    }
    return null;
  } catch {
    return null;
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
      const newToken = await doRefreshToken();
      if (newToken) {
        setState((prev) => ({ ...prev, token: newToken }));
        // Server returns expiresIn in seconds (3600 for 1h)
        scheduleRefresh(3600);
      } else {
        // Refresh failed — force re-login
        clearToken();
        setState({ token: null, loading: false, needsLogin: true });
      }
    }, delayMs);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();

        if (cancelled) return;

        if (!data.passwordRequired || data.authenticated) {
          setState({ token: getStoredToken(), loading: false, needsLogin: false });
          // If authenticated with a token, schedule auto-refresh
          if (data.passwordRequired && data.authenticated && getStoredToken()) {
            scheduleRefresh(3600); // 1h token TTL
          }
        } else {
          setState({ token: null, loading: false, needsLogin: true });
        }
      } catch {
        if (!cancelled) {
          setState({ token: null, loading: false, needsLogin: true });
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
