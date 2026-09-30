import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { authFetch, getAuthToken } from './useAuth';
import { clearLocalStorage } from '../__tests__/setup';

describe('useAuth utilities', () => {
  beforeEach(() => {
    clearLocalStorage();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('getAuthToken', () => {
    it('returns null when no token stored', () => {
      expect(getAuthToken()).toBe(null);
    });

    it('returns stored token', () => {
      localStorage.setItem('auth_token', 'test-token-123');
      expect(getAuthToken()).toBe('test-token-123');
    });
  });

  describe('authFetch', () => {
    it('adds Authorization header when token exists', async () => {
      localStorage.setItem('auth_token', 'my-token');

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', mockFetch);

      await authFetch('/api/sessions');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer my-token');
    });

    it('does not add Authorization header when no token', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', mockFetch);

      await authFetch('/api/sessions');

      expect(mockFetch).toHaveBeenCalledTimes(1);
      const [, init] = mockFetch.mock.calls[0];
      // init should be undefined or have no Authorization header
      if (init?.headers) {
        const headers = new Headers(init.headers);
        expect(headers.has('Authorization')).toBe(false);
      }
    });

    it('does not override existing Authorization header', async () => {
      localStorage.setItem('auth_token', 'my-token');

      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', mockFetch);

      await authFetch('/api/sessions', {
        headers: { Authorization: 'Bearer custom-token' },
      });

      const [, init] = mockFetch.mock.calls[0];
      const headers = new Headers(init.headers);
      expect(headers.get('Authorization')).toBe('Bearer custom-token');
    });

    it('passes through other init options', async () => {
      const mockFetch = vi.fn().mockResolvedValue(new Response('ok'));
      vi.stubGlobal('fetch', mockFetch);

      await authFetch('/api/sessions', { method: 'POST', body: '{}' });

      const [url, init] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/sessions');
      expect(init.method).toBe('POST');
      expect(init.body).toBe('{}');
    });
  });
});

// ---------------------------------------------------------------------------
// Periodic re-login regression.
//
// The session lives in an HttpOnly cookie that JS cannot read, so
// `getStoredToken()` is always null. Two places required it anyway: the
// refresh was never SCHEDULED (gated on a stored token), and `doRefreshToken`
// returned early before sending the request. The token then hit its absolute
// 1-hour TTL and the next status check bounced the user to the login screen —
// the periodic password prompt.
//
// These drive the real hook through its real timer rather than calling the
// private helper, because "is a refresh scheduled at all" is the half that
// actually broke and is only observable from the outside.
// ---------------------------------------------------------------------------
describe('useAuth — silent refresh keeps a cookie-only session alive', () => {
  const REFRESH_DELAY_MS = 3600 * 1000 - 5 * 60 * 1000; // TTL minus buffer

  function mockAuthServer(refreshBody: Record<string, unknown>) {
    return vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/status')) {
        // The real shape when a password is set and the cookie is valid.
        return new Response(JSON.stringify({ passwordRequired: true, authenticated: true }));
      }
      if (String(url).includes('/api/auth/refresh')) {
        return new Response(JSON.stringify(refreshBody));
      }
      return new Response('{}');
    });
  }

  beforeEach(() => {
    clearLocalStorage();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('SCHEDULES and SENDS a refresh even with no token in localStorage', async () => {
    const { renderHook, act } = await import('@testing-library/react');
    const { useAuth } = await import('./useAuth');
    // Deliberately empty — this is the real state, since login only ever set
    // an HttpOnly cookie.
    expect(localStorage.getItem('auth_token')).toBeNull();

    const mockFetch = mockAuthServer({ success: true, expiresIn: 3600 });
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(() => useAuth());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    expect(result.current.needsLogin).toBe(false);

    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS + 1000); });

    const refreshed = mockFetch.mock.calls.some((c) => String(c[0]).includes('/api/auth/refresh'));
    expect(refreshed).toBe(true);        // was never even attempted before
    expect(result.current.needsLogin).toBe(false); // and must not bounce to login
  });

  it('accepts a refresh response that carries NO token field', async () => {
    // The server sets the rotated token as an HttpOnly cookie and responds
    // `{ success, expiresIn }`. Requiring `data.token` made every refresh
    // read as a failure.
    const { renderHook, act } = await import('@testing-library/react');
    const { useAuth } = await import('./useAuth');
    const mockFetch = mockAuthServer({ success: true, expiresIn: 3600 });
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(() => useAuth());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS + 1000); });

    expect(result.current.needsLogin).toBe(false);
  });

  it('DOES force re-login when the server genuinely rejects the refresh', async () => {
    // The failure path must still work — otherwise an expired session would
    // silently keep pretending it is authenticated.
    const { renderHook, act } = await import('@testing-library/react');
    const { useAuth } = await import('./useAuth');
    const mockFetch = vi.fn(async (url: string) => {
      if (String(url).includes('/api/auth/status')) {
        return new Response(JSON.stringify({ passwordRequired: true, authenticated: true }));
      }
      return new Response(JSON.stringify({ error: 'Token expired' }), { status: 401 });
    });
    vi.stubGlobal('fetch', mockFetch);

    const { result } = renderHook(() => useAuth());
    await act(async () => { await vi.advanceTimersByTimeAsync(0); });
    await act(async () => { await vi.advanceTimersByTimeAsync(REFRESH_DELAY_MS + 1000); });

    expect(result.current.needsLogin).toBe(true);
  });
});
