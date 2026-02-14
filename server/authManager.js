// authManager.js — Password authentication with scrypt hashing and token sessions
import { scryptSync, randomBytes, timingSafeEqual } from 'crypto';
import { config } from './serverConfig.js';
import log from './logger.js';

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const SCRYPT_KEYLEN = 64;

// In-memory token store: Map<token, { createdAt: number }>
const tokens = new Map();

/**
 * Hash a plaintext password with a random salt.
 * @param {string} password
 * @returns {string} "salt:hash" (both hex-encoded)
 */
export function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  return `${salt}:${hash}`;
}

/**
 * Verify a plaintext password against a stored "salt:hash" string.
 * Uses timing-safe comparison to prevent timing attacks.
 * @param {string} password
 * @param {string} stored - "salt:hash" format
 * @returns {boolean}
 */
export function verifyPassword(password, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, storedHash] = stored.split(':');
  const derived = scryptSync(password, salt, SCRYPT_KEYLEN).toString('hex');
  if (derived.length !== storedHash.length) return false;
  return timingSafeEqual(Buffer.from(derived, 'hex'), Buffer.from(storedHash, 'hex'));
}

/**
 * Create a new auth token with 24h TTL.
 * @returns {string} token
 */
export function createToken() {
  const token = randomBytes(32).toString('hex');
  tokens.set(token, { createdAt: Date.now() });
  return token;
}

/**
 * Validate a token exists and has not expired.
 * Expired tokens are removed on check.
 * @param {string} token
 * @returns {boolean}
 */
export function validateToken(token) {
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
 * @param {string} token
 */
export function removeToken(token) {
  if (token) tokens.delete(token);
}

/**
 * Check if password authentication is enabled.
 * @returns {boolean}
 */
export function isPasswordEnabled() {
  return Boolean(config.passwordHash);
}

/**
 * Parse the auth_token cookie from a raw Cookie header string.
 * @param {string} cookieHeader
 * @returns {string|null}
 */
export function parseCookieToken(cookieHeader) {
  if (!cookieHeader) return null;
  const match = cookieHeader.match(/(?:^|;\s*)auth_token=([^;]+)/);
  return match ? match[1] : null;
}

/**
 * Extract token from request: cookie, Authorization header, or query string.
 * @param {import('http').IncomingMessage} req
 * @returns {string|null}
 */
export function extractToken(req) {
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
export function authMiddleware(req, res, next) {
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
let cleanupTimer = null;

export function startTokenCleanup() {
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

export function stopTokenCleanup() {
  if (cleanupTimer) {
    clearInterval(cleanupTimer);
    cleanupTimer = null;
  }
}
