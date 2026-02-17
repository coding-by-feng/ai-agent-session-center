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
