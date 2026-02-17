// authManager.ts — Password authentication with scrypt hashing and token sessions
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './serverConfig.js';
import log from './logger.js';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCRYPT_KEYLEN = 64;

// In-memory token store: Map<token, { createdAt: number }>
const tokens = new Map<string, { createdAt: number }>();

/**
 * Hash a plaintext password with a random salt.
 * @returns "salt:hash" (both hex-encoded)
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 * Uses timing-safe comparison to prevent timing attacks.
 */
export function verifyPassword(password: string, stored: string): boolean {
  if (!stored || !stored.includes(':')) return false;
  const [salt, storedHash] = stored.split(':');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  if (derived.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(storedHash, 'hex'));
}

/**
 * Create a new auth token with 24h TTL.
 */
export function createToken(): string {
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { createdAt: Date.now() });
  return token;
}

/**
 * Validate a token exists and has not expired.
 * Expired tokens are removed on check.
 */
export function validateToken(token: string | null): boolean {
  if (!token) return false;
  const entry = tokens.get(token);
  if (!entry) return false;
  if (Date.now() - entry.createdAt > TOKEN_TTL_MS) {
    tokens.delete(token);
    return false;
  }
  return true;
}

/**
 * Remove a token (logout).
 */
export function removeToken(token: string): void {
  if (token) tokens.delete(token);
}

/**
 * Check if password authentication is enabled.
 */
export function isPasswordEnabled(): boolean {
  return Boolean(config.passwordHash);
}

/**
 * Parse the auth_token cookie from a raw Cookie header string.
 */
export function parseCookieToken(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Extract token from request: cookie, Authorization header, or query string.
 */
export function extractToken(req: IncomingMessage): string | null {
  // 1. Cookie
  const cookieToken = parseCookieToken(req.headers.cookie);
  if (cookieToken) return cookieToken;
  // 2. Authorization: Bearer <token>
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith('Bearer ')) return authHeader.slice(7);
  // 3. Query string (?token=xxx) — used by WebSocket
  if (req.url && req.url.includes('token=')) {
    try {
      const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
      return url.searchParams.get('token');
    } catch { /* ignore parse errors */ }
  }
  return null;
}

/**
 * Express middleware: protect routes that require authentication.
 * Checks cookie, Authorization header, and query string.
 * Skips auth check if password is not enabled.
 */
export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  if (!isPasswordEnabled()) {
    next();
    return;
  }
  const token = extractToken(req);
  if (validateToken(token)) {
    next();
    return;
  }
  log.debug('auth', `Unauthorized request: ${req.method} ${req.originalUrl}`);
  res.status(401).json({ error: 'Unauthorized' });
}

/**
 * Periodic cleanup of expired tokens (runs every hour).
 */
let cleanupTimer: ReturnType<typeof setInterval> | null = null;

export function startTokenCleanup(): void {
  if (cleanupTimer) return;
  cleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [token, entry] of tokens) {
      if (now - entry.createdAt > TOKEN_TTL_MS) {
        tokens.delete(token);
      }
    }
  }, 60 * 60 * 1000);
}

export function stopTokenCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
