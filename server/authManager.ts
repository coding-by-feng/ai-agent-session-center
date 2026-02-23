// authManager.ts — Password authentication with scrypt hashing and token sessions
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './serverConfig.js';
import log from './logger.js';
import type { IncomingMessage } from 'http';
import type { Request, Response, NextFunction } from 'express';

const TOKEN_TTL_MS = 60 * 60 * 1000; // 1 hour
const SCRYPT_KEYLEN = 64;

// ---------------------------------------------------------------------------
// Login rate limiting: 5 attempts per 15 minutes per IP
// ---------------------------------------------------------------------------
const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_WINDOW_MS = 15 * 60 * 1000; // 15 minutes

interface LoginAttemptBucket {
  count: number;
  windowStart: number;
}

const loginAttempts = new Map<string, LoginAttemptBucket>();

/**
 * Check if a login IP is rate-limited. Returns remaining seconds if locked out, 0 otherwise.
 */
export function checkLoginRateLimit(ip: string): number {
  const now = Date.now();
  const bucket = loginAttempts.get(ip);
  if (!bucket || now - bucket.windowStart > LOGIN_WINDOW_MS) {
    return 0; // Window expired or no attempts
  }
  if (bucket.count >= LOGIN_MAX_ATTEMPTS) {
    return Math.ceil((LOGIN_WINDOW_MS - (now - bucket.windowStart)) / 1000);
  }
  return 0;
}

/**
 * Record a failed login attempt for an IP.
 */
export function recordLoginAttempt(ip: string): void {
  const now = Date.now();
  const bucket = loginAttempts.get(ip);
  if (!bucket || now - bucket.windowStart > LOGIN_WINDOW_MS) {
    loginAttempts.set(ip, { count: 1, windowStart: now });
  } else {
    bucket.count++;
  }
}

/**
 * Clear login attempts for an IP (called on successful login).
 */
export function clearLoginAttempts(ip: string): void {
  loginAttempts.delete(ip);
}

// ---------------------------------------------------------------------------
// Password complexity validation
// ---------------------------------------------------------------------------

export interface PasswordValidation {
  valid: boolean;
  errors: string[];
}

/**
 * Validate password complexity. Requirements:
 * - At least 8 characters
 * - At least 1 uppercase letter
 * - At least 1 lowercase letter
 * - At least 1 digit
 * - At least 1 special character
 */
export function validatePasswordComplexity(password: string): PasswordValidation {
  const errors: string[] = [];
  if (password.length < 8) errors.push('at least 8 characters');
  if (!/[A-Z]/.test(password)) errors.push('at least 1 uppercase letter');
  if (!/[a-z]/.test(password)) errors.push('at least 1 lowercase letter');
  if (!/[0-9]/.test(password)) errors.push('at least 1 digit');
  if (!/[^A-Za-z0-9]/.test(password)) errors.push('at least 1 special character');
  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Token store
// ---------------------------------------------------------------------------

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
 * Create a new auth token with 1h TTL.
 */
export function createToken(): string {
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { createdAt: Date.now() });
  return token;
}

/**
 * Refresh an existing valid token: revoke the old one, return a new one.
 * Returns null if the old token is invalid/expired.
 */
export function refreshToken(oldToken: string | null): string | null {
  if (!oldToken || !validateToken(oldToken)) return null;
  tokens.delete(oldToken);
  return createToken();
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
 * Get remaining TTL for a token in milliseconds. Returns 0 if invalid/expired.
 */
export function getTokenTTL(token: string | null): number {
  if (!token) return 0;
  const entry = tokens.get(token);
  if (!entry) return 0;
  const remaining = TOKEN_TTL_MS - (Date.now() - entry.createdAt);
  return remaining > 0 ? remaining : 0;
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
 * Express middleware: restrict access to localhost/loopback only.
 * Used to protect hook endpoints from external access.
 */
export function localhostOnlyMiddleware(req: Request, res: Response, next: NextFunction): void {
  const ip = req.ip || req.socket?.remoteAddress || '';
  // Allow localhost, IPv4 loopback, IPv6 loopback, and IPv4-mapped IPv6 loopback
  const isLoopback = ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1' || ip === 'localhost';
  if (isLoopback) {
    next();
    return;
  }
  log.debug('auth', `Blocked non-localhost hook request from ${ip}`);
  res.status(403).json({ error: 'Hook endpoint restricted to localhost' });
}

/**
 * Periodic cleanup of expired tokens (runs every 15 minutes for 1h tokens).
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
    // Also clean up expired login attempt buckets
    for (const [ip, bucket] of loginAttempts) {
      if (now - bucket.windowStart > LOGIN_WINDOW_MS) {
        loginAttempts.delete(ip);
      }
    }
  }, 15 * 60 * 1000); // every 15 minutes
}

export function stopTokenCleanup(): void {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}

/** Export token TTL for use in cookie Max-Age */
export const TOKEN_TTL_SECONDS = TOKEN_TTL_MS / 1000;
