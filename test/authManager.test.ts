// test/authManager.test.ts — Tests for server/authManager.ts
import { describe, it, beforeEach, afterEach, expect, vi } from 'vitest';
import {
  hashPassword,
  verifyPassword,
  createToken,
  validateToken,
  removeToken,
  isPasswordEnabled,
  parseCookieToken,
  extractToken,
  authMiddleware,
  startTokenCleanup,
  stopTokenCleanup,
} from '../server/authManager.js';

describe('authManager', () => {
  afterEach(() => {
    stopTokenCleanup();
  });

  describe('hashPassword', () => {
    it('returns a salt:hash string', () => {
      const result = hashPassword('my-password');
      expect(result).toContain(':');
      const parts = result.split(':');
      expect(parts).toHaveLength(2);
      expect(parts[0].length).toBeGreaterThan(0); // salt
      expect(parts[1].length).toBeGreaterThan(0); // hash
    });

    it('produces different hashes for same password (random salt)', () => {
      const h1 = hashPassword('same-password');
      const h2 = hashPassword('same-password');
      expect(h1).not.toBe(h2);
    });

    it('produces hex-encoded strings', () => {
      const result = hashPassword('test');
      const [salt, hash] = result.split(':');
      expect(/^[0-9a-f]+$/.test(salt)).toBe(true);
      expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
    });
  });

  describe('verifyPassword', () => {
    it('returns true for correct password', () => {
      const stored = hashPassword('correct-password');
      expect(verifyPassword('correct-password', stored)).toBe(true);
    });

    it('returns false for incorrect password', () => {
      const stored = hashPassword('correct-password');
      expect(verifyPassword('wrong-password', stored)).toBe(false);
    });

    it('returns false for empty stored hash', () => {
      expect(verifyPassword('any', '')).toBe(false);
    });

    it('returns false for stored hash without colon', () => {
      expect(verifyPassword('any', 'nocolonhere')).toBe(false);
    });

    it('returns false for null stored hash', () => {
      expect(verifyPassword('any', null as unknown as string)).toBe(false);
    });

    it('handles empty password', () => {
      const stored = hashPassword('');
      expect(verifyPassword('', stored)).toBe(true);
      expect(verifyPassword('not-empty', stored)).toBe(false);
    });
  });

  describe('createToken / validateToken / removeToken', () => {
    it('creates a valid token', () => {
      const token = createToken();
      expect(typeof token).toBe('string');
      expect(token.length).toBe(64); // 32 bytes -> 64 hex chars
    });

    it('validates a freshly created token', () => {
      const token = createToken();
      expect(validateToken(token)).toBe(true);
    });

    it('rejects an unknown token', () => {
      expect(validateToken('unknown-token-value')).toBe(false);
    });

    it('rejects null token', () => {
      expect(validateToken(null)).toBe(false);
    });

    it('rejects empty string token', () => {
      expect(validateToken('')).toBe(false);
    });

    it('removes a token (logout)', () => {
      const token = createToken();
      expect(validateToken(token)).toBe(true);
      removeToken(token);
      expect(validateToken(token)).toBe(false);
    });

    it('removeToken handles empty string gracefully', () => {
      // Should not throw
      removeToken('');
    });

    it('creates unique tokens each time', () => {
      const t1 = createToken();
      const t2 = createToken();
      expect(t1).not.toBe(t2);
    });
  });

  describe('parseCookieToken', () => {
    it('extracts auth_token from cookie header', () => {
      const result = parseCookieToken('auth_token=abc123; other=val');
      expect(result).toBe('abc123');
    });

    it('returns null for missing cookie header', () => {
      expect(parseCookieToken(undefined)).toBe(null);
    });

    it('returns null when auth_token not present', () => {
      expect(parseCookieToken('other=val; foo=bar')).toBe(null);
    });

    it('handles auth_token as first cookie', () => {
      const result = parseCookieToken('auth_token=firstval');
      expect(result).toBe('firstval');
    });

    it('handles auth_token as last cookie', () => {
      const result = parseCookieToken('foo=bar; auth_token=lastval');
      expect(result).toBe('lastval');
    });
  });

  describe('extractToken', () => {
    it('extracts from cookie', () => {
      const req = {
        headers: { cookie: 'auth_token=from-cookie' },
        url: '/test',
      } as unknown as import('http').IncomingMessage;
      expect(extractToken(req)).toBe('from-cookie');
    });

    it('extracts from Authorization Bearer header', () => {
      const req = {
        headers: { authorization: 'Bearer from-header' },
        url: '/test',
      } as unknown as import('http').IncomingMessage;
      expect(extractToken(req)).toBe('from-header');
    });

    it('extracts from query string', () => {
      const req = {
        headers: { host: 'localhost:3333' },
        url: '/test?token=from-query',
      } as unknown as import('http').IncomingMessage;
      expect(extractToken(req)).toBe('from-query');
    });

    it('returns null when no token present', () => {
      const req = {
        headers: {},
        url: '/test',
      } as unknown as import('http').IncomingMessage;
      expect(extractToken(req)).toBe(null);
    });

    it('prefers cookie over other methods', () => {
      const req = {
        headers: {
          cookie: 'auth_token=cookie-val',
          authorization: 'Bearer header-val',
          host: 'localhost',
        },
        url: '/test?token=query-val',
      } as unknown as import('http').IncomingMessage;
      expect(extractToken(req)).toBe('cookie-val');
    });
  });

  describe('authMiddleware', () => {
    it('calls next() when password is not enabled', async () => {
      // Mock config to have no passwordHash
      const { config } = await import('../server/serverConfig.js');
      const original = config.passwordHash;
      (config as Record<string, unknown>).passwordHash = null;
      try {
        const next = vi.fn();
        const req = { headers: {} } as unknown as import('express').Request;
        const res = {
          status: vi.fn().mockReturnThis(),
          json: vi.fn(),
        } as unknown as import('express').Response;
        authMiddleware(req, res, next);
        expect(next).toHaveBeenCalled();
      } finally {
        (config as Record<string, unknown>).passwordHash = original;
      }
    });
  });

  describe('startTokenCleanup / stopTokenCleanup', () => {
    it('starts and stops without error', () => {
      startTokenCleanup();
      // Should not throw when called twice
      startTokenCleanup();
      stopTokenCleanup();
      // Should not throw when called after already stopped
      stopTokenCleanup();
    });
  });
});
