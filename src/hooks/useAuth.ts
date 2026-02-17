import { useState, useEffect, useCallback } from 'react';

const TOKEN_KEY = 'auth_token';

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

export function useAuth(): UseAuthReturn {
  const [state, setState] = useState<AuthState>({
    token: getStoredToken(),
    loading: true,
    needsLogin: false,
  });

  useEffect(() => {
    let cancelled = false;

    async function checkAuth() {
      try {
        const res = await fetch('/api/auth/status');
        const data = await res.json();

        if (cancelled) return;

        if (!data.passwordRequired || data.authenticated) {
          setState({ token: getStoredToken(), loading: false, needsLogin: false });
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
      clearToken();
      setState({ token: null, loading: false, needsLogin: true });
    }
    document.addEventListener('ws-auth-failed', handleAuthFailed);

    return () => {
      cancelled = true;
      document.removeEventListener('ws-auth-failed', handleAuthFailed);
    };
  }, []);

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
          return { success: true };
        }
        return { success: false, error: data.error || 'Authentication failed' };
      } catch {
        return { success: false, error: 'Connection error -- is the server running?' };
      }
    },
    [],
  );

  const logout = useCallback(() => {
    clearToken();
    setState({ token: null, loading: false, needsLogin: true });
  }, []);

  return { ...state, login, logout };
}
